# 14 · Security model

← [13 · Troubleshooting](./13-troubleshooting.md) · [Index](./README.md) · Next → [15 · FAQ](./15-faq.md)

shipreport is read-only against GitHub and write-only-with-rules against
the local audit DB. This page is the threat model and the controls that
back it up.

## Threat model

| Threat                                                          | Mitigation                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Stolen PAT / App key → exfiltrate org data                       | Read-only scopes; no write paths; auditable via GitHub's own audit log.             |
| Operator with shell access edits historical reports              | Out of scope — shipreport doesn't claim report immutability. Use the audit DB.      |
| Operator with shell access edits the audit DB                    | SQLite triggers + chain hash + signed snapshot anchored externally.                 |
| Long extract → installation token expires mid-run                | App tokens auto-renew at 50-min boundary; failure modes are loud.                   |
| Malicious PR body / label triggers RCE in the renderer           | markdown-it config disables HTML; Eta autoescape is off but inputs are not eval'd.  |
| Supply-chain compromise of a transitive dep                      | `pnpm audit --prod --audit-level=high` in CI; npm provenance for releases.          |
| Image-registry compromise (someone retags `shipreport:0.2.0`)    | Releases are cosign-keyless-signed; verify before pulling.                          |
| Audit log tampering by physical disk swap                        | External signed snapshot; chain re-verifies offline against the snapshot.           |
| Render template change silently changes numbers                  | Render templates are output-only; numbers come from `transform.ts`. Numbers test in CI. |

## Out of scope

* shipreport does **not** protect against an operator who controls both
  the host and the external snapshot store. The control is: keep the
  ed25519 signing key off the shipreport host.
* shipreport does **not** scrub PR titles / bodies for secrets. If your
  developers paste credentials into PR descriptions, those credentials
  appear in your reports. Out of scope.

## Secrets handling

* **Never logged**. The `actor` field is identity only. The Octokit
  client wraps the token internally. No log line, no audit row, no
  rendered report contains a token.
* **Read once, never written**. Tokens are read from env or file at
  start-of-run; shipreport never persists them.
* **App token lifecycle**: minted lazily, cached in-memory only, re-
  minted at 50 min. Process exit zeroes the cache.

If you're worried about a Node memory dump exposing a token: that's a
real risk. Mitigations:

* Run shipreport in a dedicated container (Docker / K8s).
* Don't run privileged side-loaded debug tools on the host.
* Rotate tokens on suspicion of compromise.

## Input validation

| Input                                | Validated by                                  |
| ------------------------------------ | --------------------------------------------- |
| `shipreport.yaml`                    | Zod schema (`config.ts`).                     |
| Cron expressions                     | `parseCron` in `schedule.ts`.                 |
| GraphQL responses                    | Statically typed; type narrowed at boundaries.|
| PR titles / bodies                   | Treated as untrusted strings.                  |
| PR labels                            | Same.                                         |
| Co-author email parsing              | Whitelisted regex; non-matching fall back to author. |

## Output safety

* **Markdown rendering** uses markdown-it with `html: false`. Any HTML
  embedded in a PR body is escaped, not rendered.
* **HTML output** uses an HTML escaper for the title only; the body is
  the markdown-it output (which already escapes raw HTML).
* **PDF / PNG** rendering uses puppeteer. The Chromium sandbox is
  **left enabled by default** on bare-metal hosts; shipreport drops
  `--no-sandbox --disable-setuid-sandbox` only when the renderer
  detects `/.dockerenv` (running inside a container) or the operator
  has set `SHIPREPORT_NO_SANDBOX=1` (explicit opt-in for environments
  where the sandbox is incompatible with the runtime). Don't point
  puppeteer at untrusted external HTML.

The full path: `RawPR (string) → markdown-it (no HTML) → HTML →
Chromium (sandboxed) → PDF/PNG`. The only place untrusted text reaches
Chromium is wrapped in a `<pre>` or escaped by markdown-it.

## Supply chain

| Layer                       | Control                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| pnpm lockfile               | `pnpm install --frozen-lockfile` in CI and Docker.                       |
| `pnpm audit --prod`         | CI gate; fails the build on any high/critical CVE.                       |
| Dependabot                  | Weekly updates for both npm and Docker base image.                       |
| npm package                 | Published with `--provenance`. Verify with `npm audit signatures`.       |
| Docker image                | Multi-arch, cosign-signed keyless via Sigstore.                          |
| SBOM                        | CycloneDX JSON via syft, attached to each GitHub release.                |
| Optional `puppeteer` dep    | Not declared in `package.json`; absent from a default `pnpm install`. Operators who need PDF/PNG output run `pnpm add puppeteer` explicitly (see `docs/06-config.md`). |

## Operator access patterns

Recommended:

* **Audit log host** is the shipreport runner. `~/.local/share/shipreport`
  has mode `0700`. Only the `shipreport` user reads/writes.
* **Signing key host** is **not** the audit log host. Either:
  * a separate machine that pulls the chain head and signs offline, or
  * the GH Actions runtime (key in a secret), with the snapshot artifact
    sent to a WORM bucket.
* **WORM target** (S3 Object Lock, Loki, transparency log) is owned by
  the compliance team, not the engineering team.

## Network egress

Only outbound. Hosts:

* `api.github.com` (or `<ghes>.example.com/api/v3`)
* `<ghes>.example.com/api/graphql`
* `registry.npmjs.org` — only at install time. Lock down at runtime.
* If `puppeteer` is installed: it doesn't fetch at runtime.

No telemetry, no analytics, no third-party APIs.

## CSP / sandboxing for HTML output

The bundled HTML output has no JS, no external resources, no fonts. It's
safe to host directly. If you serve it through a strict CSP gateway:

```text
default-src 'none';
style-src 'unsafe-inline';     # the bundled <style> block
img-src 'self' data:;          # only relevant if you embed images yourself
```

(`'unsafe-inline'` for `style-src` only — the bundled style block is
hand-authored, not user-controlled.)

## Reporting security issues

Email the maintainer (see GitHub profile) with a description and a
minimal reproduction. Do **not** open a public issue for security
findings.

Continue → [15 · FAQ](./15-faq.md).
