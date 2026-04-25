# 12 · Audit log (SOC2)

← [11 · Local cron](./11-deployment-local-cron.md) · [Index](./README.md) · Next → [13 · Troubleshooting](./13-troubleshooting.md)

shipreport's audit log is **the** compliance evidence trail. Every run,
every report written, every token resolution or renewal, every scheduled
trigger, every rate-limit degradation, appends one row to a local SQLite
table. The table is hash-chained, append-only at both the Node API and
SQLite trigger layer, and exportable as signed evidence.

If a SOC2 auditor asks "show me that the report we read on April 30th
was generated from API data fetched on April 28th, with no in-between
edits", this is the answer.

## Schema

`audit_log` has these columns:

| Column        | Type    | Meaning                                                              |
| ------------- | ------- | -------------------------------------------------------------------- |
| `seq`         | INTEGER | AUTO-INCREMENT primary key, monotone.                                |
| `at`          | TEXT    | RFC3339 UTC timestamp.                                               |
| `actor`       | TEXT    | Identity (never a secret). E.g. `app:123:install:456`.               |
| `event`       | TEXT    | One of the supported event names (below).                            |
| `target`      | TEXT    | Org/team or file path. May be NULL.                                  |
| `payload`     | TEXT    | JSON blob. Caller-controlled; never secrets.                         |
| `prev_hash`   | TEXT    | sha256 of the previous row's canonical form.                         |
| `hash`        | TEXT    | sha256 of this row's canonical form (sorted keys, no whitespace).    |

The first-ever row's `prev_hash` anchors at sha256 zero
(`0000…0000`, 64 chars).

## Events

| Event                    | Written when                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- |
| `config_loaded`          | The CLI parsed `shipreport.yaml` and is about to dispatch.                    |
| `run_started`            | `runTeam()` enters its work loop.                                             |
| `run_completed`          | `runTeam()` finishes successfully (carries `counters` payload).               |
| `run_failed`             | `runTeam()` threw — error message in payload.                                 |
| `token_resolved`         | `tokenSourceFromConfig` returned a token.                                     |
| `token_renewed`          | `createAppTokenSource` re-minted an installation token (50-min boundary).     |
| `schedule_triggered`     | `tick` decided to run a team.                                                 |
| `report_written`         | `writeReport` finished writing one file path.                                 |
| `cache_pruned`           | `cache prune` swept TTL-aged rows.                                            |
| `members_discovered`     | `discoverMembers` produced a member list (ranking + skipped bots in payload). |
| `rate_limit_degraded`    | `RateLimitGuard` flipped to serial mode.                                      |
| `extract_checkpointed`   | A mid-extract checkpoint was written.                                         |

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

## Hash chain

Each row's `hash` is computed as:

```text
canonical = JSON.stringify({ at, actor, event, target, payload, prevHash })
            with object keys sorted recursively, no whitespace
hash      = sha256(canonical)
```

`prev_hash` is the previous row's `hash`, or 64 zeros for the first row.

Tampering — editing any column, deleting any row, reordering rows —
breaks the chain at the modified row's `prev_hash` or the modified row's
`hash`. `shipreport audit verify` walks the chain and reports the broken
seq.

## Defense in depth

Two layers enforce the append-only invariant:

1. **Node layer**. The `AuditLog` class exposes only `append()`,
   `tail()`, `readForward()`, `head()`, and `verify()`. There is no
   UPDATE or DELETE codepath.
2. **Storage layer**. SQLite `BEFORE UPDATE` and `BEFORE DELETE`
   triggers on `audit_log` `RAISE(ABORT, ...)`. An operator with raw DB
   access can't mutate a row via standard SQL — they get
   `audit_log is append-only (UPDATE rejected)`.

A property-based fast-check test (`tests/audit-property.test.ts`) drives
random append + mutation sequences and asserts that triggers and
`verify()` agree on every case.

## CLI commands

```bash
shipreport audit tail --limit 50              # most recent N rows (default 50)
shipreport audit tail --since 2026-04-01      # rows with at >= ISO date
shipreport audit tail --json                  # JSON output
shipreport audit verify                       # walk the chain, exit 1 on break
shipreport audit export --format jsonl        # NDJSON, one row per line
shipreport audit export --since 2026-04-01    # incremental export
shipreport audit snapshot                     # signed manifest of the chain head
```

`audit verify` is fast: ~200k rows/sec on a Pi. Run it daily as part of
your CI / cron.

## Streaming evidence: JSONL export

`audit export --format jsonl` emits rows in chain order:

```jsonl
{"seq":1,"at":"2026-04-15T14:00:00Z","actor":"cli:run","event":"config_loaded",…}
{"seq":2,"at":"2026-04-15T14:00:01Z","actor":"pat:env:SHIPREPORT_GITHUB_TOKEN",…}
```

A downstream verifier replays this with `verifyJsonl()`. It needs only
the genesis zero hash (or any anchor hash for incremental exports). The
`audit-export.yml` workflow runs daily, signs a chain-head snapshot, and
uploads both as artifacts.

## External anchoring: `audit snapshot`

`audit snapshot` produces a signed (ed25519) manifest:

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

Anchor it outside the host running shipreport — git, S3 Object Lock, a
transparency log. Any later attempt to lop rows off the tail of the
audit log is caught: the snapshot's `chainHeadSeq` / `chainHeadHash` no
longer match, and the ed25519 signature proves the snapshot itself is
authentic.

The signing key lives at `audit.signingKeyPath`
(default `~/.config/shipreport/audit-ed25519.pem`). If missing,
shipreport generates one at mode `0600` on first `audit snapshot`.
Rotate with standard OpenSSL or `ssh-keygen` tooling.

## Operator runbook

A practical evidence pipeline for SOC2:

1. Daily: GH Action `audit-export.yml` exports JSONL + signed snapshot,
   uploads both as artifacts (365 d retention).
2. Weekly: dump the artifacts to your S3 Object Lock bucket.
3. Quarterly (audit time): the auditor wants proof. Pull the JSONL
   exports for the period; re-verify offline with `verifyJsonl()`; cross-
   check the signed snapshot against the bucket's WORM-protected object.
4. After every operator change (off-boarding etc): manually run
   `shipreport audit snapshot > backup.json` and check it into your
   compliance repo.

## When the chain breaks

`audit verify` returns:

```text
BROKEN at seq 1042: row hash mismatch
```

This is bad. Investigation steps:

1. **Don't write to the DB.** Stop the scheduler.
2. Pull the latest external snapshot. Compare `chainHeadSeq` and
   `chainHeadHash`.
3. If the snapshot is older than the break, the rows between snapshot
   and break are unverifiable; treat them as untrustworthy and
   investigate the host.
4. If the snapshot matches the break, the host has been compromised;
   trigger your incident response.

The snapshot's signature is the safety net: even a determined attacker
can't forge a snapshot without the ed25519 private key, so as long as
that key isn't on the same host (or has been rotated), you have ground
truth.

Continue → [13 · Troubleshooting](./13-troubleshooting.md).
