# 08 · Dry-run methodology

← [07 · Scheduling](./07-scheduling.md) · [Index](./README.md) · Next → [09 · GitHub Actions](./09-deployment-github-actions.md)

shipreport has three layers of "do this without breaking things" tooling.
Use them in order, smallest-blast-radius first.

| Layer            | What it covers                                          | Network? | Auth? | Time   |
| ---------------- | ------------------------------------------------------- | -------- | ----- | ------ |
| Schema validate   | shipreport.yaml parses and crons are valid.             | No       | No    | <1s    |
| `doctor`          | Auth, reachability, DB layout, optional puppeteer.      | Yes      | Yes   | ~3s    |
| `--dryRun`        | Full pipeline (transform + render) over cached PRs.     | No       | No    | ~10s   |

A safe "first scheduled run" plan is: schema → doctor → dry-run → real
run. The full GH Actions pipeline already runs schema and doctor as
preflight; you can add dry-run on demand.

## Layer 1: schema validation

```bash
node scripts/validate-config.mjs shipreport.yaml
```

Output:

```text
OK — 2 team(s) parsed against schema.
  team=checkout cron='0 14 1 1,4,7,10 *' OK
  team=platform cron='0 9 * * 1' OK
```

What it catches:

* Missing required fields.
* Invalid cron syntax (6 fields, named days, etc.).
* Bad date ranges (`from` after `to`).
* Repos that aren't `owner/repo` shape.
* Quarter labels that aren't `YYYYQ[1-4]`.

What it does NOT catch:

* Repos that don't exist.
* Tokens that won't auth.
* Network reachability.

The PR-time workflow (`validate-config.yml`) runs this on every PR that
touches `shipreport.yaml` or any workflow. No secrets needed.

## Layer 2: `shipreport doctor`

```bash
shipreport doctor --config shipreport.yaml
```

Output:

```text
Auth kind:        pat
Identity:         pat:env:SHIPREPORT_GITHUB_TOKEN
Authenticated as: jdoe
Token scopes:     (fine-grained PAT or App installation)
GHES version:     github.com
Base URL:         https://api.github.com
Cache path:       /home/runner/.cache/shipreport/cache.sqlite
Audit enabled:    true
State path:       /home/runner/.local/share/shipreport/state.sqlite
Teams:            checkout, platform
Scheduled teams:
  checkout: 0 14 1 1,4,7,10 *
  platform: 0 9 * * 1
```

(The `Token scopes:` line varies by auth type — classic PATs return a
comma-separated list like `repo, read:org`; fine-grained PATs and App
installation tokens trigger the parenthetical fallback shown above. See
[02 · Quickstart, Step 5](./02-quickstart.md#step-5--smoke-test-with-doctor-mode)
for the canonical reference.)

What it catches:

* PAT/App not configured.
* PAT lacks scopes.
* App not installed on the org.
* GHES URL typos (auth fails).
* `puppeteer` missing when a team requests `pdf`/`png`.

What it does NOT catch:

* Repos that the auth identity can't read (each repo is hit by `extract`,
  not by `doctor`).

`doctor` is cheap (one `/user` GET, one `rate_limit` probe). It's the
first step every `tick.yml` job runs, so failed configurations fail in
seconds — before any extract burn.

## Layer 3: `--dryRun`

```bash
shipreport run --config shipreport.yaml --all --dryRun
```

Behaviour:

* No network calls. The github client is never even instantiated.
* For each repo × quarter, look up the cached extract snapshot.
* If any repo has a cold cache, **throw** with a clear message:
  `--dry-run set but no cached snapshot for <repo> @ <quarter>; run once
  without --dry-run to warm the cache.`
* Otherwise, run the entire transform → render pipeline.
* Write reports to `out/`. The audit log gets a `dryRun: true` flag on
  the `run_started` and `run_completed` rows.

What it catches:

* Template changes that mangle the rendered Markdown.
* Classification rule changes that misclassify cached PRs.
* Co-author credit changes (`full` vs `split`) and their downstream
  effects.
* Output directory writability.

What it does NOT catch:

* New PRs since the last warm extract — by definition.

### Workflow: warm cache locally, dry-run on every PR

A common pattern when you're iterating on classification labels:

```bash
# Warm cache: one real run, only have to do this once per quarter
SHIPREPORT_GITHUB_TOKEN=ghp_… \
  shipreport run --config shipreport.yaml --team checkout

# Iterate: edit shipreport.yaml's classification.bugfixLabels …
shipreport run --config shipreport.yaml --team checkout --dryRun

# Diff the rendered Markdown against the previous run
diff out/asmith-2026Q1.md /tmp/asmith-2026Q1.md.before
```

This pattern needs no token after the warm step — useful for sharing a
config-tuning loop with someone who doesn't have a PAT.

### Workflow: dry-run from GH Actions

Use the bundled `tick.yml`:

* `Actions → shipreport-tick → Run workflow`
* `mode: dry-run`
* (Optional) `team: <name>` and `quarter: <YYYYQn>`.

The workflow uses the cached state DB from prior runs as the cache
warm-up. If the cache is cold, the dry-run will fail loudly — that's the
point.

## When to combine the layers

| Scenario                                   | Layers to use                              |
| ------------------------------------------ | ------------------------------------------ |
| Adding a new team to `shipreport.yaml`     | Schema → doctor (PR time) → real run.      |
| Changing classification labels             | Schema → dry-run.                          |
| Editing an Eta template                    | Dry-run only — schema and doctor unchanged. |
| Rotating a token                           | Doctor only — no need to re-extract.       |
| Suspect rate-limit issue                   | Real run with `--verbose`; not a dry-run.  |
| Testing a tz / DST edge case               | Schema → dry-run with `--quarter 2025Q4`.  |

## Audit trail

Every `--dryRun` run writes:

```json
{ "event": "run_started",   "payload": { "dryRun": true, ... } }
{ "event": "run_completed", "payload": { ... } }
```

So you can post-hoc tell which runs were dry vs real. There's no
`token_resolved` row on a dry-run because no token is touched.

Continue → [09 · GitHub Actions](./09-deployment-github-actions.md).
