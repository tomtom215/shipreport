# shipreport

Draft quarterly success stories from GitHub data — one developer per page, one
rollup per team, zero prose about people you haven't already lived with. Point
shipreport at an org, declare your teams and their schedules, and it stitches
commits, PRs, reviews, and linked issues into Markdown + HTML (+ optional PDF
/ PNG) in well under a minute per team.

The narrow pitch, and the scope guardrails it implies:

- **Manager-facing output, not a dashboard.** The deliverable is a document
  a manager can paste into a calibration pre-read. No web UI, no login page.
- **Local-first.** One YAML, one binary, one SQLite file. No Postgres, no
  Redis, no BullMQ, no webhooks, no daemon.
- **Numbers are deterministic.** Prose is a manager-editable draft. The tool
  does not rank people and does not rewrite numbers with an LLM.
- **One-quarter-ago comparison only.** No trend engines, no rolling windows.
- **SOC2-oriented audit log.** Every run appends a hash-chained row to a
  local SQLite table. Tamper is caught at both the Node and storage layers.

Runs locally, in Docker, or as a scheduled GitHub Action. Works against
github.com and GitHub Enterprise Server. Fine-grained PATs and GitHub App
installation tokens both supported. No data leaves your network unless you
choose to ship the audit log somewhere.

**End-user docs**: see [`docs/`](./docs/) — a 16-page index covering
prerequisites, all three auth flows (PAT / App / GHES), every supported
deployment pattern, dry-run methodology, the audit-log model, and
troubleshooting. Start at [`docs/02-quickstart.md`](./docs/02-quickstart.md)
for a 10-minute go-live.

---

## Quick start

```bash
pnpm add -g shipreport            # or: npx shipreport

# PAT (simplest for small orgs)
export SHIPREPORT_GITHUB_TOKEN=ghp_...
shipreport run --config shipreport.yaml --all

# GitHub App (recommended for enterprise; see examples/shipreport.yaml)
export SHIPREPORT_APP_PRIVATE_KEY="$(cat app.pem)"
shipreport run --config shipreport.yaml --team checkout
```

Outputs land in `./out/` as Markdown + HTML (+ optional PDF / PNG):

```text
out/
├── asmith-2026Q1.md
├── asmith-2026Q1.html
├── team-summary-checkout-2026Q1.md
└── manager-rollup-checkout-2026Q1.md
```

See [`examples/sample-output/`](./examples/sample-output) for real renders
from shipreport's own repo.

---

## Commands

```bash
shipreport run --team <name>                   # one team
shipreport run --all                           # every team in the config
shipreport run --team <name> --quarter 2026Q2  # override the quarter
shipreport run --team <name> --pdf --png       # also emit PDF and PNG
shipreport run --team <name> --concurrency 8   # override extract.concurrency
shipreport run --team <name> --dryRun          # cache-only, no network

shipreport preview --team <name> --member asmith

shipreport schedule tick                       # run every overdue team
shipreport schedule tick --force               # run every scheduled team

shipreport audit tail --limit 100              # recent audit events
shipreport audit tail --since 2026-04-01 --json
shipreport audit verify                        # walk + check the hash chain
shipreport audit export --since 2026-04-01 --format jsonl > audit.jsonl
shipreport audit snapshot > snapshot.json      # signed chain-head manifest

shipreport cache prune                         # sweep TTL-aged cache rows
shipreport doctor                              # probe auth + reachability + DB
```

`--dryRun` is for iterating on classification labels without burning API
quota: shipreport serves every PR out of the local extract cache, making zero
network calls. If the cache is cold for any requested repo, it throws loudly
rather than silently producing an empty report. Dry-run also does not require
a token to be set.

`shipreport preview` prints one dev's story to stdout — handy when tuning
`classification` labels.

---

## Configuration

Declare every team in one YAML. Each team can override `quarter`, `output`,
`classification`, and `schedule`; anything omitted inherits from `defaults`.
[`examples/shipreport.yaml`](./examples/shipreport.yaml) is the annotated
reference.

