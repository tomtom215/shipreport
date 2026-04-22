# shipreport

Quarterly engineering success story generator.

Every quarter, managers spend hours stitching together commits, PRs, and reviews
to write success stories for each report. **shipreport** does the stitching for
them: point it at a GitHub org, declare your teams and their schedules, and it
produces a draft success story per developer plus a team highlight reel in under
a minute.

Runs locally, in Docker, or as a scheduled GitHub Action. Works against
github.com and GitHub Enterprise Server. Supports both fine-grained PATs and
GitHub App installation tokens. Ships a SOC2-oriented tamper-evident audit log.
No data leaves your network if you don't want it to.

---

## Quick start

```bash
pnpm add -g shipreport            # or: npx shipreport

# PAT path
export SHIPREPORT_GITHUB_TOKEN=ghp_...
shipreport run --config shipreport.yaml --all

# GitHub App path (see examples/shipreport.yaml)
export SHIPREPORT_APP_PRIVATE_KEY="$(cat app.pem)"
shipreport run --config shipreport.yaml --team checkout
```

Outputs land in `./out/<team>/` as Markdown + HTML (+ optional PDF):

```
out/
├── checkout/
│   ├── asmith-2026Q1.md
│   ├── asmith-2026Q1.html
│   ├── team-summary-checkout-2026Q1.md
│   └── manager-rollup-checkout-2026Q1.md
└── platform/
    └── ...
```

See [`examples/sample-output/`](./examples/sample-output) for what the reports
actually look like.

---

## Commands

```bash
shipreport run --team <name>              # one team
shipreport run --all                      # every team in the config
shipreport run --team <name> --quarter 2026Q2   # override the quarter

shipreport preview --team <name> --member asmith

shipreport schedule tick                  # run every overdue team
shipreport schedule tick --force          # run every scheduled team

shipreport audit tail --limit 100         # recent audit events
shipreport audit tail --since 2026-04-01 --json
shipreport audit verify                   # check the hash chain

shipreport cache prune
shipreport doctor
```

`shipreport preview` prints a dev's story to stdout — useful when tuning
classification labels.

---

## Multi-team config

Declare every team in one file. Each team can override `quarter`, `output`, and
`classification`; anything omitted inherits from `defaults`.

```yaml
org: acme-eng
teams:
  - name: checkout
    manager: jdoe
    members: [asmith, blee, cwong]
    repos: [acme-eng/checkout-service, acme-eng/billing-api]
    schedule: "0 14 1 1,4,7,10 *"
  - name: platform
    manager: kdoe
    members: [dsmith, elee]
    repos: [acme-eng/infra, acme-eng/ci-tooling]
defaults:
  quarter: 2026Q1
  output: { dir: ./out, formats: [md, html] }
```

The legacy v0.1 single-team shape (`team: {}` + top-level `repos:`) still works
— shipreport normalizes it to a one-entry `teams:` array on load.

---

## GitHub App auth

Fine-grained PATs work fine for small orgs, but enterprise security teams often
require GitHub Apps. Drop an `app:` block in the `github:` config:

```yaml
github:
  app:
    appId: 123456
    privateKeyEnv: SHIPREPORT_APP_PRIVATE_KEY   # PEM in env (\n-escaped), or:
    # privateKeyPath: /etc/shipreport/app.pem
    installationId: 7890123                      # optional; auto-discovered
```

Permissions (minimum): `contents:read`, `issues:read`, `pull-requests:read`,
`metadata:read`, `members:read`. Install the app on the org listed in `org:`.
shipreport mints a short-lived installation token for each run — nothing
persistent is stored.

If both `app:` and `tokenEnv` are set, the App auth wins.

---

## Scheduler

No daemon, no BullMQ, no Redis. Declare a cron expression per team, then point
a cheap trigger (GitHub Actions hourly, OS cron, Kubernetes CronJob) at
`shipreport schedule tick`. `tick` looks at each team's last run (stored in
SQLite) and runs anything that has become due since then.

