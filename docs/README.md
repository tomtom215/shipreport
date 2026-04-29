# shipreport documentation

End-user documentation for going from a fresh GitHub org to a fully
scheduled, audited shipreport deployment. Each page is short and focused —
read what you need, skip what you don't.

The recommended path is **GitHub Actions**. shipreport is designed for it:
schedulable, secrets-managed, OIDC-friendly, and the audit log lands in
GHA's artifact retention by default.

## Index

### Get started in order

| #   | Page                                                       | What it covers                                                  |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| 00  | [Overview](./00-overview.md)                               | What shipreport is, what it isn't, where the boundaries are.    |
| 01  | [Prerequisites](./01-prerequisites.md)                     | Checklist before you start: org access, runner choice, secrets. |
| 02  | [Quickstart (10 min)](./02-quickstart.md)                  | Hello-world deploy: one team, PAT, scheduled GH Action.         |

### Authentication — pick exactly one

| #   | Page                                                       | When to use                                                     |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| 03  | [Auth: Fine-grained PAT](./03-auth-pat.md)                 | Small org, single operator, github.com.                         |
| 04  | [Auth: GitHub App](./04-auth-github-app.md)                | Enterprise, multiple teams, audit-friendly.                     |
| 05  | [Auth: GitHub Enterprise Server](./05-auth-ghes.md)        | On-prem GHES, including air-gapped.                             |

### Configure & schedule

| #   | Page                                                       | What it covers                                                  |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| 06  | [Configuration reference](./06-config.md)                  | Every field in `shipreport.yaml`, in order, with defaults.      |
| 07  | [Scheduling](./07-scheduling.md)                           | Cron syntax, idempotency, scheduling many teams.                |
| 08  | [Dry-run methodology](./08-dry-run.md)                     | Validate without burning quota; debug without secrets.          |

### Deployment patterns

| #   | Page                                                       | What it covers                                                  |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| 09  | [Deploy: GitHub Actions (recommended)](./09-deployment-github-actions.md) | Every supported pattern: scheduled, dispatch, reusable, GHES.   |
| 10  | [Deploy: Docker](./10-deployment-docker.md)                | Container builds, multi-arch, air-gap, PDF/PNG.                 |
| 11  | [Deploy: Local cron](./11-deployment-local-cron.md)        | systemd timers, OS cron, Kubernetes CronJob.                    |

### Operate & audit

| #   | Page                                                       | What it covers                                                  |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------- |
| 12  | [Audit log (SOC2)](./12-audit-log.md)                      | Hash-chain design, verification, snapshots, evidence export.    |
| 13  | [Troubleshooting](./13-troubleshooting.md)                 | Every error message, with root cause and fix.                   |
| 14  | [Security model](./14-security.md)                         | Threat model, secret handling, supply chain.                    |
| 15  | [FAQ](./15-faq.md)                                         | Quick answers to the questions everyone asks.                   |
| 16  | [Delivery](./16-delivery.md)                               | Getting reports to non-technical managers (email, shared drive, intranet, …). |

## How to read this

* **You're brand new**: 00 → 01 → 02. You'll have a working pipeline in 10
  minutes.
* **You picked GitHub App auth**: 04 → 06 → 09. The other auth pages are
  context, not required reading.
* **You're operating an existing deploy**: 12 → 13 are the daily-driver
  references; the rest is for changes.
* **You're a security reviewer**: 14 → 12 → 06 will give you the model in
  the right order.
* **Your manager doesn't use GitHub**: 16 covers every realistic
  delivery channel — email, shared drive, intranet, calendar invites.

Every page links forward, backward, and to the relevant CLI / workflow
files. Nothing here is duplicated from `README.md` — that's the project
pitch; this is the operator manual.