```yaml
org: acme-eng

teams:
  - name: checkout
    manager: jdoe
    members: [asmith, blee, cwong]
    repos:
      - acme-eng/checkout-service
      - acme-eng/billing-api
    schedule: "0 14 1 1,4,7,10 *"

  - name: platform
    manager: kdoe
    members: [dsmith, elee]
    repos: [acme-eng/infra, acme-eng/ci-tooling]

defaults:
  quarter: 2026Q1                # or { from: YYYY-MM-DD, to: YYYY-MM-DD }
  timezone: America/New_York     # quarter window is resolved in this tz
  coAuthorCredit: full           # or "split"
  output:
    dir: ./out
    formats: [md, html]          # md, html, pdf, png
    perDev: true
    teamSummary: true
    managerRollup: true
  classification:
    bugfixLabels: [bug, hotfix, p0, p1]
    featureLabels: [feature, enhancement]
    infraLabels: [ci, build, devops, infra]
    docsLabels: [docs, documentation]

audit:
  enabled: true
  path: ~/.local/share/shipreport/state.sqlite
  signingKeyPath: ~/.config/shipreport/audit-ed25519.pem
  signer: shipreport

cache:
  path: ~/.cache/shipreport/cache.sqlite
  ttlDays: 7

extract:
  concurrency: 4                 # max simultaneous per-repo fetches
  rateLimitThreshold: 100        # GraphQL quota floor → degrade to serial
```

The legacy v0.1 single-team shape (`team: {}` + top-level `repos:` + top-level
`quarter:`) is still accepted and normalized to a one-entry `teams:` array on
load. Existing v0.1 configs don't need to be rewritten.

### Quarter resolution

`quarter` is either a label like `2026Q1` or an explicit `{from, to}` range.
Labels expand to the three calendar months of the quarter **in the configured
timezone**, not UTC. `Intl.DateTimeFormat` does the heavy lifting, so DST
transitions are handled correctly — e.g. `2025Q4` in `Pacific/Auckland` ends
at `Dec 31 23:59:59 NZDT` (= `Dec 31 10:59:59 UTC`) and the following Q1
starts one millisecond later in the same zone.

### Auto-discovered members

Omit `members:` and shipreport picks the team from merged-PR activity in the
team's repos for the target quarter:

```yaml
teams:
  - name: oss
    manager: auto
    repos: [vllm-project/vllm]
    autoMembers:
      limit: 10            # top 10 merged-PR authors
      excludeBots: true    # drops [bot], -bot, -robot, dependabot, renovate, …
      excludeLogins: []    # additional opt-outs
```

Ties break alphabetically, so the same inputs always produce the same team.
The discovered list is recorded in the audit log (`members_discovered`) with
every run so the output is reproducible and evidence-backed. See
[`examples/vllm.yaml`](./examples/vllm.yaml) for a public-repo demo that
needs nothing beyond a token.

### Co-author credit

PRs merged with `Co-authored-by:` trailers are credited to every listed
contributor. `defaults.coAuthorCredit` controls how:

- `full` (default): author and each co-author get full `prsMerged` and
  `filesTouched` credit.
- `split`: each contributor gets `1/N` credit where `N = 1 + coauthors`.

Co-author logins are resolved only from GitHub's `noreply` email form
(`<id>+<login>@users.noreply.github.com`); plain emails fall back to the
merge author to avoid guessing.

---

## GitHub App auth (with renewal)

Fine-grained PATs work fine for small orgs; enterprise security teams usually
prefer Apps. Drop an `app:` block in the `github:` config:

```yaml
github:
  app:
    appId: 123456
    privateKeyEnv: SHIPREPORT_APP_PRIVATE_KEY   # PEM in env, \n-escaped
    # privateKeyPath: /etc/shipreport/app.pem
    installationId: 7890123                     # optional; auto-discovered
```

Minimum permissions: `contents:read`, `issues:read`, `pull-requests:read`,
`metadata:read`, `members:read`. Install the app on the org named in `org:`.

