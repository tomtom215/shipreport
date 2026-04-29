# 13 · Troubleshooting

← [12 · Audit log](./12-audit-log.md) · [Index](./README.md) · Next → [14 · Security model](./14-security.md)

Every error message shipreport can plausibly emit, what causes it, and
how to fix it. Search this page with Ctrl-F when something breaks.

## Diagnosis flowchart

```text
Did `shipreport doctor` succeed?
├── No  → "Doctor errors" (this page)
└── Yes → Did the workflow fail at extract?
          ├── Yes → "Extract errors"
          └── No  → Did the report look wrong?
                    ├── Yes → "Render / classification issues"
                    └── No  → Audit log issues — see 12 · Audit log
```

## Doctor errors

### `GitHub token not set. Either configure github.app or export <var>.`

* **Cause**: env var holding the PAT is unset.
* **Fix (local)**: `export SHIPREPORT_GITHUB_TOKEN=ghp_…`
* **Fix (GHA)**: set the secret and pass it through —
  `env: { SHIPREPORT_GITHUB_TOKEN: ${{ secrets.SHIPREPORT_TOKEN }} }`.

### `GitHub App private key env var <VAR> is empty.`

* **Cause**: `github.app.privateKeyEnv: <VAR>` references an env var
  that's empty or unset.
* **Fix**: ensure the secret is non-empty. The PEM should start with
  `-----BEGIN PRIVATE KEY-----` (or `RSA PRIVATE KEY` for older Apps).

### `GitHub App config needs either privateKeyEnv or privateKeyPath.`

* **Cause**: `github.app:` is set but neither key reference is.
* **Fix**: pick one. `privateKeyEnv` for GHA secrets;
  `privateKeyPath` for files on disk.

### `Failed to discover GitHub App installation for org <org>: 404 Not Found`

* **Cause**: App exists but isn't installed on the org named in
  `org:`.
* **Fix**: visit the App's settings page → **Install App** → install on
  the org. Or set `installationId:` explicitly.

### `Failed to discover GitHub App installation for org <org>: 401 Unauthorized`

* **Cause**: App private key is wrong / expired / mismatched with App ID.
* **Fix**: confirm `appId` matches the App that issued the private key.
  Generate a fresh key and try again.

### `error:0909006C:PEM routines:get_name:no start line`

* **Cause**: PEM is missing the `-----BEGIN PRIVATE KEY-----` header
  line. Common when pasting into a secret manager that stripped the
  first line.
* **Fix**: re-paste; ensure the entire `-----BEGIN…-----END…-----`
  block is intact.

## Schema errors (`Invalid shipreport config`)

The Zod-issued errors are precise. Selected examples:

| Error                                                              | Cause                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `org: Required`                                                    | Top-level `org:` is missing.                                          |
| `teams: Array must contain at least 1 element(s)`                  | Empty `teams:` list.                                                  |
| `teams.0.repos.0: Invalid input: must match pattern …`             | A repo isn't `owner/repo` shape.                                      |
| `defaults.timezone: Required`                                      | Both team `quarter:` and `defaults.quarter:` missing.                 |
| `quarter date range: \`from\` must be on or before \`to\``         | An explicit `{ from, to }` range with `from` strictly after `to`. Reverse the bounds. |

Run `node scripts/validate-config.mjs shipreport.yaml` for the full set
without spending API quota.

## Cron errors

### `Cron expression must have 5 fields, got <n>: "<expr>"`

* **Cause**: 6-field "with-seconds" form, or a field merged with no
  whitespace.
* **Fix**: use 5 fields: `minute hour dom month dow`.

### `Bad value in "<expr>" field <name>: <piece>`

* **Cause**: a non-integer piece (e.g. named day `MON`).
* **Fix**: use 0–6 for day-of-week (Sunday=0).

### `Out of range in "<expr>" field <name>: <piece> (allowed lo-hi)`

* **Cause**: e.g. `60` in the minute field, or `13` in month.
* **Fix**: stay within the documented field ranges.

## Extract errors

