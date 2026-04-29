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

* `node:24-alpine` base, pinned by digest (Dependabot updates weekly).
* `pnpm install --prod` only — no devDeps in the runtime layer.
* Runs as user `shipreport` (uid `10001`), not root.
* Two declared volumes for state + cache.
* `ENTRYPOINT ["node", "bin/shipreport.js"]` — pass any subcommand as
  the docker `CMD`.

`--build-arg WITH_PDF=1` adds Chromium + puppeteer for PDF/PNG output.
The exact delta depends on the Chromium version pulled by Alpine apk; on
the current `node:24-alpine` base it adds approximately 250-300 MB
(`chromium`, `nss`, `freetype`, `harfbuzz`, `ttf-freefont`,
`ca-certificates` plus the puppeteer JS package). The original ~150 MB
image therefore grows to ~400-450 MB.

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

This is what `release.yml` does on tag push to `YOUR-GITHUB-OWNER/YOUR-FORK`.

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

## Air-gapped / offline registries — concrete recipe

Air-gapped means: the container host (and the build host, if separate)
have **no public Internet egress**. They can only reach an internal
registry, an internal npm mirror, and your GHES instance. Below is the
end-to-end recipe.

### Step 1 — On a transit host (one-time)

A transit host is anywhere with both public Internet AND access to your
internal registry. You'll mirror three things:

```bash
# 1. The pinned base image. Resolve the digest first to avoid
#    silently re-mirroring whatever `node:24-alpine` happens to point at.
DIGEST="sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f"
docker pull "node:24-alpine@$DIGEST"
docker tag  "node:24-alpine@$DIGEST" registry.internal/node:24-alpine
docker push registry.internal/node:24-alpine

# 2. (Optional) the published shipreport image, if you'd rather use it
#    than build from source.
SHIPREPORT_DIGEST="sha256:<resolve via crane digest ghcr.io/YOUR-GITHUB-OWNER/YOUR-FORK:v0.2.0>"
docker pull "ghcr.io/YOUR-GITHUB-OWNER/YOUR-FORK:v0.2.0@$SHIPREPORT_DIGEST"
docker tag  "ghcr.io/YOUR-GITHUB-OWNER/YOUR-FORK:v0.2.0@$SHIPREPORT_DIGEST" \
            registry.internal/shipreport:v0.2.0
docker push registry.internal/shipreport:v0.2.0

# 3. The npm packages. Two patterns work — pick one.
#
#    Pattern (a): use Verdaccio/Sonatype Nexus/JFrog Artifactory as a
#    proxying npm registry. Configure it to proxy registry.npmjs.org
#    (the transit host fetches once; subsequent installs come from the
#    cache). On the build host, set:
#       NPM_CONFIG_REGISTRY=https://registry.internal/repository/npm/
#
#    Pattern (b): bake deps into a base image so the build host needs
#    NO npm registry at all. On the transit host:
#       cd shipreport-source/
#       pnpm install --frozen-lockfile --prod
#       tar -czf shipreport-deps.tgz node_modules/ pnpm-lock.yaml
#    Then ship the tarball to the build host (USB / one-way diode /
#    your standard data-import path).
```

### Step 2 — On the air-gapped build host

Patch the Dockerfile's base reference and (if using pattern b) skip
`pnpm install`:

```dockerfile
# Override via build-arg so the upstream Dockerfile is unchanged.
# docker build --build-arg NODE_BASE=registry.internal/node:24-alpine ...
ARG NODE_BASE=registry.internal/node:24-alpine
FROM ${NODE_BASE} AS build
# ... rest of the upstream Dockerfile ...
```

Then build:

```bash
# Pattern (a): proxying npm registry
docker build \
  --build-arg NODE_BASE=registry.internal/node:24-alpine \
  --build-arg NPM_CONFIG_REGISTRY=https://registry.internal/repository/npm/ \
  -t registry.internal/shipreport:custom \
  -f docker/Dockerfile .

# Pattern (b): pre-baked node_modules
mkdir -p deps && tar -xzf shipreport-deps.tgz -C deps
docker build \
  --build-arg NODE_BASE=registry.internal/node:24-alpine \
  -t registry.internal/shipreport:custom \
  -f docker/Dockerfile.airgap .
```

Where `Dockerfile.airgap` is the bundled Dockerfile with the
`pnpm install` line replaced by `COPY deps/node_modules /app/node_modules`
to use the pre-staged dependency tree.

### Step 3 — On the run host

Same as the public-Internet recipe earlier on this page, but pull from
the internal registry:

```bash
docker pull registry.internal/shipreport:custom
docker run --rm \
  -e SHIPREPORT_GITHUB_TOKEN \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/out:/app/out" \
  -v shipreport-state:/home/shipreport/.local/share/shipreport \
  -v shipreport-cache:/home/shipreport/.cache/shipreport \
  registry.internal/shipreport:custom run --config /cfg/shipreport.yaml --all
```

GHES is reachable from the run host; `github.baseUrl` and `graphqlUrl`
point at it (see [05 · Auth: GHES](./05-auth-ghes.md)). Audit log export
runs from a `shipreport audit export` cron job — see
[11 · Local cron](./11-deployment-local-cron.md). The signed snapshots
go into your existing WORM target via your standard pipeline; no
GitHub-Actions involvement.

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

Released images at `ghcr.io/YOUR-GITHUB-OWNER/YOUR-FORK:<version>` are:

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
