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

Create `.github/workflows/quarterly.yml`:

```yaml
name: shipreport-quarterly
on:
  workflow_dispatch:
    inputs:
      mode:
        description: "run | dry-run | doctor"
        default: "run"
  schedule:
    - cron: "0 14 1 1,4,7,10 *"

permissions:
  contents: read

jobs:
  shipreport:
    uses: tomtom215/shipreport/.github/workflows/reusable-shipreport.yml@main
    with:
      config: shipreport.yaml
      mode: ${{ inputs.mode || 'run' }}
    secrets:
      shipreport_token: ${{ secrets.SHIPREPORT_TOKEN }}
```

This is `examples/github-actions/quarterly-pat.yml` verbatim. There are
[App](../examples/github-actions/quarterly-app.yml),
[hourly tick](../examples/github-actions/hourly-tick.yml), and
[GHES](../examples/github-actions/ghes-self-hosted.yml) variants in the
same folder.

## Step 5 — Smoke-test with `doctor` mode

Don't burn quota with a real run yet. Smoke-test:

1. `Actions → shipreport-quarterly → Run workflow`
2. **mode**: `doctor`
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
Teams:            checkout
Scheduled teams:
  checkout: 0 14 1 1,4,7,10 *
```

If it fails, jump to [13 · Troubleshooting](./13-troubleshooting.md).

## Step 6 — Dispatch a real run

1. Same workflow, **mode: run** (or leave blank — `run` is the default).
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

The workflow's `schedule:` cron runs in GitHub's hosted scheduler. Note
that GitHub may delay scheduled runs by a few minutes during high load —
that's intentional and harmless: the per-team `schedule:` field decides
what's "due", and `tick` is idempotent.

You're done.

## What to read next

* [03 · Auth: PAT](./03-auth-pat.md) — depths of fine-grained scope, rotation, expiry.
* [07 · Scheduling](./07-scheduling.md) — multi-team cadences, idempotency.
* [09 · Deploy: GitHub Actions](./09-deployment-github-actions.md) — every supported pattern in one place.
* [12 · Audit log](./12-audit-log.md) — verifying compliance evidence.