### `--dry-run set but no cached snapshot for <repo> @ <quarter>`

* **Cause**: `--dryRun` was passed but the cache has no entry for that
  repo × quarter.
* **Fix**: run once without `--dryRun` to warm the cache.

### `<repo>: failed (<msg>) — skipping`

This is a partial-failure log. The run continues and `<repo>` is
recorded as a `dataGap` in the rendered report. Common `<msg>`
contents:

| `<msg>`                                                      | Root cause                                          |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `403 Resource not accessible by personal access token`        | PAT can't read this repo.                           |
| `404 Not Found`                                              | Repo doesn't exist or is private + unreadable.      |
| `401 Bad credentials`                                        | PAT/App auth failed mid-run.                        |
| `Network connection lost.`                                    | Transient — retry usually succeeds.                 |

### `dropped <N> merged PR(s) whose base was not the default branch`

Not an error. Merged PRs targeting non-default branches (e.g. backport
PRs to `release/*`) are excluded by design. The number is logged for
audit transparency.

## Render / classification issues

### "All my PRs are classified as `other`"

* **Cause**: your repo doesn't use the labels in
  `defaults.classification.*Labels`.
* **Fix**: edit `classification:` to match your actual labels (e.g.
  `bug-fix` instead of `bug`). Conventional-commit titles (`fix:`,
  `feat:`) are used as a tiebreaker.

### "Co-authored PRs are credited to one person"

* **Cause**: `Co-authored-by:` trailers exist but the email isn't a
  GitHub `noreply` form. Plain emails fall back to the merge author.
* **Fix**: encourage co-authors to use the `<id>+<login>@users.noreply.github.com`
  form. (GitHub's own UI generates this.)

### "Numbers don't match the PR I see in GitHub"

Reverts subtract the original PR's credit. Check the audit-tail for
`revertsAuthored` and `revertsReceived` in `run_completed.payload`.

If a revert merged in a different quarter than the original, the
original's credit is unchanged in its own quarter; the revert is
attributed (and shows in `revertsAuthored`) in the quarter it merged.

## Audit log issues

### `audit.enabled: false`

shipreport refuses to run `tick`, `audit`, or `cache prune` if
`audit.enabled: false`. The state DB is the substrate for both the
schedule and the chain.

* **Fix**: set `audit.enabled: true`.

### `BROKEN at seq <N>: row hash mismatch` / `prev_hash mismatch`

The chain has been tampered with. See [12 · Audit log](./12-audit-log.md#when-the-chain-breaks)
for the runbook. Don't write to the DB until you've copied the file.

### `audit_log is append-only (UPDATE rejected)` / `(DELETE rejected)`

Working as intended. Some external tool (or a clever operator) tried to
modify a row directly via SQL; the storage-layer triggers blocked it.

## Resource issues

### Run is slow / `rate_limit_degraded` in audit log

The rate-limit guard switched the extract from concurrent to serial.
Causes:

* Big org × deep history → quota burn.
* Multiple shipreport instances on the same token.

Fixes:

* Lower `extract.concurrency`.
* Move to GitHub App auth (separate quota pool).
* Stagger the cron schedule across teams.

### `wallMs > 1800000` (run took > 30 minutes)

Default GHA timeout is 30 min in `tick.yml`; longer runs will be killed.

* **Fix**: split the team across two configs and run them on different
  schedules, or bump `timeout-minutes:` in the workflow.

## Common GH Actions issues

### "The workflow file is invalid: actions/cache@v5 not found"

You're on a runner where v5 hasn't propagated yet. Pin to v4 or update
the runner image.

### Workflow runs but uploads no artifact

Check the `if-no-files-found: ignore` clause in the upload step. If
`out/` is empty (e.g. no team was due in `tick`), there's literally
nothing to upload — by design.

### "Resource not accessible by integration"

The workflow has `permissions: contents: read` but the action is trying
to write. shipreport itself never writes to the repo, so this is almost
always a custom step in your caller workflow. Check what comes after
the shipreport step.

Continue → [14 · Security model](./14-security.md).
