# Contributing to shipreport

Thanks for considering a contribution. This document is short on purpose;
the project is narrow and deliberately resists scope creep. Read
[`docs/00-overview.md`](./docs/00-overview.md) before opening a PR for a
new feature.

## Development setup

```bash
pnpm install           # honors engines (Node >=22.13, pnpm >=10 <11)
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint src tests
pnpm test              # vitest, ~10 s on a typical laptop (306 tests today)
pnpm test:coverage     # vitest with v8 coverage; gates on the floors in vitest.config.ts
pnpm build             # tsc + copy templates → dist/
```

`.nvmrc` is `24` — that's the local-development anchor and the version
shipreport's CI matrix and Docker base track. The minimum supported Node
is `22.13.0` (where `node:sqlite` was unflagged); the matrix exercises
22.13, 24, and 25 on every PR. If you `nvm use` from this repo you'll
land on 24, which is fine.

CI runs the same gates plus a Node-version matrix (`22.13`, `24`, `25`),
`pnpm audit --prod --audit-level=high`, actionlint (official binary),
markdownlint over `docs/` and `examples/sample-output/`, and
`scripts/validate-config.mjs` over both checked-in example configs.

## What kind of changes we accept

| Yes                                            | No                                          |
| ---------------------------------------------- | ------------------------------------------- |
| Bug fixes with a regression test.              | Web UI / dashboard / SaaS hosting.          |
| New `defaults.*` fields with Zod default.      | LLM rewriting of numbers.                   |
| New event names in the audit log.              | Trend engines beyond one-quarter-ago.       |
| New deployment recipes in `docs/`.             | New backing stores (Postgres, Redis).       |
| Performance work for `extract.ts`.             | Per-PR scoring / calibration ranking.       |
| Better classification heuristics.              | Daemon mode / webhook ingestion.            |
| Additional GH Actions caller examples.         | Slack / Jira / Linear integrations.         |

The rejected list is from [`README.md`'s "Scope traps"](./README.md);
those are settled questions.

## Pull request checklist

Before opening a PR:

- [ ] `pnpm typecheck && pnpm lint && pnpm test:coverage` is green.
- [ ] New code paths have a unit test. New CLI flags have a CLI test.
- [ ] If you touched `src/audit.ts` or any chain logic, the property
  test in `tests/audit-property.test.ts` still passes (and you've
  considered whether to extend it).
- [ ] Docs touched: if you changed config shape, update
  `docs/06-config.md`. If you changed a workflow, update
  `docs/09-deployment-github-actions.md`. Doc-index integrity is
  enforced by `tests/e2e/docs-index.test.ts`.
- [ ] Sample outputs regenerated if you touched a template:
  `UPDATE_GOLDEN=1 pnpm test`.
- [ ] No new dependencies unless the alternative is significantly worse.
  Native dependencies are essentially never accepted (`node:sqlite`
  and the `node:crypto` ed25519 path exist precisely so we don't need
  better-sqlite3 / sodium-native).

## Coverage policy

Per-file thresholds (set in `vitest.config.ts`) keep individual files
honest:

- `src/audit.ts` and `src/audit-export.ts` — 100% lines / 95% branches.
  These are the SOC2 evidence path.
- Everything else — 95% lines / 85% branches.

If you add a file, add a row to the per-file `thresholds.perFile` block.
If you can't reach the floor, ask before merging — most often the right
move is splitting the file or adding a new test, not lowering the floor.

## Commit style

Conventional-commit prefixes optional but appreciated:

- `feat(extract): …` for new functionality.
- `fix(audit): …` for bug fixes.
- `docs: …` for doc-only changes.
- `chore(ci): …` for CI / tooling changes.

The release pipeline (`release.yml`) doesn't parse commits; the changelog
is hand-curated in `CHANGELOG.md`.

## Releasing

Maintainers only. See `release.yml` for the pipeline. The flow:

1. Bump `package.json`'s `version` field.
2. Update `CHANGELOG.md` under a fresh `## [X.Y.Z] - YYYY-MM-DD` heading.
3. Tag: `git tag v<X.Y.Z> && git push origin v<X.Y.Z>`.
4. The release workflow gates on the test matrix, then publishes:
   - npm package with `--provenance`,
   - multi-arch Docker image to GHCR,
   - cosign keyless signature over the image digest,
   - CycloneDX SBOM attached to the GitHub release.

The tag's version must match `package.json`. A mismatch fails the job.

## Code of conduct

Be kind. Disagree about technical questions, not about people. Reports
of unacceptable behaviour: `conduct@` the maintainer's contact domain.