Installation tokens are valid for one hour. shipreport's `TokenSource`
abstraction caches the token and re-mints automatically after 50 minutes
(configurable via `DEFAULT_RENEW_AFTER_MS`), so runs that scan large orgs
through many repos don't fail mid-extract. A `token_renewed` audit row is
appended each time a fresh token is minted.

If both `app:` and `tokenEnv` are set, the App path wins.

---

## Scheduler

No daemon, no BullMQ, no Redis. Declare a cron expression per team, then
point a cheap trigger (hourly GitHub Actions, OS cron, Kubernetes CronJob)
at `shipreport schedule tick`. Tick reads each team's last-run time from
SQLite and runs anything whose cron has become due.

```yaml
teams:
  - name: checkout
    schedule: "0 14 1 1,4,7,10 *"   # 14:00 on the 1st of Jan/Apr/Jul/Oct
  - name: platform
    schedule: "0 9 * * 1"           # 09:00 every Monday (0=Sun, 1=Mon, …)
```

Supported cron syntax: `*`, integer, `a,b,c`, `a-b`, `*/n`, `a-b/n`. Five
fields: `minute hour day-of-month month day-of-week`. Named days (`MON`,
`TUE`) are **not** supported — use `0`–`6`.

`tick` is idempotent: calling it twice in the same minute runs each team at
most once, because `last_run_at` advances past the trigger minute on success.
Ad-hoc `shipreport run --team <name>` also updates `last_run_at`, so an
on-demand run suppresses the next scheduled one.

---

## Resilience

Long extracts across many repos are the common failure mode. Three mechanisms
keep them boring:

- **Concurrency pool.** `extract.concurrency` (default 4) bounds per-repo
  fetches. Peak concurrency observed during a run is logged to the audit
  payload.
- **Incremental cache.** The extract cache stores the full PR set keyed by
  `(repo, quarter, tz)` plus the max `updatedAt` seen so far. On re-run,
  GraphQL is ordered `UPDATED_AT DESC` and pagination stops as soon as a
  node's `updatedAt` is `<= lastSeen`. Second runs with no upstream changes
  hit ≥90% cache (enforced by test).
- **Rate-limit degradation.** Every GraphQL response carries
  `rateLimit.remaining`; when it drops below `extract.rateLimitThreshold`
  (default 100), the client flips to serial mode — gated work runs one call
  at a time — and the throttling plugin's retry budget doubles. A
  `rate_limit_degraded` audit row records the decision with the observed
  remaining value.
- **Checkpoints.** Each successful page writes the current cursor + collected
  PRs to `extract_checkpoints`. A mid-extract crash leaves the row behind;
  the next run resumes from the saved cursor rather than paginating from
  scratch. Checkpoints are cleared on successful completion and swept on a
  TTL basis by `cache prune`.

---

## Audit log (SOC2)

Every run, every report written, every token resolution or renewal, every
scheduled trigger, every rate-limit degradation, appends one row to a local
SQLite `audit_log` table. Row shape:

- `at` — RFC3339 timestamp
- `actor` — identity only, never a secret (e.g. `app:12345:install:67890` or
  `pat:env:SHIPREPORT_GITHUB_TOKEN`)
- `event` — one of:
  - `config_loaded`, `run_started`, `run_completed`, `run_failed`
  - `token_resolved`, `token_renewed`
  - `schedule_triggered`, `report_written`, `cache_pruned`
  - `members_discovered`, `rate_limit_degraded`, `extract_checkpointed`
- `target` — org/team or file path
- `payload` — JSON blob (caller-controlled; never secrets)
- `prev_hash` — sha256 of the previous row's canonical form
- `hash` — sha256 of this row's canonical form (sorted keys, no whitespace)

The chain anchors at sha256 zero. `shipreport audit verify` walks the chain
and flags any row whose hash doesn't recompute, or whose `prev_hash` doesn't
match its predecessor. Deleting, editing, or reordering a row breaks it.

Every `run_completed` row carries a `counters` payload:

