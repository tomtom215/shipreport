# 09 · Deploy: GitHub Actions (recommended)

← [08 · Dry-run](./08-dry-run.md) · [Index](./README.md) · Next → [10 · Docker](./10-deployment-docker.md)

This is the primary supported deployment for shipreport. Every other
deployment mode is a wrapper around the same `node bin/shipreport.js …`
calls; GH Actions has the most batteries-included path because the
secrets, scheduling, OIDC, and audit-artifact retention are already there.

## At-a-glance pattern matrix

| Pattern                                                | When to use                                                | Workflow file                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Hourly tick (recommended; delay-resistant)              | Default for any new deploy. Reads each team's `schedule:`. | [`examples/github-actions/hourly-tick.yml`](../examples/github-actions/hourly-tick.yml) |
| Quarterly run, PAT auth                                 | Single team, github.com; accept skipped-quarter risk on GH delay. | [`examples/github-actions/quarterly-pat.yml`](../examples/github-actions/quarterly-pat.yml) |
| Quarterly run, App auth                                 | Same shape, App auth.                                       | [`examples/github-actions/quarterly-app.yml`](../examples/github-actions/quarterly-app.yml) |
| GHES + self-hosted runner                               | GHES isn't internet-reachable                               | [`examples/github-actions/ghes-self-hosted.yml`](../examples/github-actions/ghes-self-hosted.yml) |
| Cosign-verified, digest-pinned image                    | SLSA-grade supply chain; compliance forbids npm at run time. | [`examples/github-actions/quarterly-image.yml`](../examples/github-actions/quarterly-image.yml) |
| PR-time validation (no secrets)                          | Every operator should enable this                            | [`examples/github-actions/dry-run-on-pr.yml`](../examples/github-actions/dry-run-on-pr.yml) |
| Audit JSONL export                                      | SOC2 evidence pipeline                                       | [`.github/workflows/audit-export.yml`](../.github/workflows/audit-export.yml)            |
| Reusable workflow (called from multiple repos)           | Multi-org operators                                          | [`.github/workflows/reusable-shipreport.yml`](../.github/workflows/reusable-shipreport.yml) |
| Built-in tick template (operator forks the repo)        | Easiest first deploy if you don't mind a fork                | [`.github/workflows/tick.yml`](../.github/workflows/tick.yml)                            |

The reusable workflow is the **recommended pattern**. Each example caller
delegates to `tomtom215/shipreport/.github/workflows/reusable-shipreport.yml`
at a pinned ref (release tag or 40-hex commit SHA — see the example files
for the exact form, and the "Pinning vs floating" section below).

## Anatomy of the reusable workflow

[`.github/workflows/reusable-shipreport.yml`](../.github/workflows/reusable-shipreport.yml)
is a `workflow_call`-style workflow with these inputs:

| Input             | Default            | Purpose                                                          |
| ----------------- | ------------------ | ---------------------------------------------------------------- |
| `config`          | `shipreport.yaml`  | Path to the config in the caller's repo.                         |
| `mode`            | `run`              | `run` / `dry-run` / `doctor` / `tick`.                           |
| `team`            | `""` (`--all`)     | Team name; empty = all teams.                                    |
| `quarter`         | `""`               | Override quarter, e.g. `2026Q2`.                                 |
| `shipreport_ref`  | **(required, no default)** | Branch / tag / SHA to check shipreport's source out at. Forces every caller to make an explicit pinning decision. |
| `runs_on`         | `ubuntu-latest`    | Runner label (override for self-hosted).                         |

And these secrets:

| Secret                         | Required when                              |
| ------------------------------ | ------------------------------------------ |
| `shipreport_token`             | PAT auth.                                  |
| `shipreport_app_private_key`   | App auth.                                  |
| `shipreport_audit_key`         | Optional, only needed by `audit snapshot`. |

What the workflow does, in order:

1. Checks out the caller's repo (for `shipreport.yaml`).
2. Checks out `tomtom215/shipreport` at `shipreport_ref`.
3. `pnpm install --frozen-lockfile && pnpm build` on shipreport.
4. Restores the cached state DB (per-caller-repo, per-branch keys).
5. Runs `shipreport doctor` as a preflight (cheap; fails fast on auth issues).
6. Dispatches the requested mode.
7. Uploads `out/` as an artifact (90 d retention).

## Pinning vs floating

