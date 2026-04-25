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

* **PAT**: GHES versions ≥3.10 support fine-grained PATs — use them.
  Older GHES versions only have classic PATs (no per-repo scoping); in
  that case, classic with `repo` scope is your only option.
* **App**: GitHub Apps work identically on GHES. Create the App in
  `https://ghe.example.com/organizations/<org>/settings/apps/new`.

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
to avoid CWE-295). Two recommended approaches:

* **Trust the CA at the OS level**: install your CA cert into the runner
  / container's trust store. On Debian-based images:
  `cp my-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates`.
* **Use `NODE_EXTRA_CA_CERTS`**: set the env var to a PEM file path. Node
  reads this and adds those certs to the verifier without modifying the
  trust store.

Document this in your workflow as a setup step — shipreport itself never
disables verification.

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
Token scopes:     repo (or fine-grained list)
GHES version:     3.13.0
Base URL:         https://ghe.example.com/api/v3
```

A non-empty `GHES version` confirms the URLs are right.

## Common pitfalls

| Symptom                                                              | Root cause                                          | Fix                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `request to https://api.github.com/… failed`                         | `baseUrl` / `graphqlUrl` not set; default is github.com. | Set both URLs to your GHES host.                          |
| `unable to verify the first certificate`                             | Custom CA not trusted.                              | `NODE_EXTRA_CA_CERTS` or update the OS trust store.          |
| `404 Not Found` on `/orgs/<org>/installation`                        | App not installed on the GHES org.                  | Install via App settings UI on GHES.                         |
| `403 must accept the Terms of Service for github.com`                | `baseUrl` is wrong — talking to github.com, not GHES. | Re-check the URL; trailing slashes matter.                |

Continue → [06 · Configuration reference](./06-config.md).
