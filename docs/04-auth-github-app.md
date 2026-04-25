# 04 · Auth: GitHub App

← [03 · Auth: PAT](./03-auth-pat.md) · [Index](./README.md) · Next → [05 · Auth: GHES](./05-auth-ghes.md)

GitHub App auth is the recommended path for enterprise deployments:
installation tokens are short-lived (1 hour), scoped to specific repos,
auto-renewed mid-run by shipreport, and survive operator turnover better
than a PAT tied to one engineer.

If you're at "single operator, ≤5 repos" scale, [03 · PAT](./03-auth-pat.md)
is fine and faster to set up.

## Why an App, not a PAT

| Property                              | PAT                                       | GitHub App                                        |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------- |
| Tied to a person                      | Yes (creator)                             | No (App identity)                                 |
| Survives operator turnover            | No                                        | Yes                                               |
| Token lifetime                        | Up to 1 year                              | 1 hour, auto-renewed                              |
| Per-repo scoping                      | Yes (fine-grained)                        | Yes (installation-level)                          |
| Org-policy auditable                  | Yes                                       | Yes (richer audit trail)                          |
| Setup time                            | 5 min                                     | 15 min                                            |

## Step 1 — Create the App

1. Visit `https://github.com/organizations/<org>/settings/apps/new`
   (replace `<org>`; you must be an org owner).
2. **Name**: `shipreport-<env>` (e.g. `shipreport-prod`).
3. **Homepage URL**: anything; not used by shipreport.
4. **Webhook**: **Active** unchecked. shipreport doesn't use webhooks.
5. **Repository permissions**:
   * Contents → Read-only
   * Issues → Read-only
   * Metadata → Read-only (mandatory)
   * Pull requests → Read-only
6. **Organization permissions**:
   * Members → Read-only (only if you want auto-discovery; can be omitted).
7. **Where can this GitHub App be installed?**: "Only on this account."
8. Click **Create GitHub App**. Note the **App ID** at the top of the
   resulting page (e.g. `123456`).

## Step 2 — Generate a private key

On the App's settings page, scroll to **Private keys → Generate a private
key**. A `.pem` file downloads.

Treat this file like a password. Store options:

* **GitHub Actions**: as a repo or org secret named
  `SHIPREPORT_APP_PRIVATE_KEY`. Paste the entire PEM including the
  `-----BEGIN/END-----` lines. Newlines (literal or `\n`-escaped) are
  both fine.
* **Local / Docker**: a file on disk at mode `0600`, referenced via
  `github.app.privateKeyPath` in `shipreport.yaml`.

## Step 3 — Install the App on the org

App owner ≠ App installation. After creating the App, you have to install
it onto the org:

1. App settings → **Install App** (sidebar).
2. Click **Install** next to your org.
3. **Repository access**: pick the repos in your shipreport.yaml's
   `repos:` list. Or "All repositories" if you'd rather not maintain it.
4. Confirm.

Note the **Installation ID** in the resulting URL (e.g.
`/organizations/acme-eng/settings/installations/7890123` →
installation ID is `7890123`). You can also let shipreport auto-discover
this — see step 4.

## Step 4 — Configure shipreport

```yaml
github:
  app:
    appId: 123456
    privateKeyEnv: SHIPREPORT_APP_PRIVATE_KEY     # PEM in env var (GH Actions path)
    # privateKeyPath: /etc/shipreport/app.pem    # OR file on disk (local / Docker path)
    # installationId: 7890123                    # optional; auto-discovered if absent

org: acme-eng
```

Either `privateKeyEnv` **or** `privateKeyPath` — not both. shipreport will
throw a clear error if you set neither.

If `installationId` is absent, shipreport will look it up from the org via
the App-level JWT on the first run. The discovered ID is not persisted;
it's just looked up each cold start.

If both `app:` and `tokenEnv` are configured, App auth wins.

## Step 5 — Verify with `doctor`

```bash
shipreport doctor --config shipreport.yaml
```

Expected output:

```text
Auth kind:        app
Identity:         app:123456:install:7890123
Authenticated as: shipreport-prod[bot]
Token scopes:     (fine-grained PAT or App installation)
```

If `Authenticated as` is empty, the App private key is malformed (most
common cause: missing newlines after pasting into a secret manager).

## How shipreport handles long extracts

Installation tokens are 1-hour. A run that scans hundreds of repos can
plausibly span more than an hour. shipreport's `TokenSource` abstraction:

* mints the first token lazily, on first GraphQL call,
* re-mints a fresh token after 50 minutes (`DEFAULT_RENEW_AFTER_MS`),
* writes a `token_renewed` row to the audit log on every renewal.

You'll see lines like this in the audit tail:

```json
{ "event": "token_resolved", "actor": "app:123456:install:7890123" }
{ "event": "token_renewed",  "actor": "app:123456:install:7890123" }
```

This is by design — the renewal is the audit trail.

## Audit log entries

Every run resolves and writes a `token_resolved` row. Long runs may also
write one or more `token_renewed` rows. Both contain `kind: "app"` and
the App+installation identity, never the token bytes.

## Rotating the private key

GitHub Apps support up to **25 simultaneous valid private keys** ([GitHub
docs][gh-app-keys]). Zero-downtime rotation:

1. App settings → **Private keys → Generate a private key**.
2. Copy the new PEM into `SHIPREPORT_APP_PRIVATE_KEY`.
3. Run the workflow in `mode: doctor` — confirms the new key works.
4. App settings → revoke the old key.

Private keys do not expire automatically; they must be manually revoked.
Plan a quarterly rotation cadence regardless.

[gh-app-keys]: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps

## Common pitfalls

| Symptom                                                                      | Root cause                                                | Fix                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| `Failed to discover GitHub App installation for org <org>: 404`              | App is created but not installed on the org.              | Step 3 above.                                                  |
| `error:0909006C:PEM routines:get_name:no start line`                         | Private key is missing the `-----BEGIN PRIVATE KEY-----` line. | Re-paste the full PEM; check for accidentally-stripped leading lines. |
| `error:1E08010C:DECODER routines::unsupported`                               | The `\n`-escaped form was decoded incorrectly.            | shipreport handles `\n` automatically; check the secret value. |
| Long run fails 51 minutes in with 401                                        | Token expired and renewal failed.                         | Open an issue — this should never happen; renewal threshold is 50 min. |
| `GitHub App config needs either privateKeyEnv or privateKeyPath`             | Config has `app:` but no key reference.                   | Set one of the two.                                            |

Continue → [05 · Auth: GHES](./05-auth-ghes.md) (only if you're on
GitHub Enterprise Server) or skip to
[06 · Configuration reference](./06-config.md).
