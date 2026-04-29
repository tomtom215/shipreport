# 02 · Quickstart (10 minutes)

← [01 · Prerequisites](./01-prerequisites.md) · [Index](./README.md) · Next → [03 · Auth: PAT](./03-auth-pat.md)

The shortest path from zero to a scheduled GitHub Actions deploy. Uses a
fine-grained PAT (the simplest auth) — you can migrate to a GitHub App
later without losing data.

If you finish this and the workflow's first run is green, you're done.

## Step 0 — Decide where to put `shipreport.yaml`

Pick one:

* **Fork shipreport** into your org and add `shipreport.yaml` at the root.
  The bundled `tick.yml` workflow will pick it up automatically.
* **Use your own repo** (e.g. `acme-eng/operations`) and add a workflow
  that calls the reusable workflow. Smaller surface, easier to audit.

This guide assumes the second pattern, since it scales better.

## Step 1 — Create a fine-grained PAT

1. <https://github.com/settings/personal-access-tokens/new>
2. **Resource owner**: your org.
3. **Repository access**: "Only select repositories" → pick the repos in
   `shipreport.yaml`'s `repos:` list. (Public repos: `Public repositories
   (read-only)` works too.)
4. **Repository permissions**:
   * `Contents` → Read-only
   * `Issues` → Read-only
   * `Metadata` → Read-only (mandatory)
   * `Pull requests` → Read-only
5. **Organization permissions**:
   * `Members` → Read-only (only needed for team-membership lookups; you
     can omit this if you always supply explicit `members:` in
     shipreport.yaml).
6. Generate, copy the token. You will not see it again.

> Why fine-grained, not classic? Classic PATs grant org-wide access and
> can't be scoped per-repo. Use the fine-grained form unless your org
> blocks them.

## Step 2 — Add the secret to your repo

In the GitHub repo where the workflow will live:

`Settings → Secrets and variables → Actions → New repository secret`

| Name              | Value          |
| ----------------- | -------------- |
| `SHIPREPORT_TOKEN` | The PAT from step 1. |

> **Naming note**: the GitHub Actions secret is `SHIPREPORT_TOKEN`; the
> environment variable shipreport itself reads is `SHIPREPORT_GITHUB_TOKEN`
> (the longer name appears throughout the docs and in `shipreport doctor`
> output). The reusable workflow's `secrets:` block does the rename for
> you when you pass `shipreport_token: ${{ secrets.SHIPREPORT_TOKEN }}`.
> If you're invoking shipreport directly (local CLI, Docker, systemd),
> export the env var with its full name: `SHIPREPORT_GITHUB_TOKEN=...`.

## Step 3 — Add `shipreport.yaml`

Create `shipreport.yaml` at the repo root. Minimum viable config:

```yaml
org: acme-eng

teams:
  - name: checkout
    manager: jdoe
    members: [asmith, blee, cwong]
    repos:
      - acme-eng/checkout-service
      - acme-eng/billing-api
    schedule: "0 14 1 1,4,7,10 *"     # 14:00 on Jan/Apr/Jul/Oct 1st

defaults:
  quarter: 2026Q1
  timezone: America/New_York

audit:
  enabled: true
```

The full annotated reference is at
[`examples/shipreport.yaml`](../examples/shipreport.yaml). Every field is
documented in [06 · Configuration reference](./06-config.md).

## Step 4 — Add the workflow

Create `.github/workflows/shipreport.yml`. The pattern below is the
recommended one: an **hourly cron** that delegates to
`shipreport schedule tick`, which reads each team's per-team `schedule:`
from `shipreport.yaml` and runs only the teams whose cron has come due.
GitHub's hosted scheduler can drop or delay any individual minute under
load — the hourly tick + per-team lookback covers that, so a delayed
trigger never costs you a quarterly run.

> **Replace the two `REPLACE_WITH_TAG_OR_SHA` placeholders below** with a
> shipreport release tag (`v0.2.0`) or a 40-hex commit SHA before
> committing. They are not real refs; GitHub will reject the workflow on
> the first run if you leave them in. Latest tags:
> <https://github.com/tomtom215/shipreport/releases>.

```yaml
name: shipreport
on:
  workflow_dispatch:
    inputs:
      mode:
        description: "run | dry-run | doctor"
        type: choice
        options: [run, dry-run, doctor]
        default: doctor
  schedule:
    - cron: "0 * * * *"   # hourly; per-team `schedule:` decides what's due

permissions:
  contents: read