```json
{
  "apiCalls": 42,
  "rateLimitSleepsMs": 0,
  "cacheHits": 118,
  "peakConcurrency": 4,
  "remainingRateLimit": 4958,
  "wallMs": 3142
}
```

Use it to post-hoc answer "was this run fast?", "did we sleep on rate
limits?", or "how much did the incremental cache help?" — without adding a
metrics stack.

### Defense-in-depth

Two layers enforce the append-only invariant:

1. **Node layer.** The `AuditLog` class exposes only `append()`, `tail()`,
   `readForward()`, `head()`, and `verify()`. No UPDATE or DELETE path.
2. **Storage layer.** SQLite `BEFORE UPDATE` and `BEFORE DELETE` triggers on
   `audit_log` `RAISE(ABORT)` with a clear message. Even an operator with
   direct DB access can't mutate a row via standard SQL.

A property-based test (fast-check) drives random append sequences and
random single-row mutations; both triggers and `verify()` must agree on
every case.

### Streaming evidence

`audit export --since <ISO> --format jsonl` emits one row per line, in chain
order, including `prevHash` and `hash`. A downstream verifier can replay the
file with nothing but the genesis zero hash (or any anchor hash for
incremental exports) and detect any tampering.

### External anchoring

`audit snapshot` produces a signed manifest:

```json
{
  "manifest": {
    "chainHeadSeq": 1248,
    "chainHeadHash": "ab12…",
    "generatedAt": "2026-04-23T12:00:00.000Z",
    "signer": "acme-compliance"
  },
  "manifestCanonical": "{\"chainHeadHash\":\"ab12…\",…}",
  "signature": "base64-ed25519…",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n…"
}
```

Anchor it outside the host running shipreport (git, S3 Object Lock, a
transparency log). Any later attempt to lop rows off the tail of the audit
log is caught: the snapshot's `chainHeadSeq` / `chainHeadHash` no longer
match, and the ed25519 signature proves the snapshot itself is authentic.

The signing key lives at `audit.signingKeyPath` (default
`~/.config/shipreport/audit-ed25519.pem`). If missing, shipreport generates
one at mode `0600` on first `audit snapshot`; rotate it with standard
OpenSSL / `ssh-keygen` tooling.

---

## Run modes

### Local

```bash
export SHIPREPORT_GITHUB_TOKEN=ghp_...
shipreport run --config shipreport.yaml --all
```

### Docker

The image runs as the unprivileged user `shipreport` (uid 10001) with state
and cache persisted to `/home/shipreport/...` volumes. The base image is
pinned by digest; dependabot refreshes the pin weekly.

```bash
docker build -t shipreport -f docker/Dockerfile .

docker run --rm \
  -e SHIPREPORT_GITHUB_TOKEN \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/out:/app/out" \
  -v shipreport-state:/home/shipreport/.local/share/shipreport \
  -v shipreport-cache:/home/shipreport/.cache/shipreport \
  shipreport run --config /cfg/shipreport.yaml --all
```

Add `--build-arg WITH_PDF=1` to install Chromium + puppeteer for PDF
output (~250-300 MB larger; total ~400-450 MB image). Omit the flag to
keep the image at ~150 MB.

### Scheduled GitHub Action (recommended)

GitHub Actions is the primary supported deployment. Three patterns ship
ready-to-use:

* **Fork-and-go**: [`.github/workflows/tick.yml`](./.github/workflows/tick.yml) —
  hourly cron + manual dispatch with `run` / `dry-run` / `doctor` /
  `preview` modes. No-op when there's no `shipreport.yaml` at the repo
  root, so the upstream mirror stays green.
* **Reusable workflow**:
  [`.github/workflows/reusable-shipreport.yml`](./.github/workflows/reusable-shipreport.yml) —
  callable from any repo. Five copy-paste callers in
  [`examples/github-actions/`](./examples/github-actions/) cover PAT,
  App, hourly tick, GHES self-hosted, and PR-time validation.
* **Audit export**:
  [`.github/workflows/audit-export.yml`](./.github/workflows/audit-export.yml) —
  daily JSONL + signed snapshot of the audit chain, uploaded as an
  artifact for SOC2 evidence.