Every checked-in example uses a `REPLACE_WITH_TAG_OR_SHA` placeholder
that an operator MUST replace before committing. The placeholder is
deliberately not a real ref — GitHub rejects the workflow on the first
run if you forget to substitute, which is the safe failure mode.

For real deployments, **pin to a tag** (or a 40-hex SHA):

```yaml
uses: tomtom215/shipreport/.github/workflows/reusable-shipreport.yml@v0.2.0
with:
  shipreport_ref: v0.2.0   # same value as the @ above
```

`@main` is accepted by the reusable workflow but the workflow logs a
warning when it sees a floating ref (`main` / `master` / `latest` /
`HEAD`) — see `reusable-shipreport.yml` lines 119-126. Do not ship a
floating ref to production. Dependabot's `dependabot.yml` (already
configured) bumps GitHub Actions pins on a weekly cadence; the same
schedule should propagate to your `shipreport_ref` pin via your normal
review process.

## Caching state between runs

The state SQLite (`audit_log` + `schedule_state`) and the extract cache
both live under `~/.local/share/shipreport` and `~/.cache/shipreport`.
The reusable workflow caches both with `actions/cache@v5`:

```yaml
key: shipreport-state-${{ github.repository }}-${{ github.ref_name }}-${{ github.run_id }}
restore-keys: |
  shipreport-state-${{ github.repository }}-${{ github.ref_name }}-
```

Why this scheme:

* `${{ github.run_id }}` in the **save** key forces a new cache entry
  per run (so we always save fresh state).
* `restore-keys` falls back to the most recent same-branch save, so a
  new run starts from the latest known state.
* Branch-scoped so a fork's experiments don't pollute the upstream
  cache.

## Permissions / OIDC

The reusable workflow runs with `permissions: contents: read`. That's the
minimum and the maximum — shipreport never writes to your repo, never
pushes, never opens issues.

OIDC (`id-token: write`) is **not** required for shipreport itself. It's
only used by the `release.yml` pipeline (npm `--provenance`, cosign
keyless image signing) — those are upstream concerns, not operator
concerns.

## Artifacts

Each run uploads an artifact named `shipreport-<run_id>` containing the
full `out/` directory. Default retention 90 days; override via
`actions/upload-artifact` if your compliance team needs longer.

The `tick.yml` workflow additionally uploads the SQLite state DB as
`shipreport-audit-<run_id>` (365 d retention) so a forensic team can
re-verify the chain offline. The reusable workflow doesn't do this by
default — copy the relevant step from `tick.yml` if you need it.

## Failure handling

* **doctor fails**: workflow stops. No extract burn. Fix the auth /
  config and re-run.
* **tick fails for one team**: that team's `last_status = "failed"`;
  other teams keep going. The job exits non-zero so you get a red
  status.
* **All teams fail**: usually a token / network issue; check the audit
  tail in the artifact.
* **Out-of-quota** (`rateLimit.remaining` near 0): the rate-limit guard
  has already degraded to serial; the run will be slow but eventually
  finish, with a `rate_limit_degraded` audit row recording the moment.

## Failure notifications

shipreport doesn't ship a notifier. Wire GH Actions:

```yaml
- name: Notify Slack on failure
  if: failure()
  uses: slackapi/slack-github-action@v2
  with:
    payload: |
      { "text": "shipreport ${{ github.workflow }} failed: ${{ github.event_name }}" }
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Add this to your caller workflow, not the reusable one — it depends on
secrets you control.

## Migrating between auth methods

PAT → App: change the secret name passed to the reusable workflow from
`shipreport_token` to `shipreport_app_private_key`, and add a `github.app`
block to `shipreport.yaml`. No data loss; the audit log just starts
recording `app:…` instead of `pat:env:…` in the `actor` field.

## Running multiple environments (prod / staging)

Two patterns:

* **Two repos**: `acme-eng/operations-prod` and `acme-eng/operations-staging`,
  each with its own `shipreport.yaml` and secrets.
* **One repo, two workflows**: `quarterly-prod.yml` reads
  `shipreport-prod.yaml` and `secrets.SHIPREPORT_TOKEN_PROD`; the
  staging one reads the staging config and secret.

Pattern 1 is simpler and the recommended path. Pattern 2 is OK when the
two environments share the audit log.

## Examples folder

Every workflow in this matrix has a copy-paste-ready file at
[`examples/github-actions/`](../examples/github-actions/). They're checked
in, linted by `actionlint`, and tested against the schema.

Continue → [10 · Docker](./10-deployment-docker.md) (only relevant for
non-GHA setups).