jobs:
  shipreport:
    # Same value here AND in `shipreport_ref:`. See examples/github-actions/.
    uses: tomtom215/shipreport/.github/workflows/reusable-shipreport.yml@REPLACE_WITH_TAG_OR_SHA
    with:
      config: shipreport.yaml
      # Scheduled runs use `tick` (idempotent); manual dispatches use the
      # operator's chosen mode (default: doctor — safe to run with no quota cost).
      mode: ${{ github.event_name == 'schedule' && 'tick' || inputs.mode }}
      shipreport_ref: REPLACE_WITH_TAG_OR_SHA
    secrets:
      shipreport_token: ${{ secrets.SHIPREPORT_TOKEN }}
```

This is the same pattern as
[`examples/github-actions/hourly-tick.yml`](../examples/github-actions/hourly-tick.yml),
extended to also accept a manual `run`/`dry-run`/`doctor` dispatch.
Variants for App auth, GHES, image-pinned, and PR-time validation:

* [`quarterly-pat.yml`](../examples/github-actions/quarterly-pat.yml) — quarterly cron + PAT (use only when you accept that a delayed cron skips an entire quarter; prefer the hourly-tick pattern above).
* [`quarterly-app.yml`](../examples/github-actions/quarterly-app.yml) — same shape, App auth.
* [`hourly-tick.yml`](../examples/github-actions/hourly-tick.yml) — hourly tick, recommended for multi-team setups with mixed cadences.
* [`ghes-self-hosted.yml`](../examples/github-actions/ghes-self-hosted.yml) — GHES on a self-hosted runner.
* [`quarterly-image.yml`](../examples/github-actions/quarterly-image.yml) — runs a cosign-verified, digest-pinned shipreport image (SLSA-grade supply chain).
* [`dry-run-on-pr.yml`](../examples/github-actions/dry-run-on-pr.yml) — secretless PR-time validator.

## Step 5 — Smoke-test with `doctor` mode

Don't burn quota with a real run yet. Smoke-test:

1. `Actions → shipreport → Run workflow`
2. **mode**: `doctor` (it's the dispatch default)
3. Click **Run workflow**.

Expected output in the job log:

```text
Auth kind:        pat
Identity:         pat:env:SHIPREPORT_GITHUB_TOKEN
Authenticated as: <your-username>
Token scopes:     (fine-grained PAT or App installation)
GHES version:     github.com
Base URL:         https://api.github.com
Cache path:       /home/runner/.cache/shipreport/cache.sqlite
Audit enabled:    true
State path:       /home/runner/.local/share/shipreport/state.sqlite
Teams:            checkout
Scheduled teams:
  checkout: 0 14 1 1,4,7,10 *
```

> **About `Token scopes:`**: shipreport prints whatever GitHub returns
> in the `x-oauth-scopes` REST header. **Classic PATs** return a comma-
> separated list (`repo, read:org`). **Fine-grained PATs and App
> installation tokens** don't populate that header, so shipreport falls
> back to the parenthetical literal `(fine-grained PAT or App
> installation)`. Either form is healthy — see `src/github.ts:probeToken`
> for the exact code path.

If it fails, jump to [13 · Troubleshooting](./13-troubleshooting.md).

## Step 6 — Dispatch a real run

1. Same workflow, **mode: run**.
2. Wait ~30s.
3. Download the `shipreport-<run_id>` artifact.

You should see:

```text
asmith-2026Q1.md
asmith-2026Q1.html
blee-2026Q1.md
blee-2026Q1.html
cwong-2026Q1.md
cwong-2026Q1.html
team-summary-checkout-2026Q1.md
team-summary-checkout-2026Q1.html
manager-rollup-checkout-2026Q1.md
manager-rollup-checkout-2026Q1.html
```

Open the manager-rollup `.md` first — that's the calibration pre-read.

## Step 7 — Let the schedule fire

The workflow's `schedule:` cron is hourly and dispatches `tick`. Each
hour, `tick` reads each team's `schedule:` from `shipreport.yaml`,
checks the recorded `last_run_at` in the cached state DB, and runs only
the teams that have a matching cron minute since their last successful
run. Most hours that's a no-op — by design.

GitHub's hosted scheduler can drop or delay any individual cron trigger
during high load; the per-team scan window covers up to 365 days, so a
missed hour is picked up at the next tick. `tick` is idempotent: if the
same minute matches twice (manual + scheduled), only one run fires.

You're done.

## What to read next

* [03 · Auth: PAT](./03-auth-pat.md) — depths of fine-grained scope, rotation, expiry.
* [07 · Scheduling](./07-scheduling.md) — multi-team cadences, idempotency.
* [09 · Deploy: GitHub Actions](./09-deployment-github-actions.md) — every supported pattern in one place.
* [12 · Audit log](./12-audit-log.md) — verifying compliance evidence.
