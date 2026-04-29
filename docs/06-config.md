# 06 · Configuration reference

← [05 · Auth: GHES](./05-auth-ghes.md) · [Index](./README.md) · Next → [07 · Scheduling](./07-scheduling.md)

Every field in `shipreport.yaml`, in declaration order, with its default
and a note on what changes if you alter it. The annotated YAML lives at
[`examples/shipreport.yaml`](../examples/shipreport.yaml).

A field's absence is **always** equivalent to that field's documented
default. There are no implicit values that depend on other fields.

## Top-level shape

```yaml
github: { … }     # GitHub connectivity
org: <string>     # Required. Org login the App is installed on (or the PAT can read).
teams: [ … ]      # Required. ≥1 team.
defaults: { … }   # Inherited by every team unless overridden.
audit: { … }      # SOC2 audit log.
cache: { … }      # Local SQLite cache.
extract: { … }    # Concurrency + rate-limit knobs.
```

Plus a legacy `v0.1` shape (`team: { … }` + top-level `repos:` + top-level
`quarter:`) that's still accepted and normalized to a one-entry `teams:`
array on load. Don't use it for new configs.

## `github`

```yaml
github:
  baseUrl:    https://api.github.com         # default
  graphqlUrl: https://api.github.com/graphql # default
  tokenEnv:   SHIPREPORT_GITHUB_TOKEN        # default — env var name, NOT the token
  app:                                        # optional; if set, App auth wins over tokenEnv
    appId: 123456
    privateKeyEnv:  SHIPREPORT_APP_PRIVATE_KEY  # XOR with privateKeyPath
    privateKeyPath: /etc/shipreport/app.pem    # XOR with privateKeyEnv
    installationId: 7890123                    # optional; auto-discovered if absent
    clientId: <string>                         # optional; reserved for future use
```

| Field         | Required?             | Default                              | Notes                                           |
| ------------- | --------------------- | ------------------------------------ | ----------------------------------------------- |
| `baseUrl`     | No                    | `https://api.github.com`             | Override for GHES.                              |
| `graphqlUrl`  | No                    | `https://api.github.com/graphql`     | Override for GHES.                              |
| `tokenEnv`    | No (App preferred)    | `SHIPREPORT_GITHUB_TOKEN`            | Name of the env var holding the PAT.            |
| `app`         | No                    | absent                               | If present, takes precedence over `tokenEnv`.   |

`app.appId` and `app.installationId` accept either an integer (`123456`)
or a numeric string (`"123456"`).

## `org`

A single string. The org login (e.g. `acme-eng`). Required.

Used for:

* App installation discovery (`/orgs/<org>/installation`).
* The `target` field of audit `run_started` rows.

## `teams`

```yaml
teams:
  - name: <string>             # required, unique within the file
    manager: <string>          # required; appears in the rollup output
    members: [<login>, …]      # OPTIONAL — see autoMembers
    autoMembers:               # OPTIONAL — only consulted when `members` is absent
      limit: 10
      excludeBots: true
      excludeLogins: []
    repos:                     # required; ≥1
      - <owner>/<repo>
    quarter: 2026Q1            # OPTIONAL — overrides defaults.quarter for this team
    schedule: "0 14 1 1,4,7,10 *"  # OPTIONAL — see 07 · Scheduling
    output:                    # OPTIONAL — overrides defaults.output for this team
      dir: ./out/this-team
      formats: [md, html]
      perDev: true
      teamSummary: true
      managerRollup: true
    classification:            # OPTIONAL — overrides defaults.classification
      bugfixLabels: [bug, hotfix]
      featureLabels: [feature]
      infraLabels:  [ci, build]
      docsLabels:   [docs]
```

### `members` vs `autoMembers`

* If `members:` is present, it's used verbatim. `autoMembers` is ignored.
* If `members:` is absent, shipreport ranks PR authors in the team's repos
  for the target quarter and takes the top `autoMembers.limit`. Bots are
  filtered by default. Tie-break is alphabetical, so reruns are stable.
* The discovered member list is recorded in the audit log
  (`event: members_discovered`), so the run is reproducible and
  evidence-backed.

### `quarter`

Either a label or an explicit range:

```yaml
quarter: 2026Q1
# OR
quarter: { from: 2026-02-15, to: 2026-05-15 }
```

