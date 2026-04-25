# 15 · FAQ

← [14 · Security](./14-security.md) · [Index](./README.md)

Quick answers. If yours isn't here, file an issue with the
`docs-question` label.

## How long does a quarterly run take?

10–60 seconds for a single team across 5 repos with PAT auth, on a
GitHub-hosted runner. Larger orgs: typically 1–5 minutes per team.
First run is slowest because the cache is cold.

## Can I run shipreport against private and public repos in the same config?

Yes — they all read through the same auth identity. The PAT or App just
needs read access to each.

## Can two operators run shipreport on the same org without stepping on each other?

Yes — they don't share state. Each has their own `~/.local/share/shipreport`
DB, their own cache, and their own audit chain. The numbers will be
identical (deterministic transform). The audit chains will diverge —
that's fine.

## How do I reset everything?

```bash
rm -rf ~/.local/share/shipreport ~/.cache/shipreport
```

This wipes the audit log, scheduler state, and extract cache. Next run
starts cold. **Do not do this on a host that's the source of compliance
evidence.**

## Can I make shipreport rewrite the prose with an LLM?

Out of scope by design. The prose is a manager-editable draft; numbers
must stay deterministic. If you want LLM rewriting, do it as a
post-processing step on the Markdown output — shipreport's templates
write static prose, then your LLM step transforms it into a final draft.

## Why per-team SQLite, not shared Postgres?

Local-first is a guardrail. SQLite means one operator can run a full
quarterly cycle on a laptop, with no infra to provision. The audit log's
hash chain works identically regardless of backing store — if you grow
out of SQLite, you'll hit the multi-tenant scope wall before the storage
wall.

## How do I add a new event to the audit log?

Add the event name to `AuditEvent` in `src/audit.ts`, add a unit test
that exercises the new event's `append`, and emit it from the relevant
codepath. The chain logic works for any string event name; the
TypeScript union just keeps callers honest.

## Can I drop the audit log entirely?

`audit.enabled: false` skips it. You lose:

* Hash-chained evidence (obviously).
* The scheduler's `last_run_at` (so `tick` always runs every team).
* The `cache_pruned` event (functionally — `cache prune` still runs).

Don't disable it in any environment that's under compliance scrutiny.

## Does shipreport work on Node ≤ 23?

No. We require Node 24 for stable `node:sqlite`. If your runner pins to
an older Node, run shipreport via Docker.

## Can I use shipreport to score people for performance reviews?

No. Per-PR scoring is explicitly out of scope. The numbers are a fact
sheet; the calibration conversation is human. Several rejected feature
requests in `README.md`'s "Scope traps" section spell this out.

## How do I ship the audit log to Loki / Splunk / Datadog?

Cron `shipreport audit export --since <ISO> --format jsonl` and pipe to
your shipper. The JSONL format is one row per line, chain-ordered,
including hashes. Re-verify with `verifyJsonl()` (exported from
`src/audit-export.ts`) at the destination.

## Why does the manager rollup Markdown look different from the per-dev page?

Different templates, on purpose. The per-dev page is a calibration story
for one person; the rollup is a one-page committee pre-read. See the
templates at `src/templates/*.eta` and the Eta docs for changes.

## Can I keep the same config file for two different orgs?

Not in one file. Run two configs, two workflows, two state DBs. The
`org:` field is single-valued per config.

## What's the upgrade story across versions?

Patch and minor (`0.X.Y`): drop-in. Major: see `CHANGELOG.md` (TBD on
v1). The audit log schema is versioned via the `prev_hash` chain — no
migration needed unless we change the canonical-form algorithm, which
would break every existing chain anyway.

## Is there a managed SaaS version?

No.

## How do I contribute?

PRs welcome. Run `pnpm install && pnpm test:coverage && pnpm lint &&
pnpm typecheck` locally before opening one. The CI gate is 90% coverage
for `src/`. New `defaults.*` fields need a Zod default and a unit test.

## Where do I file a bug?

`https://github.com/tomtom215/shipreport/issues`. Include:

* `shipreport doctor` output (redact tokens — there shouldn't be any in
  the output, but double-check).
* The exact CLI invocation that failed.
* The relevant section of `shipreport audit tail --json --limit 10`.

That's enough for almost any reproduction.