Full operator manual is in [`docs/`](./docs/) — start at
[`docs/02-quickstart.md`](./docs/02-quickstart.md).

---

## Development

```bash
pnpm install
pnpm typecheck       # tsc --noEmit
pnpm lint            # eslint src tests
pnpm test            # 167 tests, ~3s
pnpm test:coverage   # v8 coverage; gate at 85% for src/ (cli.ts excluded)
pnpm build           # tsc + copy templates → dist/
```

Render tests are golden-file tests: run `UPDATE_GOLDEN=1 pnpm test` to
regenerate `tests/fixtures/*.md` after an intentional template change.

### Project layout

```text
src/
├── cli.ts               # citty entry point
├── config.ts            # Zod YAML schema; multi-team + legacy shapes
├── token-source.ts      # PAT + App auth; renews installation tokens at 50m
├── github.ts            # Octokit REST + GraphQL with retry + throttling
├── extract.ts           # paginated PR fetch; default-branch + updatedAt filter
├── extract-cache.ts     # (repo, quarter, tz) snapshots + mid-run checkpoints
├── concurrency.ts       # bounded work-stealing pool
├── rate-limit.ts        # guard that degrades to serial under quota pressure
├── counters.ts          # per-run counters bag
├── pr-parse.ts          # linked-issue / co-author / revert parsers
├── classify.ts          # label + conventional-commit → PR kind
├── discover.ts          # auto-discovery of team members from PR authors
├── transform.ts         # RawPR[] → DevQuarter → TeamQuarter
├── narrate.ts           # deterministic prose generators (headline, points)
├── render.ts            # Eta → Markdown → HTML → optional PDF/PNG
├── tz.ts                # timezone-aware quarter boundaries (Intl)
├── cache.ts             # node:sqlite cache + extract snapshots + checkpoints
├── state.ts             # shared SQLite (audit_log + schedule_state + triggers)
├── audit.ts             # hash-chained append-only audit log
├── audit-export.ts      # JSONL export + offline chain re-verify
├── sign.ts              # ed25519 snapshot signing (node:crypto, no native)
├── schedule.ts          # cron parser + ScheduleStore
├── run.ts               # per-team orchestration; threads counters + guard
├── types.ts             # shared DTOs
└── templates/           # success-story, team-summary, manager-rollup .eta
```

No native dependencies anywhere. `node:sqlite` is unflagged in Node
22.13+ / 23.4+ and reached release-candidate stability in Node 25.7.
shipreport supports Node `>=22.13.0` per `package.json`.

### CI gates

Every PR runs:

- `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage` (85% floor)
- `pnpm audit --prod --audit-level=high`
- actionlint on `.github/workflows/*.yml`
- markdownlint-cli2 on `examples/sample-output/**/*.md`

HTML coverage report is uploaded as a CI artifact on every run.

### Release pipeline

[`.github/workflows/release.yml`](./.github/workflows/release.yml) fires on a
`v*` tag push. It gates on the full test matrix, then:

- publishes to npm with `--provenance` (sigstore via GitHub OIDC),
- builds a multi-arch (`linux/amd64`, `linux/arm64`) image and pushes to
  `ghcr.io/<owner>/shipreport:<version>`,
- signs the image digest keyless via cosign (sigstore + OIDC),
- generates a CycloneDX SBOM with syft and attaches it to the GitHub release.

The tag's version must match `package.json`'s `version` field; a mismatch
fails the job fast.

### Scope traps

Rejected — the tool is narrow on purpose:

- Trend analysis beyond one-quarter-ago comparison.
- Service mode (daemon, HTTP server, webhooks, multi-tenant).
- Jira / Linear / Slack integration.
- LLM rewriting of numbers (prose-only, optional, post-generation is fine;
  numbers stay deterministic).
- Postgres / Redis / BullMQ / rollup engine.
- Dashboards or web UI.
- Per-PR "performance" scoring usable for calibration.

---

## License

MIT. See [LICENSE](./LICENSE).
