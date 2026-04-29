# 05 · Auth: GitHub Enterprise Server

← [04 · Auth: GitHub App](./04-auth-github-app.md) · [Index](./README.md) · Next → [06 · Config reference](./06-config.md)

shipreport works against GitHub Enterprise Server (GHES) the same way it
works against github.com — same CLI, same config, same workflows — with
two extra knobs:

1. `github.baseUrl` and `github.graphqlUrl` point at your GHES install.
2. The runner needs network access to that GHES host.

This page is only relevant if you have GHES. If you're on github.com,
skip it.

## URL layout

| GHES path                         | Used for                                |
| --------------------------------- | --------------------------------------- |
| `https://ghe.example.com/api/v3`  | REST API (and `tokenEnv` validation).   |
| `https://ghe.example.com/api/graphql` | GraphQL extract.                    |

Configure both:

```yaml
github:
  baseUrl: https://ghe.example.com/api/v3
  graphqlUrl: https://ghe.example.com/api/graphql
  tokenEnv: SHIPREPORT_GITHUB_TOKEN
  # OR for App auth:
  # app:
  #   appId: 42
  #   privateKeyEnv: SHIPREPORT_APP_PRIVATE_KEY
```

## Auth choice on GHES

Either PAT or App; the same trade-offs as github.com (see
[03](./03-auth-pat.md) / [04](./04-auth-github-app.md)). A few GHES-specific
notes:

* **PAT**: GHES 3.10 introduced fine-grained PATs (still in beta as of
  3.16; opt-in at the enterprise / organization level — see [GHES docs][ghes-fgpat]).
  Use them when available. Older GHES versions only have classic PATs
  (no per-repo scoping); in that case, classic with `repo` scope is your
  only option, scoped tightly via repo-policy where supported.
* **App**: GitHub Apps work identically on GHES. Create the App in
  `https://ghe.example.com/organizations/<org>/settings/apps/new`.

[ghes-fgpat]: https://docs.github.com/en/enterprise-server@3.10/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens

## Runner placement

If your GHES is internet-reachable, `ubuntu-latest` GHA runners work
fine — no special configuration needed.

If GHES is firewalled to your VPC, you have three options:

| Pattern                                                              | When to use                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Self-hosted GHA runner inside your VPC                               | You already run GHA actions-runner-controller (ARC) or self-hosted runners. |
| Air-gapped Docker image, scheduled by Kubernetes CronJob             | You run K8s and don't want a GHA runner.                   |
| Air-gapped Docker image, scheduled by systemd timer                  | You don't run K8s; the operations host has cron access.    |

For self-hosted runners, the example workflow is at
[`examples/github-actions/ghes-self-hosted.yml`](../examples/github-actions/ghes-self-hosted.yml).

For Docker / K8s patterns, see [10](./10-deployment-docker.md) and
[11](./11-deployment-local-cron.md).

## Air-gapped GHES

If outbound internet is fully blocked:

1. Build the Docker image inside your VPC (have access to a mirror of
   `registry.npmjs.org` or pre-fetch the lockfile). See
   [10 · Deploy: Docker](./10-deployment-docker.md).
2. Push the image to your internal registry.
3. Schedule it via Kubernetes CronJob or systemd timer
   ([11 · Deploy: Local cron](./11-deployment-local-cron.md)).
4. The audit-export workflow ([`audit-export.yml`](../.github/workflows/audit-export.yml))
   doesn't apply — instead, run
   `shipreport audit export --since <ISO> > audit.jsonl` from cron and
   ship the JSONL to your WORM store of choice.

## TLS

GHES is sometimes deployed with a self-signed CA. shipreport uses the
runtime's TLS verification — there's no flag to disable it (intentionally,
to avoid CWE-295). Two recommended approaches.

### Option A — `NODE_EXTRA_CA_CERTS` (simplest, GH Actions friendly)

Store the CA in a GH Actions secret (`GHES_CA_CERT`, the literal PEM
including `-----BEGIN/END CERTIFICATE-----` lines), then add this step
BEFORE the shipreport step in your caller workflow:

```yaml
      - name: Stage GHES CA
        env:
          GHES_CA_CERT: ${{ secrets.GHES_CA_CERT }}
        # printenv emits the secret bytes verbatim — see
        # `audit-export.yml` for the rationale (printf '%s' would mangle
        # any '%' in the PEM).
        run: |
          set -euo pipefail
          umask 0077
          mkdir -p "$RUNNER_TEMP/ghes-ca"
          printenv GHES_CA_CERT > "$RUNNER_TEMP/ghes-ca/ca.pem"
          # Make subsequent steps in the job pick it up via env-var
          # propagation. NODE_EXTRA_CA_CERTS is read by Node at startup;
          # setting it here means EVERY following Node invocation in
          # the job (including shipreport's) trusts the CA.
          echo "NODE_EXTRA_CA_CERTS=$RUNNER_TEMP/ghes-ca/ca.pem" >> "$GITHUB_ENV"
```

shipreport itself reads `NODE_EXTRA_CA_CERTS` because it just runs as a
Node process. No further configuration is needed.

### Option B — OS trust store (for Docker / self-hosted runners)

If you control the runner image:

```dockerfile
COPY ghes-ca.crt /usr/local/share/ca-certificates/ghes-ca.crt
RUN update-ca-certificates
```

(Adjust paths for Alpine / RHEL — Alpine uses `/usr/local/share/
ca-certificates/` plus `update-ca-certificates`; RHEL/Fedora uses
`/etc/pki/ca-trust/source/anchors/` plus `update-ca-trust extract`.)

shipreport never disables verification.

## Verify

```bash
SHIPREPORT_GITHUB_TOKEN=ghp_... \
  shipreport doctor --config shipreport.yaml
```

Expected output:

```text
Auth kind:        pat
Identity:         pat:env:SHIPREPORT_GITHUB_TOKEN
Authenticated as: <your-username>
Token scopes:     repo
GHES version:     3.13.0
Base URL:         https://ghe.example.com/api/v3
```

A non-empty `GHES version` confirms the URLs are right.

The `Token scopes:` line shows whatever GitHub Enterprise returned in
the `x-oauth-scopes` REST header. Classic PATs (still the only form
some older GHES versions support — see "Auth choice on GHES" above)
return a comma-separated scope list like `repo, read:org`. Fine-grained
PATs and App installation tokens don't populate that header, so
shipreport falls back to the literal `(fine-grained PAT or App
installation)`. See [02 · Quickstart](./02-quickstart.md#step-5--smoke-test-with-doctor-mode)
for the canonical explanation.

## Common pitfalls

| Symptom                                                              | Root cause                                          | Fix                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `request to https://api.github.com/… failed`                         | `baseUrl` / `graphqlUrl` not set; default is github.com. | Set both URLs to your GHES host.                          |
| `unable to verify the first certificate`                             | Custom CA not trusted.                              | `NODE_EXTRA_CA_CERTS` or update the OS trust store.          |
| `404 Not Found` on `/orgs/<org>/installation`                        | App not installed on the GHES org.                  | Install via App settings UI on GHES.                         |
| `403 must accept the Terms of Service for github.com`                | `baseUrl` is wrong — talking to github.com, not GHES. | Re-check the URL; trailing slashes matter.                |

Continue → [06 · Configuration reference](./06-config.md).
