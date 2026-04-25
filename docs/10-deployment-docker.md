# 10 · Deploy: Docker

← [09 · GitHub Actions](./09-deployment-github-actions.md) · [Index](./README.md) · Next → [11 · Local cron](./11-deployment-local-cron.md)

Docker is the right deployment target when:

* You're behind a corporate firewall and can't rely on github.com → your
  GHES → an internet-hosted GHA runner.
* You want to bake deps into a private registry image once, then schedule
  the same image many times.
* You're integrating shipreport into an existing K8s ops platform.

If you're on github.com or internet-reachable GHES, prefer
[09 · GitHub Actions](./09-deployment-github-actions.md) — fewer moving
parts.

## What's in the image

[`docker/Dockerfile`](../docker/Dockerfile) builds a ~150 MB image:

* `node:25-alpine` base, pinned by digest (Dependabot updates weekly).
* `pnpm install --prod` only — no devDeps in the runtime layer.
* Runs as user `shipreport` (uid `10001`), not root.
* Two declared volumes for state + cache.
* `ENTRYPOINT ["node", "bin/shipreport.js"]` — pass any subcommand as
  the docker `CMD`.

`--build-arg WITH_PDF=1` adds Chromium + puppeteer for PDF/PNG output
(~400 MB larger).

## Build

```bash
docker build -t shipreport:0.2.0 -f docker/Dockerfile .
docker build -t shipreport:0.2.0-pdf --build-arg WITH_PDF=1 -f docker/Dockerfile .
```

For multi-arch (amd64 + arm64):

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/<owner>/shipreport:0.2.0 \
  -f docker/Dockerfile . \
  --push
```

This is what `release.yml` does on tag push to `tomtom215/shipreport`.

## Run

PAT auth:

```bash
docker run --rm \
  -e SHIPREPORT_GITHUB_TOKEN \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/out:/app/out" \
  -v shipreport-state:/home/shipreport/.local/share/shipreport \
  -v shipreport-cache:/home/shipreport/.cache/shipreport \
  shipreport:0.2.0 run --config /cfg/shipreport.yaml --all
```

App auth (private key from a file):

```bash
docker run --rm \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/app.pem:/secrets/app.pem:ro" \
  -v "$PWD/out:/app/out" \
  -v shipreport-state:/home/shipreport/.local/share/shipreport \
  -v shipreport-cache:/home/shipreport/.cache/shipreport \
  shipreport:0.2.0 run --config /cfg/shipreport.yaml --all
```

…with `shipreport.yaml` containing:

```yaml
github:
  app:
    appId: 123456
    privateKeyPath: /secrets/app.pem
    installationId: 7890123
```

## Volumes

Two volumes you should mount:

| Mount path                                       | Why                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| `/home/shipreport/.local/share/shipreport`       | State DB (audit log + schedule_state). Dropping this loses chain.    |
| `/home/shipreport/.cache/shipreport`             | Extract cache. Dropping this just makes the next run slower.         |

Plus the bind mount for the config file (read-only) and the output dir.

A `:ro` mount on the config is recommended — shipreport never writes to
its config and the read-only flag stops accidental edits.

## Air-gapped / offline registries

If you can't pull `node:25-alpine` from Docker Hub:

1. Pull the upstream image to an internet-connected host:
   `docker pull node:25-alpine@sha256:<digest>`
2. Re-tag and push to your internal registry:
   `docker tag node:25-alpine@sha256:<digest> registry.internal/node:25-alpine`
   `docker push registry.internal/node:25-alpine`
3. Build with a custom Dockerfile that swaps the FROM line:
   `FROM registry.internal/node:25-alpine`

For the npm dependencies, either:

* Bake them into the image (the bundled Dockerfile already does this), or
* Mirror `registry.npmjs.org` in your registry and override
  `NPM_CONFIG_REGISTRY=https://registry.internal/repository/npm/`.

## Kubernetes CronJob

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: shipreport-tick
spec:
  schedule: "5 * * * *"
  concurrencyPolicy: Forbid       # never overlap; tick is idempotent
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: shipreport
          restartPolicy: Never
          securityContext:
            runAsUser: 10001
            runAsGroup: 10001
            fsGroup: 10001
            runAsNonRoot: true
            seccompProfile:
              type: RuntimeDefault
          containers:
            - name: shipreport
              image: ghcr.io/<owner>/shipreport:0.2.0
              args: ["schedule", "tick", "--config", "/cfg/shipreport.yaml", "--verbose"]
              env:
                - name: SHIPREPORT_GITHUB_TOKEN
                  valueFrom:
                    secretKeyRef:
                      name: shipreport-token
                      key: token
              volumeMounts:
                - { name: cfg,   mountPath: /cfg,                                   readOnly: true }
                - { name: state, mountPath: /home/shipreport/.local/share/shipreport }
                - { name: cache, mountPath: /home/shipreport/.cache/shipreport }
          volumes:
            - name: cfg
              configMap:
                name: shipreport-config
            - name: state
              persistentVolumeClaim:
                claimName: shipreport-state
            - name: cache
              persistentVolumeClaim:
                claimName: shipreport-cache
```

`concurrencyPolicy: Forbid` is important: a long-running quarterly extract
can plausibly overlap the next hourly tick if you run a busy
multi-team setup. `tick` is internally idempotent but two concurrent
runs would both try to write to the same SQLite file, which fails.

## Image signing & SBOM

Released images at `ghcr.io/tomtom215/shipreport:<version>` are:

* Multi-arch (amd64, arm64).
* Cosign-signed keyless via Sigstore (verify with
  `cosign verify --certificate-identity-regexp=…`).
* Accompanied by a CycloneDX SBOM attached to the GitHub Release.

If you build your own image, mirror this pipeline if compliance demands
it. The release workflow at [`.github/workflows/release.yml`](../.github/workflows/release.yml)
is a worked example.

## Common pitfalls

| Symptom                                                                | Root cause                                          | Fix                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `EACCES: permission denied, open '/home/shipreport/.local/...'`         | Volume isn't writable by uid 10001.                  | `chown -R 10001:10001 <hostpath>` or use a named volume.           |
| `Failed to launch the browser process` when `--pdf`                     | Image was built without `WITH_PDF=1`.                | Rebuild with the build-arg, or drop `--pdf`.                       |
| `/home/shipreport/.config/shipreport/audit-ed25519.pem`: cannot create  | Volume not mounted; container is read-only.          | Mount a writable path or pre-bake the key.                         |
| State DB is empty every run                                             | State volume isn't persistent.                       | Use a named volume or PV, not `tmpfs` / `--rm` of an unnamed one. |

Continue → [11 · Local cron](./11-deployment-local-cron.md) (or skip if
you're using K8s for scheduling).
