# Contributing

This document is preserved as a reference for the engineering norms the
codebase was built under. **You — the operator who received this code —
are now its sole owner.** There is no upstream you push PRs back to;
"contributing" here means making changes inside your own copy.

## Local development

```bash
pnpm install           # honors engines (Node >=22.13, pnpm >=10 <11)
pnpm typecheck         # tsc --noEmit
pnpm lint              # eslint src tests
pnpm test              # vitest (~10 s on a typical laptop)
pnpm test:coverage     # vitest with v8 coverage; gates set in vitest.config.ts
pnpm build             # tsc + copy templates → dist/
```

`.nvmrc` is `24` — the local-development anchor and the version Docker
+ CI track. The minimum supported Node is `22.13.0` (where
`node:sqlite` was unflagged). If you `nvm use` from this repo you'll
land on 24, which is fine.

The bundled CI workflows under `.github/workflows/` run the same gates
on every PR (or push, if you keep this code in a private repo) plus a
Node-version matrix (`22.13`, `24`, `25`), `pnpm audit --prod
--audit-level=high`, actionlint, markdownlint, and the
`scripts/validate-config.mjs` check.

## Scope guardrails

The project is narrow on purpose. The list below records the original
scope decisions; you can change any of them, but understand what you're
giving up before you do.

| In scope                                       | Rejected (read first if proposing it) |
| ---------------------------------------------- | ------------------------------------- |
| Bug fixes with a regression test.              | Web UI / dashboard / SaaS hosting.    |
| New `defaults.*` fields with Zod default.      | LLM rewriting of numbers.             |
| New event names in the audit log.              | Trend engines beyond one-quarter-ago. |
| New deployment recipes in `docs/`.             | New backing stores (Postgres, Redis). |
| Performance work for `extract.ts`.             | Per-PR scoring / calibration ranking. |
| Better classification heuristics.              | Daemon mode / webhook ingestion.      |
| Additional GH Actions caller examples.         | Slack / Jira / Linear integrations.   |

The "Rejected" column maps to `README.md`'s "Scope traps" section —
those are decisions, not open questions.

## Internal change checklist

Even without an external review process, work through this list before
committing:

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
- [ ] No new dependencies unless the alternative is significantly
      worse. Native dependencies are essentially never appropriate
      (`node:sqlite` and the `node:crypto` ed25519 path exist precisely
      so we don't need `better-sqlite3` / `sodium-native`).

## Coverage policy

Per-file thresholds (set in `vitest.config.ts`) keep individual files
honest:

- `src/audit.ts`, `src/audit-export.ts`, `src/sign.ts`, `src/state.ts` —
  100% lines / 100% functions / 100% statements; branches at 95% / 90% /
  85% / 90% respectively. These are the SOC2 evidence path.
- Everything else — 95% lines / 95% functions / 85% branches /
  95% statements globally.

If you add a file, add a row to the per-file `thresholds` block in
`vitest.config.ts`. If you can't reach the floor, the right move is
almost always splitting the file or adding a test — not lowering the
floor.

## Commit style

Conventional-commit prefixes are optional but appreciated:

- `feat(extract): …` for new functionality.
- `fix(audit): …` for bug fixes.
- `docs: …` for doc-only changes.
- `chore(ci): …` for CI / tooling changes.

The bundled `release.yml` doesn't parse commit messages; the changelog
is hand-curated in `CHANGELOG.md`.

## Releasing (only if you republish this code)

The bundled `release.yml` workflow is configured to publish to npm and
GitHub Container Registry under whatever GitHub repo it's pushed to.
**It will not work as-is** — `package.json`'s `name` field is
`shipreport`, which is taken on the public npm registry; you must
either rename the package (e.g. to `@your-scope/shipreport`) or remove
the npm-publish job. Similarly, the GHCR push targets
`ghcr.io/${GITHUB_REPOSITORY}` — that becomes your repo path once you
push the source somewhere.

If you don't republish, the CI gates are still useful — keep
`ci.yml`, drop or disable `release.yml`.

The original release flow:

1. Bump `package.json`'s `version` field.
2. Update `CHANGELOG.md` under a fresh `## [X.Y.Z] - YYYY-MM-DD` heading.
3. Tag: `git tag v<X.Y.Z> && git push origin v<X.Y.Z>`.
4. The release workflow gates on the test matrix, then publishes:
   - npm package with `--provenance` (sigstore via GitHub OIDC),
   - multi-arch (`linux/amd64`, `linux/arm64`) Docker image to GHCR,
   - cosign keyless signature over the image digest,
   - CycloneDX SBOM attached to the GitHub release.

The tag's version must match `package.json`'s; a mismatch fails the job.