```yaml
teams:
  - name: checkout
    schedule: "0 14 1 1,4,7,10 *"   # 14:00 UTC on Jan/Apr/Jul/Oct 1st
  - name: platform
    schedule: "0 9 * * MON"         # NOT SUPPORTED: named days. Use 0-6.
```

Supported cron syntax: `*`, integer, `a,b,c`, `a-b`, `*/n`, `a-b/n`. Five
fields: minute hour day-of-month month day-of-week (0=Sunday).

`tick` is idempotent: if you call it twice in the same minute, it runs each
team at most once because `last_run_at` advances past the trigger minute.

Ad-hoc runs are just `shipreport run --team <name>` — they update
`last_run_at` too, so an on-demand run suppresses the next scheduled one.

---

## Audit log (SOC2)

Every run, every report written, every token resolution, every scheduled
trigger appends one row to a local SQLite `audit_log` table. Rows include:

- `at` — RFC3339 timestamp
- `actor` — identity only, never a secret (e.g. `app:12345:install:67890` or
  `pat:env:SHIPREPORT_GITHUB_TOKEN`)
- `event` — `run_started`, `run_completed`, `report_written`, `token_resolved`,
  `schedule_triggered`, `run_failed`, `config_loaded`, `cache_pruned`
- `target` — org/team or file path
- `payload` — JSON blob (caller-controlled; no secrets)
- `prev_hash` — sha256 of the previous row's canonical form
- `hash` — sha256 of this row's canonical form (sorted keys, no whitespace)

The chain anchors at sha256 zero. `shipreport audit verify` walks the chain and
flags any row whose hash doesn't recompute, or whose `prev_hash` doesn't match
its predecessor. Deleting, editing, or reordering a row breaks the chain.

The DB is local by default. For centralized evidence, ship the SQLite file to
your compliance bucket on a schedule, or periodically run
`shipreport audit tail --json` and ship the output.

---

## Run modes

**Local:**

```bash
SHIPREPORT_GITHUB_TOKEN=ghp_... shipreport run --config shipreport.yaml --all
```

**Docker:**

```bash
docker build -t shipreport -f docker/Dockerfile .
docker run --rm \
  -e SHIPREPORT_GITHUB_TOKEN \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/out:/app/out" \
  -v shipreport-state:/root/.local/share/shipreport \
  shipreport run --config /cfg/shipreport.yaml --all
```

Add `--build-arg WITH_PDF=1` to include Chromium for PDF output.

**Scheduled GitHub Action:** `.github/workflows/quarterly.yml` runs
`shipreport schedule tick` hourly. Any team whose cron has fired since its last
run will run; the rest are skipped.

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm test            # 71 tests, ~1s
pnpm build
```

Render tests are golden-file tests: run `UPDATE_GOLDEN=1 pnpm test` to
regenerate `tests/fixtures/*.md` after intentional template changes.

Project layout:

```
src/
├── cli.ts           # citty entry point
├── config.ts        # Zod YAML schema; multi-team + legacy shapes
├── auth.ts          # GitHub App installation tokens + PAT resolution
├── github.ts        # Octokit (REST + GraphQL) with retry + throttling
├── extract.ts       # pull PRs, reviews, issues for the quarter window
├── classify.ts      # label + conventional-commit → PR kind
├── transform.ts     # RawPR[] → DevQuarter → TeamQuarter
├── narrate.ts       # deterministic prose generators
├── render.ts        # Eta → Markdown → HTML → optional PDF
├── cache.ts         # node:sqlite ETag cache (zero native deps)
├── state.ts         # shared SQLite state DB (audit + schedule tables)
├── audit.ts         # hash-chained append-only audit log
├── schedule.ts      # cron parser + ScheduleStore
├── run.ts           # per-team orchestration (auth → extract → render → audit)
├── types.ts
└── templates/       # success-story, team-summary, manager-rollup
```

Target: <2,500 lines of TS. No native dependencies.

---

## License

MIT. See [LICENSE](./LICENSE).
