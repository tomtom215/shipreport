# 01 · Prerequisites

← [00 · Overview](./00-overview.md) · [Index](./README.md) · Next → [02 · Quickstart](./02-quickstart.md)

A 2-minute checklist before you start. Everything here is reversible and
free. Don't skip the auth row — that's the most common reason a deploy
stalls on day one.

## Hard requirements

| #   | Requirement                                                          | How to verify                                  |
| --- | -------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | A GitHub org you control, **or** read-access to one.                  | Browse to `https://github.com/<org>` and confirm membership. |
| 2   | At least one repository in that org with merged PRs in your target quarter. | `gh pr list --state merged --search "merged:2026-01-01..2026-03-31" --limit 1` returns ≥1 row. |
| 3   | Pick **one** auth method: PAT, GitHub App, or GHES variant.          | See the matrix below.                          |
| 4   | A GitHub repo to host `shipreport.yaml` and the workflow files.       | Can be your operations repo, a fork of shipreport, or a fresh repo. |

## Soft requirements (nice to have)

| Item                                                                  | Why                                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------------ |
| Branch protection on the repo holding `shipreport.yaml`.              | Stops a typo from going live unreviewed.                     |
| A Slack channel / mailing list for the workflow's failure notifications. | shipreport doesn't ship a notifier; GH Actions can.        |
| An ed25519 keypair for `audit snapshot`.                               | Auto-generated on first use if absent (mode 0600).           |

## Auth matrix — pick one and only one

| Auth method                  | Recommended for                          | Setup time | Scopes / permissions                                            |
| ---------------------------- | ---------------------------------------- | ---------- | --------------------------------------------------------------- |
| Fine-grained PAT             | Single operator, ≤5 repos, github.com    | 5 min      | Read on contents, issues, PRs, metadata, members.               |
| GitHub App                   | Enterprise, ≥1 team, audit-friendly      | 15 min     | Same read perms, but installation-token scoped.                 |
| GHES PAT or App              | On-prem GHES                             | 5 / 15 min | Same as above, plus `github.baseUrl` / `graphqlUrl` overrides.  |

If unsure: **start with PAT**, then migrate to App later. Migration is
just a config swap — see [04](./04-auth-github-app.md).

## Runner choice

| Runner                                | When to use                                                    |
| ------------------------------------- | -------------------------------------------------------------- |
| `ubuntu-latest` (GitHub-hosted)       | Default. Works for github.com, public-internet GHES.           |
| `ubuntu-22.04` / pinned image         | Compliance / supply-chain teams that pin runner OS.            |
| Self-hosted runner inside your VPC    | GHES that isn't internet-reachable, or strict egress control.  |

The reusable workflow accepts a `runs_on` input — see
`examples/github-actions/ghes-self-hosted.yml`.

## Timezone

shipreport resolves "2026Q1" against an IANA timezone, not UTC. Pick one:

* `America/New_York` for an East-Coast US team.
* `Europe/London` for a UK team.
* `Asia/Tokyo` for Japan.
* `UTC` if your team is multi-zone and you want unambiguous bounds.

DST is handled correctly via `Intl.DateTimeFormat`. You can verify with
`shipreport doctor --config shipreport.yaml` after step 02.

## Network access

shipreport calls **only** GitHub. No telemetry, no analytics, no third-party
APIs. Egress allowlist (for outbound proxies):

| Host                                | Why                                          |
| ----------------------------------- | -------------------------------------------- |
| `api.github.com`                    | REST + GraphQL on github.com.                |
| `github.com`                        | OIDC token exchange (GitHub Actions only).   |
| `<ghes>.example.com/api/v3`         | GHES REST.                                   |
| `<ghes>.example.com/api/graphql`    | GHES GraphQL.                                |
| `registry.npmjs.org` (build only)   | Installing pnpm dependencies.                |

For air-gapped GHES setups, build a Docker image with deps baked in — see
[10](./10-deployment-docker.md).

Keep going → [02 · Quickstart](./02-quickstart.md).
