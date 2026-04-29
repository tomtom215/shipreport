# 00 · Overview

← [Index](./README.md) · Next → [01 · Prerequisites](./01-prerequisites.md)

shipreport reads merged-PR data from one or more GitHub repositories and
emits **per-developer, per-team, and per-manager** Markdown reports for a
chosen quarter. It's a CLI plus a SOC2-oriented audit log; there is no web
UI, no daemon, and no database beyond local SQLite.

## What it produces

For a team of N developers, one quarter, default config:

```text
out/
├── alice-2026Q1.md                       # one per dev (the "success story")
├── alice-2026Q1.html
├── bob-2026Q1.md
├── …
├── team-summary-checkout-2026Q1.md       # team highlight reel
└── manager-rollup-checkout-2026Q1.md     # one-page calibration pre-read
```

PDF and PNG outputs are opt-in: `puppeteer` is **not** in shipreport's
default install — operators who need them run `pnpm add puppeteer`
(~400 MB Chromium). See [06 · Configuration reference](./06-config.md).

## What it counts

Numbers are deterministic and label-driven; prose is templated and
manager-editable. Per dev, per quarter:

* `prsMerged` (split or full credit for co-authored PRs)
* `prsByKind` (feature / bugfix / refactor / docs / infra / other)
* `revertsAuthored`, `revertsReceived`
* `filesTouched`, `crossRepoCollaboration`
* `reviewsGiven` (substantive reviews on teammates' PRs)
* `linkedIssuesClosed`, `shippedMilestones`
* `topPRs` (ranked by `reviewCount*3 + commentCount + linkedIssues*2`)

Inputs are: `merged` PRs whose base ref is the repo's default branch, in
the configured quarter window, in the configured timezone.

## Run modes

| Mode                                | Where it lives                                              |
| ----------------------------------- | ----------------------------------------------------------- |
| Local CLI                           | `node bin/shipreport.js run --config shipreport.yaml --all` |
| Docker                              | `docker run … shipreport run --config /cfg/… --all`         |
| **Scheduled GitHub Action**         | `.github/workflows/tick.yml` (recommended once you push to GitHub) |
| Reusable GH Action                  | `.github/workflows/reusable-shipreport.yml`                 |
| systemd timer / Kubernetes CronJob  | Calls the same CLI; see [11](./11-deployment-local-cron.md) |

**For ZIP-delivered installs, start with the local CLI** — it has the
fewest moving parts and works without any GitHub Actions setup. See
[`HANDOFF.md`](../HANDOFF.md) at the repo root for the bootstrapping
walkthrough.

GitHub Actions is the most batteries-included deployment for operators
who already own a GitHub repo where they want shipreport's workflows to
live: auth, secrets, scheduling, artifact retention, and the audit-log
evidence pipeline are all native. The other modes (local CLI, Docker,
systemd) are documented for completeness and are first-class — none of
them is a downgrade.

## What it deliberately doesn't do

| Out of scope                                   | Why                                                          |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Per-PR "performance score"                     | Calibration is a human conversation; numbers are an aid.    |
| LLM rewriting of numbers                       | Numbers must be reproducible to be evidence-grade.           |
| Trend engines / rolling windows                | One-quarter-ago comparison only.                             |
| Webhooks, daemon, HTTP server                  | One YAML, one CLI, one SQLite file.                          |
| Jira / Linear / Slack integration              | Out of scope — pipe Markdown to whatever you want.           |
| Multi-tenant SaaS hosting                      | Out of scope — local-first by design.                        |

If your use case isn't on the supported list, this is the wrong tool;
look at LinearB, Jellyfish, or Code Climate Velocity.

## Architectural sketch

```text
shipreport.yaml ─┐
                 ▼
            ┌─────────┐    GraphQL    ┌────────────┐
            │ extract │ ─────────────▶│  github.com│   (or GHES)
            └────┬────┘                └────────────┘
                 │  RawPR[]
                 ▼
            ┌─────────┐
            │transform│  → DevQuarter / TeamQuarter
            └────┬────┘
                 ▼
            ┌─────────┐
            │ render  │  → Markdown → HTML → optional PDF/PNG
            └────┬────┘
                 ▼
              out/

         ┌────────────┐
         │ audit log  │  every step appends a hash-chained row
         │ (SQLite)   │
         └────────────┘
```

* **Extract** is bounded-concurrency, rate-limit-aware, and incremental.
* **Transform** is pure: same RawPR[] in → same DevQuarter out.
* **Render** is Eta templates (manager-editable) + markdown-it.
* **Audit log** is append-only at both the Node API and the SQLite layer.

Keep going → [01 · Prerequisites](./01-prerequisites.md).
