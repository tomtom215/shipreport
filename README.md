# shipreport

Quarterly engineering success story generator.

Every quarter, managers spend hours stitching together commits, PRs, and reviews
to write success stories for each report. **shipreport** does the stitching for
them: point it at a GitHub org, pick a quarter, and it produces a draft success
story per developer plus a team highlight reel in under a minute.

Runs locally, in Docker, or as a scheduled GitHub Action. Works against
github.com and GitHub Enterprise Server. No data leaves your network if you
don't want it to.

---

## Quick start

```bash
# 1. Install
pnpm add -g shipreport            # or: npx shipreport

# 2. Create a fine-grained PAT with:
#    contents:read, issues:read, pull-requests:read, metadata:read, members:read
export SHIPREPORT_GITHUB_TOKEN=ghp_...

# 3. Point it at your org
shipreport run --config examples/shipreport.yaml
```

Outputs land in `./out/<quarter>/` as Markdown + HTML (+ optional PDF):

```
out/2026Q1/
├── asmith-2026Q1.md
├── asmith-2026Q1.html
├── blee-2026Q1.md
├── ...
├── team-summary-2026Q1.md
└── manager-rollup-2026Q1.md
```

See [`examples/sample-output/`](./examples/sample-output) for what the reports
actually look like.

---

## What it does (and doesn't)

| In scope                                       | Out of scope                          |
| ---------------------------------------------- | ------------------------------------- |
| GitHub.com + GHES (REST + GraphQL v4)          | GitLab, Bitbucket, Jira               |
| One quarter, one org, many repos               | Multi-quarter trend analysis          |
| Markdown + HTML + optional PDF                 | Web UI, dashboards, auth, webhooks    |
| Per-dev story + team summary + manager rollup  | Compensation / performance calibration |
| YAML config, env-var PAT                       | GitHub App flow, OAuth, multi-tenant  |
| Local SQLite cache (Node 22 built-in)          | Postgres / Redis / queues / schedulers |

**shipreport reports `filesTouched`, not LOC.** Lines of code is a metric you'd
game in the first week. Files touched captures scope without rewarding
copy-paste. Numbers come straight from the GitHub API; prose is deterministic —
a manager reviewing their team should be able to reproduce every number by hand.

---

## Commands

```bash
shipreport run       --config shipreport.yaml   # generate all reports
shipreport preview   --config shipreport.yaml --member asmith
shipreport cache     prune --config shipreport.yaml
shipreport doctor    --config shipreport.yaml   # probe token / GHES / puppeteer
```

`shipreport preview` prints a single dev's story to stdout — useful when you're
tuning classification labels.

---

## Config

See [`examples/shipreport.yaml`](./examples/shipreport.yaml). The token is
**never** read from the file; shipreport reads it from the env var named in
`github.tokenEnv` (default: `SHIPREPORT_GITHUB_TOKEN`).

Token scopes required (fine-grained PAT):

- `contents:read`
- `issues:read`
- `pull-requests:read`
- `metadata:read`
- `members:read`

For GHES, set `github.baseUrl` to `https://ghes.yourco/api/v3` and `graphqlUrl`
to `https://ghes.yourco/api/graphql`. A self-hosted Actions runner inside your
network means the token never leaves.

---

## Classification

Deterministic, no LLM:

1. **Labels first.** `bug`, `hotfix`, `p0`, `p1` → bugfix. `feature`,
   `enhancement` → feature. `ci`, `build`, `devops`, `infra` → infra. `docs`,
   `documentation` → docs. (All label lists are configurable.)
2. **Conventional-commit title prefix.** `feat:` → feature. `fix:` → bugfix.
   `refactor:` / `perf:` → refactor. `docs:` → docs. `ci:` / `build:` /
   `chore:` → infra.
3. Anything else → `other`.

Labels win over titles. See `src/classify.ts` for the exact rules; see
`tests/classify.test.ts` for the behavior guarantees.

---

## Run in Docker

```bash
docker build -t shipreport -f docker/Dockerfile .
docker run --rm \
  -e SHIPREPORT_GITHUB_TOKEN \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/out:/app/out" \
  shipreport run --config /cfg/shipreport.yaml
```

Add `--build-arg WITH_PDF=1` to include Chromium for PDF output.

---

## Scheduled as a GitHub Action

`.github/workflows/quarterly.yml` fires at 14:00 UTC on the first day of each
quarter. Put your PAT in a repo secret named `SHIPREPORT_TOKEN` and the reports
land as a run artifact. For GHES, swap to a self-hosted runner inside your
network.

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm test            # 42 tests, ~700ms
pnpm build
```

The render tests are **golden-file tests**: the rendered Markdown is compared
byte-for-byte against `tests/fixtures/*.md`. If you deliberately change a
template, run `UPDATE_GOLDEN=1 pnpm test` to regenerate.

Project layout:

```
src/
├── cli.ts           # citty entry point
├── config.ts        # Zod YAML schema
├── github.ts        # Octokit (REST + GraphQL) with retry + throttling
├── extract.ts       # pull PRs, reviews, issues for the quarter window
├── classify.ts      # label + conventional-commit → PR kind
├── transform.ts     # RawPR[] → DevQuarter → TeamQuarter
├── narrate.ts       # deterministic prose generators
├── render.ts        # Eta → Markdown → HTML → optional PDF
├── cache.ts         # node:sqlite ETag cache (zero native deps)
├── types.ts
└── templates/       # success-story, team-summary, manager-rollup
```

Target: <2,500 lines of TS. No native dependencies.

---

## License

MIT. See [LICENSE](./LICENSE).
