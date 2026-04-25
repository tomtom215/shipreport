# Changelog

All notable changes are recorded here. Format: [Keep a Changelog
1.1.0](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer
2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GitHub Actions as primary deployment surface:
  - `tick.yml` with `run` / `dry-run` / `doctor` / `preview` modes,
    branch-scoped state cache, audit-DB artifact, post-run audit verify.
  - `validate-config.yml` — secretless PR-time schema + cron + actionlint.
  - `audit-export.yml` — daily JSONL + signed snapshot, committed to a
    git-anchored `shipreport-audit-evidence` orphan branch.
  - `reusable-shipreport.yml` — `workflow_call` interface; required
    `shipreport_ref` input forces operators to pin to a SHA or tag.
  - Five caller examples in `examples/github-actions/` (PAT, App, hourly
    tick, GHES self-hosted, PR-time validation), each with an explicit
    "REPLACE THIS PIN" header.
- End-user docs in `docs/`: 17 pages from prerequisites through audit
  log, troubleshooting, and FAQ. Indexed in `docs/README.md`.
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
- CI test matrix expanded to Node `22.13`, `24`, `26`.
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