Labels are resolved in `defaults.timezone`, not UTC. See
[the timezone subsection of 07](./07-scheduling.md#timezone-and-quarter-resolution).

## `defaults`

```yaml
defaults:
  quarter:        2026Q1                  # required if no team has its own
  timezone:       UTC                     # default. Any IANA name.
  coAuthorCredit: full                    # default. "full" | "split"
  output:
    dir:           ./out
    formats:       [md, html]             # subset of: md, html, pdf, png
    perDev:        true
    teamSummary:   true
    managerRollup: true
  classification:
    bugfixLabels:  [bug, hotfix, p0, p1]
    featureLabels: [feature, enhancement]
    infraLabels:   [ci, build, devops, infra]
    docsLabels:    [docs, documentation]
```

| Field             | Default                           | Notes                                                |
| ----------------- | --------------------------------- | ---------------------------------------------------- |
| `timezone`        | `UTC`                             | IANA zone name. Used for quarter window + Intl-fmt.  |
| `coAuthorCredit`  | `full`                            | `full` = author + each co-author get +1; `split` = 1/N each. |
| `output.formats`  | `[md, html]`                      | `pdf` and `png` require optional `puppeteer` install. |

### `output.formats`

| Format | Requires            | When to use                                         |
| ------ | ------------------- | --------------------------------------------------- |
| `md`   | Nothing             | Default; the canonical artifact.                     |
| `html` | Nothing             | Direct browser-shareable; the bundled CSS is decent.|
| `pdf`  | `puppeteer`         | Calibration committees that prefer PDF.              |
| `png`  | `puppeteer`         | Embedding the rollup in a slide deck.                |

`puppeteer` is **not** part of shipreport's `dependencies` or
`optionalDependencies`, so a default `pnpm install` does **not** pull
the ~400 MB Chromium download. If a team's `output.formats` includes
`pdf` or `png`, install puppeteer explicitly in the same project where
shipreport is installed (`pnpm add puppeteer`); shipreport dynamic-
imports it at render time. The Docker image's `WITH_PDF=1` build-arg
does the same install for you (see [10 · Docker](./10-deployment-docker.md)).

### `classification`

PR labels are matched case-insensitively against these lists. First match
wins, in this order: `bugfix → feature → infra → docs → other`. Conventional-
commit prefixes (`fix:`, `feat:`, …) are used as a tiebreaker.

## `audit`

```yaml
audit:
  enabled: true
  path: ~/.local/share/shipreport/state.sqlite
  signingKeyPath: ~/.config/shipreport/audit-ed25519.pem
  signer: shipreport
```

| Field             | Default                                              | Notes                                              |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `enabled`         | `true`                                               | Set `false` to skip the audit DB entirely.         |
| `path`            | `~/.local/share/shipreport/state.sqlite`             | Where the SQLite state DB lives.                   |
| `signingKeyPath`  | `~/.config/shipreport/audit-ed25519.pem`             | ed25519 PEM. Auto-generated mode 0600 on first use. |
| `signer`          | `shipreport`                                         | Goes into the signed manifest header.              |

`~` is expanded against `$HOME`. Anything else is `path.resolve()`d.

## `cache`

```yaml
cache:
  path: ~/.cache/shipreport/cache.sqlite
  ttlDays: 7
```

`ttlDays` controls how aggressively `shipreport cache prune` sweeps old
extract snapshots and checkpoints. Setting it to `0` is allowed but
disables incremental-cache benefits.

## `extract`

```yaml
extract:
  concurrency: 4
  rateLimitThreshold: 100
```

| Field                | Default | Notes                                                                       |
| -------------------- | ------- | --------------------------------------------------------------------------- |
| `concurrency`        | `4`     | Max simultaneous per-repo GraphQL calls. Hard cap of 32 enforced in **both** the YAML schema and the `--concurrency` CLI override (passing 33 throws at parse time). |
| `rateLimitThreshold` | `100`   | When `rateLimit.remaining` drops below this, shipreport degrades to serial. |

> Pagination safety cap: each repo's PR fetch stops after 40 pages (50
> PRs per page = 2,000 PRs per repo per quarter), even if the GraphQL
> cursor reports more pages. This is a guard against runaway extracts
> on misconfigured repos and is documented in `src/extract.ts`.
> Realistic engineering teams never hit it; if you do, split the team
> across multiple configs.

## CLI overrides

A handful of fields can be overridden at run time without editing the YAML:

| YAML field                          | CLI flag                                              |
| ----------------------------------- | ----------------------------------------------------- |
| Per-team `quarter`                  | `--quarter 2026Q2`                                    |
| `defaults.output.formats` extras    | `--pdf` / `--png` (additive only)                     |
| `extract.concurrency`               | `--concurrency 8`                                     |
| Treat as cache-only                 | `--dryRun`                                            |
| Verbose logging                     | `--verbose` / `-v`                                    |

`--quarter` overrides BOTH the team-level and `defaults.quarter`.

## Validation

`scripts/validate-config.mjs` parses the YAML and every team's cron
without touching the network. Run it from CI:

```bash
node scripts/validate-config.mjs shipreport.yaml
```

Or rely on the bundled `validate-config.yml` workflow on PRs.

Continue → [07 · Scheduling](./07-scheduling.md).
