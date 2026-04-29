# Security Policy

This file is **owner-customizable** — you (the operator who received
this code) should set the contact details below to match your team's
incident-response process before relying on shipreport in production.
Search for `EDIT:` markers and replace each one.

## Reporting a vulnerability

Do **not** open a public issue for security findings. Use one of:

1. **EDIT — preferred private channel.** Examples: a GitHub security
   advisory if you've forked this code into a GitHub repository
   (`https://github.com/<your-org>/<your-fork>/security/advisories/new`),
   a private email alias (`security@your-domain`), or a ticketing
   queue your security team owns.

2. **EDIT — fallback channel.** A second mechanism in case the first
   is unreachable.

Please include:

- A description of the issue and its impact.
- A minimal reproduction (config snippet, exact CLI invocation,
  expected vs. observed behaviour).
- The output of `node --version` and `pnpm --version`.
- The shipreport version (`node bin/shipreport.js --version` or the
  `version` field of `package.json`).
- If the issue concerns the audit log or signing path: a copy of the
  affected `audit_log` rows (with secrets redacted) and the
  `audit verify` output.

EDIT — your team's acknowledgement and remediation SLAs go here.
A reasonable starting point:

> We aim to acknowledge reports within 3 business days and to issue a
> fix or coordinated-disclosure timeline within 14 calendar days for
> high/critical issues, 30 calendar days for lower severity.

## Supported versions

shipreport follows [semantic versioning](https://semver.org/). Decide
on your own back-port window — a common starting point:

| Version           | Status                                       |
| ----------------- | -------------------------------------------- |
| 0.2.x             | Supported (current).                         |
| 0.1.x             | Best-effort only.                            |
| < 0.1             | Unsupported.                                 |

Pin to a specific minor in production so a security patch lands as a
patch-level bump, not a surprise minor.

## Threat model

The complete threat model is documented at
[`docs/14-security.md`](./docs/14-security.md). Summary:

- shipreport is **read-only** against GitHub. It has no write paths.
- It runs as a local CLI; there is no network listener and no daemon.
- The audit log is **append-only** at both the Node API and the SQLite
  trigger layer.
- Secrets (PATs, App private keys) are read once per run and never
  persisted.

Out of scope:

- An operator who controls both the host and the external snapshot store
  can defeat audit-log anchoring. Mitigation: keep the ed25519 signing
  key off the shipreport host; anchor snapshots to a WORM target.
- shipreport does not scrub PR bodies for secrets. If your developers
  paste credentials into PR descriptions, those credentials appear in
  the rendered Markdown reports.

## Coordinated disclosure

If you'd like a CVE assigned, request one through your private channel
above. EDIT — describe how you'll coordinate disclosure (your security
team, a national CERT, MITRE direct, etc.).

## Cryptographic primitives

- **Hash chain**: SHA-256 over canonical JSON (sorted object keys, no
  whitespace). The exact serializer is at `src/audit.ts:canonicalize`.
- **Snapshot signing**: ed25519 (Node `node:crypto`). 32-byte private
  key, 32-byte public key, 64-byte signature. PEM-encoded.
- **Token transit**: HTTPS to `api.github.com` (or your GHES). TLS
  verification cannot be disabled.

If a primitive is later broken (e.g. SHA-256 collision), shipreport's
`canonicalize` + algorithm name should be revised in a major release;
existing chains remain verifiable under their original algorithm.
