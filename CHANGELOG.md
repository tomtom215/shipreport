# Changelog

All notable changes are recorded here. Format: [Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer
2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Pass 9 — delivery to non-technical managers

Closed the last-mile gap for an operator whose end audience (the
manager being calibrated) doesn't use GitHub and won't open a
terminal. shipreport still produces files; this pass makes "files →
manager's inbox" a documented, scripted, air-gappable path.

- **`docs/16-delivery.md`** — new operator manual page covering seven
  delivery patterns (email-as-PDF-attachment, email-as-HTML-inline,
  shared drive / SharePoint / Google Drive, internal static-site host,
  Slack / Teams / Mattermost, calendar-invite-with-PDF, print-and-walk),
  each with copy-paste recipes. Notes which patterns work air-gapped
  (almost all of them — the constraint is your internal SMTP / file
  share / chat being reachable).
- **`scripts/email-report.sh`** — copy-paste-ready helper that emails
  a single rendered file (or per-team auto-dispatched files via a
  sidecar `managers.yaml` mapping). Auto-detects whichever local mail
  transport is available (`msmtp` / `sendmail` / `mail` / `mailx`),
  builds the MIME message, and sends. `--dry-run` shows what would go
  out without sending. `--inline` sends rendered HTML in the body
  instead of as an attachment.
- **HANDOFF.md** has a new "Step 8 — Get the report to the manager"
  section that walks the simplest path (single recipient + the
  email-report helper) and points at `docs/16-delivery.md` for any
  other channel.
- **`docs/15-faq.md`** clarifies there is no upstream issue tracker
  and adds a "Will the original maintainer help?" answer (no — clean
  one-way handover).
- **`tests/e2e/docs-index.test.ts`** + **`docs/README.md`** + README
  page-count update — page 16 is now part of the index test, and the
  README correctly reports 17 numbered pages.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test`
(31 files / 331 tests) all clean. `email-report.sh --dry-run`
smoke-tested across single-recipient and `--pattern` + `--managers`
flows.

### Pass 8 — clean-handover preparation

Prepares the repo for delivery as a static archive (ZIP / tarball) to a
new owner who has no upstream support channel and may deploy
air-gapped. No public CLI behaviour changed; this pass is about making
the project self-contained, generic, and survivable on its own.

- **HANDOFF.md** at the repo root is the recipient's first read. Walks
  from "I just unpacked the archive" through Node + pnpm install,
  build, smoke test, config, first run, and air-gapped deployment.
  README.md now opens with a callout pointing at it.
- **scripts/preflight.mjs** — makes zero network calls, scans the
  unpacked tree for any leftover personal-handle markers, and verifies
  every prerequisite (Node version, package.json shape, source layout,
  built `dist/`, populated `node_modules/`). Safe to run on an
  air-gapped host.
- **scripts/setup.sh** — one-shot bootstrap (Node check + corepack
  pnpm + `pnpm install --frozen-lockfile` + `pnpm build` + preflight).
- **De-personalisation**:
  - `LICENSE` copyright holder genericised.
  - `SECURITY.md` rewritten as an owner-customisable template with
    `EDIT:` markers for the new owner's vulnerability-report channel
    and SLA.
  - `.github/CODEOWNERS` uses a `@YOUR-GITHUB-OWNER` placeholder.
  - `package.json` `repository` field removed (no false GitHub URL).
  - All `tomtom215/shipreport` references in docs, examples, and
    workflow callers replaced with `YOUR-GITHUB-OWNER/YOUR-FORK`.
  - Test fixture orgs / repos genericised (`example-org/example-repo`).
  - Sample-output files rename `tomtom215` developer login to `alice`;
    PR links rewritten to `https://example.com/...`. Filename
    `tomtom215-2026Q2.md` renamed to `alice-2026Q2.md`.
  - `tests/e2e/workflows.test.ts` regexes match the reusable-workflow
    path (`/.github/workflows/reusable-shipreport.yml@`) instead of a
    specific GitHub owner — survives the recipient's fork rename.
- **Air-gapped operability**: the runtime never reaches outside the
  recipient's GitHub instance. HANDOFF.md documents three offline-
  install paths (vendored `node_modules` tarball, internal npm
  registry, Docker mirror).
- **Workflow-specific caveats** added to `.github/workflows/release.yml`
  and `.github/workflows/audit-export.yml` so a recipient who pushes
  the code to GitHub knows which workflows need adapting and which
  work as-is.
- **Dockerfile** OCI `image.source` label switched to a placeholder
  the recipient can override.
- **README + CONTRIBUTING + docs/00** rewritten to acknowledge the
  recipient as the new owner and to recommend local-CLI as the
  primary path; GitHub Actions stays first-class but is no longer the
  "primary supported" deployment.

Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test:coverage`
(31 files / 331 tests / coverage gates met) and `pnpm audit --prod
--audit-level=high` all pass. `node scripts/preflight.mjs` reports
clean.

### Pre-handoff audit (Pass 7)

A line-by-line audit of every doc, example, and code path turned up the
issues below; this section is the reconciliation. No public CLI surface
changed; behaviour previously documented but unimplemented (or vice
versa) was made consistent — by code change in either direction.

- **Quickstart now uses the delay-resistant hourly-tick pattern.** The
  inline workflow in `docs/02-quickstart.md` was missing the required
  `shipreport_ref` input AND used `mode: run` with a quarterly cron, so
  any GitHub-scheduler delay would silently skip the entire quarter's
  run. New snippet uses hourly cron + `mode: tick` + a
  `REPLACE_WITH_TAG_OR_SHA` placeholder that fails fast if not
  substituted. Step 7's "delays are harmless" paragraph is reworded to
  describe the actual scan-window behaviour.
- **All five caller examples in `examples/github-actions/`** had a
  40-hex placeholder SHA (`0954c50…`) that did not exist in the repo.
  Operators forgetting to substitute would get an opaque "ref not
  found" error from GitHub. Replaced with `REPLACE_WITH_TAG_OR_SHA`
  across `quarterly-pat.yml`, `quarterly-app.yml`, `hourly-tick.yml`,
  `ghes-self-hosted.yml`, `dry-run-on-pr.yml`. Two new e2e checks in
  `tests/e2e/workflows.test.ts` enforce the placeholder shape and
  block any future 40-hex-pin to shipreport's own reusable workflow
  inside `examples/`.
- **`audit verify` failure in `tick.yml` now fails the job** (was a
  yellow `::warning::`). Matches the contract `SECURITY.md` and
  `docs/12-audit-log.md` describe — a tampered chain is a stop-the-
  scheduler event, not advisory.
- **Date-range schema validation now rejects `from > to`.** Zod
  refinement in `src/config.ts`; previously an operator typo silently
  produced zero PRs at extract time. `tests/config.test.ts` covers
  the boundary case (`from === to` allowed), the negative case, and
  both `defaults.quarter` and per-team `quarter`.
- **`shipreport doctor` now exits 2 when any team's cron is invalid.**
  Previously the diagnostic line was printed but exit was 0, so a CI
  preflight could pass with broken crons. `tests/cli.test.ts` covers
  the invalid-cron and all-valid paths.
- **`--concurrency` CLI override now caps at 32**, matching the YAML
  schema's `extract.concurrency.max(32)`. Boundary + over-cap covered
  in `tests/cli.test.ts`.
- **CLI error path no longer dumps a Node stack trace** through citty's
  default handler. `src/cli-main.ts` now dispatches `runCommand`
  directly and prints `shipreport: <message>` for any user-facing
  Error. Set `SHIPREPORT_DEBUG=1` to restore the full Error output for
  local debugging.
- **Pluralization helper** added to `src/render.ts` (`fmt.plural`) and
  applied across all three Eta templates. Mirror helper in
  `src/narrate.ts` (`pluralForm`) covers the talking-points strings.
  `examples/sample-output/` had "1 services", "1 fixes", "1 refactors"
  in committed Markdown; refreshed to "1 service", "1 fix",
  "1 refactor". `tests/render.test.ts` and `tests/narrate.test.ts`
  cover the singular/plural boundary including 0/1/N and the irregular
  `fix → fixes` form.
- **Filesystem hardening**:
  - `~/.config/shipreport/` is auto-created at mode `0700` (was
    `0755`) to match the Dockerfile's posture; the ed25519 key file
    itself was already `0600`. `tests/sign.test.ts` covers both.
  - `state.sqlite` and any `-wal` / `-shm` siblings are chmod'd to
    `0600` after open. The audit DB carries chain hashes and run
    identifiers; defense-in-depth says no world-readability.
    `tests/audit.test.ts` covers both.
- **`token-source.ts` App-installation discovery `fetch`** now uses
  `USER_AGENT` from `src/version.ts` instead of a literal `"shipreport"`
  string. The CHANGELOG entry below claimed UA unification at v0.2.0
  but missed this call site. `tests/version.test.ts` adds a source-
  level guard to prevent the literal from coming back.
- **`puppeteer` moved from `optionalDependencies` to `devDependencies`.**
  `optionalDependencies` are installed by default by pnpm, so an end
  user running `pnpm add shipreport` was silently pulling ~400 MB of
  Chromium even when they only ever wanted Markdown / HTML output.
  `devDependencies` are NOT installed for downstream consumers, so
  `pnpm add shipreport` is now slim; operators who want PDF / PNG run
  `pnpm add puppeteer` explicitly. The Dockerfile already does this in
  the `WITH_PDF=1` build. Docs (`00-overview.md`, `06-config.md`,
  `14-security.md`) updated to match the actual install behaviour.
- **`scripts/render-sample.mjs`** auto-discovers `examples/sample-
  output/*.md` (was a stale hard-coded list referencing files that no
  longer existed) and runs `pnpm build` inline if `dist/` is missing
  rather than failing with `ERR_MODULE_NOT_FOUND`.
- **Docs/example housekeeping**:
  - `docs/09-deployment-github-actions.md` matrix now has six caller
    examples (the previously-orphan `quarterly-image.yml` joins the
    five it already documented). README.md and CHANGELOG.md text
    updated to "Six caller examples".
  - `docs/10-deployment-docker.md:21` correctly says `node:24-alpine`
    (was `node:25-alpine`; the Dockerfile and the rest of the same
    doc all said 24).
  - `docs/15-faq.md`, `README.md`, `CONTRIBUTING.md` now describe the
    actual coverage gates (95% lines / 95% functions / 85% branches /
    95% statements globally; 100% per-file on `audit.ts`,
    `audit-export.ts`, `sign.ts`, `state.ts`).
  - Test count drift fixed (`README.md` said 167, actual is 331 after
    this pass; `CONTRIBUTING.md` said ~5s, actual is ~10s).
  - `docs/13-troubleshooting.md` no longer lists the impossible
    `audit.path: Required` Zod error; instead lists the new
    reversed-date-range error.
  - `docs/02-quickstart.md` has a new note explaining the
    `SHIPREPORT_TOKEN` (secret name) vs `SHIPREPORT_GITHUB_TOKEN` (env
    var name) rename, and a new note on the `Token scopes:` doctor
    line varying by auth type. `docs/05-auth-ghes.md` /
    `docs/08-dry-run.md` cross-reference the canonical explanation.
  - `docs/06-config.md` documents the 40-page extract safety cap.
  - `package.json` engines pin: `pnpm: ">=10.0.0 <11.0.0"` (was
    `>=10.0.0`) so a future pnpm 11 doesn't break frozen-lockfile
    consumers without notice.
  - `dry-run-on-pr.yml` and `quarterly-image.yml` now SHA-pin every
    third-party action `uses:` (were on floating `@v4` / `@v3` tags
    while every other workflow in the repo was already SHA-pinned).
    The new e2e test enforces this for `examples/github-actions/`.

### Added
- `token_renewed` and `extract_checkpointed` audit rows are actually
  emitted (the enum-only declarations + doc claims they were already
  written are now backed by real call sites in `run.ts`):
  - `runTeam` passes an `onRenew` callback into `tokenSourceFromConfig`
    that appends a `token_renewed` row whenever the App installation
    token is re-minted at the 50-minute boundary.
  - `extractAll` now invokes an `onCheckpoint` callback at every
    page-boundary checkpoint write, which `run.ts` translates into an
    `extract_checkpointed` audit row.
- `tests/audit-events.test.ts` grep-walks `src/` to assert every
  declared `AuditEvent` has at least one production call site.
- `tests/version.test.ts`, `tests/cache.test.ts`, `tests/audit.test.ts`
  unit-cover the new row validators that replaced the old `as any`
  shims.
- `SHIPREPORT_NO_SANDBOX=1` opt-in for puppeteer's `--no-sandbox`
  flag. Chromium's sandbox is now left enabled by default on bare
  metal; the flag is dropped automatically inside Docker (via
  `/.dockerenv` detection) or when an operator sets the env var.

### Changed

- `src/cli.ts` no longer hard-codes `version: "0.2.0"` and `src/github.ts`
  no longer hard-codes `userAgent: "shipreport/0.2"` — both pull from
  `src/version.ts`.
- `apiCalls` counter no longer counts probe queries or pre-flight
  token-resolution failures; the run-completed audit payload reflects
  extract work only. `cacheHits` is now exact (count of merged-result
  PRs whose `(repo, number)` was not freshly fetched), no longer a
  length-difference heuristic.
- `node:sqlite` is imported through the typed `@types/node` declaration
  rather than `createRequire(...) as any`. Both `Cache` and `StateDB`
  now run validators on every read (typed throw paths covered by tests).
- `src/audit.ts` `append()` reads `seq` from `lastInsertRowid` instead
  of issuing a follow-up `SELECT seq WHERE hash = ?` round-trip.
- Both SQLite databases (cache + state) open with `PRAGMA journal_mode=
  WAL` so an in-progress extract doesn't block concurrent `audit verify`
  / `audit export` readers.
- `runConcurrent` short-circuits new dispatch once any task has thrown,
  bounding wasted work (e.g. cascading 401s) at `limit-1` rather than
  the full N — in-flight tasks still settle so partial audit rows write.
- `bin/shipreport.js` silences only the `node:sqlite`
  `ExperimentalWarning` at the binary boundary; tests still see all
  warnings.
- `pnpm dev` now runs `tsx src/cli-main.ts` (was `tsx src/cli.ts`,
  which became a no-op when the citty `runMain` moved out of cli.ts).

### Fixed

- Dead `Number.isInteger(rounded) ? rounded : rounded` ternary in
  `src/transform.ts roundCredit`.
- `src/render.ts firstParagraph` comment no longer claims to strip
  trailing issue-link refs (it never did; only leading `#` and `>`).
- `docker/Dockerfile` no longer claims to match `engines.node: ">=24"`
  (real floor is `>=22.13.0`) or that Node 24 ships "stable" SQLite
  (it's still tagged `ExperimentalWarning` — the binary now suppresses
  the noise instead).
- `cli.ts` `audit tail / verify / export / snapshot` use a shared
  `requireState` helper instead of repeating the four-line
  `audit.enabled: false → exit 2` block.

## [Pre-Unreleased]

- GitHub Actions as primary deployment surface:
  - `tick.yml` with `run` / `dry-run` / `doctor` / `preview` modes,
    branch-scoped state cache, audit-DB artifact, post-run audit verify.
  - `validate-config.yml` — secretless PR-time schema + cron + actionlint.
  - `audit-export.yml` — daily JSONL + signed snapshot, committed to a
    git-anchored `shipreport-audit-evidence` orphan branch.
  - `reusable-shipreport.yml` — `workflow_call` interface; required
    `shipreport_ref` input forces operators to pin to a SHA or tag.
  - Six caller examples in `examples/github-actions/` (hourly tick,
    quarterly PAT, quarterly App, GHES self-hosted, cosign-verified
    digest-pinned image, PR-time validation), each with an explicit
    "REPLACE_WITH_TAG_OR_SHA" sentinel that fails the workflow at
    GitHub's first run if the operator forgets to substitute.
- End-user docs in `docs/`: 16 numbered pages (00 Overview through 15
  FAQ) plus the index `docs/README.md` — 17 markdown files in total.
- `shipreport doctor --offline` flag — schema/cron/path probe without
  auth or network. Used by the reusable workflow's dry-run preflight.
- `scripts/validate-config.mjs` — secretless config validator runnable
  from any CI without secrets.
- E2E test suite in `tests/e2e/` covering workflow YAML contracts,
  example config validity, full dry-run pipeline, docs-index integrity,
  validate-config script behaviour.
- `nock`-based unit tests for `src/github.ts` (REST + GraphQL paths).
- CLI smoke tests over `src/cli.ts` (previously excluded from coverage).
- SQLite raw-page-corruption test in `tests/audit-property.test.ts`.
- `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, this `CHANGELOG.md`.

### Changed

- `package.json`: `engines.node` lowered from `>=24.0.0` to `>=22.13.0`
  to match where `node:sqlite` is unflagged. `engine-strict=true` added
  via `.npmrc` so the constraint is enforced at install time.
- CI test matrix expanded to Node `22.13`, `24`, `25`.
- `lint-workflows` job now uses the official `rhysd/actionlint` binary
  (verified by SHA-256), not the third-party `raven-actions/actionlint`
  wrapper.
- Coverage thresholds switched from global to per-file in
  `vitest.config.ts`. `src/audit.ts` and `src/audit-export.ts` gate at
  100% lines / 95% branches.
- `src/cli.ts` and `src/github.ts` removed from the coverage-exclude
  list and brought to ≥95% line coverage.
- fast-check `numRuns` for the audit property test bumped to 1000.
- `Dockerfile`: pinned to `node:24-alpine` by digest (real, verifiable),
  multi-stage with `--frozen-lockfile` in both stages, OCI labels
  added, `~/.config/shipreport` mode `0700`.

### Fixed

- `audit-export.yml` no longer claims to commit to an audit branch
  while only uploading an artifact — it now actually creates and
  appends to `shipreport-audit-evidence`.
- The reusable workflow's doctor preflight no longer fails
  dry-run-only operators (no PAT / no App) — `--offline` is passed
  for `mode: dry-run`.
- `audit-export.yml`'s key-staging step now uses `printenv` (byte-exact)
  instead of `printf '%s'` (mangles `%`-sequences in PEM bodies).
- Docs claims about App key rotation, GHES PAT support, and
  `node:sqlite` stability rewritten against authoritative sources.
- `runs_on` reusable input now decoded via `fromJSON` so a JSON-array
  string and a single-label string both route to `runs-on:` correctly.
- `tests/e2e/validate-config-script.test.ts` no longer silently skips
  when `dist/` is absent — it builds inline so a green test means the
  script actually ran.

## [0.2.0] - prior

Initial public iteration of the multi-team config shape, scheduler,
SOC2-oriented audit log, and Docker / GH Actions support. See
[`README.md`](./README.md) for the original feature set.
