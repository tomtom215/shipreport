# 03 · Auth: Fine-grained PAT

← [02 · Quickstart](./02-quickstart.md) · [Index](./README.md) · Next → [04 · Auth: GitHub App](./04-auth-github-app.md)

A Personal Access Token (PAT) is the simplest way to authenticate
shipreport. Recommended for: small orgs, single operators, github.com.

If you're standing up shipreport for an entire engineering org with
multiple teams or strict compliance requirements, skip to
[04 · Auth: GitHub App](./04-auth-github-app.md) instead.

## Fine-grained vs classic — pick fine-grained

| Feature                       | Fine-grained PAT                    | Classic PAT                                      |
| ----------------------------- | ----------------------------------- | ------------------------------------------------ |
| Per-repo scoping              | Yes                                 | No (org-wide)                                    |
| Org admin can require         | Yes                                 | Yes                                              |
| Resource owner approval flow  | Yes                                 | No                                               |
| Max lifetime                  | 1 year                              | "No expiration" allowed (not recommended)        |
| Recommended for shipreport    | **Yes**                             | Only as a fallback if your org disables FGPATs.  |

## Required scopes

shipreport reads but never writes. Configure these scopes on the PAT:

| Scope                  | Read / Write | Why                                                            |
| ---------------------- | ------------ | -------------------------------------------------------------- |
| `Contents`             | Read         | Default-branch detection, commit metadata.                     |
| `Issues`               | Read         | Linked issues (`Fixes #123` resolution).                       |
| `Metadata`             | Read         | Mandatory for any fine-grained PAT to be usable.               |
| `Pull requests`        | Read         | The actual extract source.                                     |
| `Members` (org-level)  | Read         | Team-membership lookups (skip if you supply explicit `members:`). |

`Members` is the only org-level permission. If your org admin won't
approve org-level scopes, omit it and supply `members:` explicitly in
`shipreport.yaml`.

## Resource access

* **Specific repositories**: pick exactly the repos in your `shipreport.yaml`'s
  `repos:` list. This is the safest option — minimum blast radius.
* **All repositories**: simpler but broader. Choose this if your repo list
  changes often.
* **Public repositories (read-only)**: works for OSS rollups (e.g. the
  vllm demo in `examples/vllm.yaml`).

## Configure shipreport

```yaml
github:
  baseUrl: https://api.github.com
  graphqlUrl: https://api.github.com/graphql
  tokenEnv: SHIPREPORT_GITHUB_TOKEN     # name of the env var, not the token itself
```

Then export:

```bash
export SHIPREPORT_GITHUB_TOKEN=github_pat_…
```

In a GitHub Action, set the secret `SHIPREPORT_TOKEN` and pass it through
to the workflow:

```yaml
env:
  SHIPREPORT_GITHUB_TOKEN: ${{ secrets.SHIPREPORT_TOKEN }}
```

(The reusable workflow does this for you when you set the
`shipreport_token` secret on the call.)

## Token lifecycle

1. **Create**: see step 1 of [02 · Quickstart](./02-quickstart.md).
2. **Verify**: `shipreport doctor --config shipreport.yaml` confirms auth
   and prints the resolved identity.
3. **Use**: shipreport calls `getToken()` before every request; PAT tokens
   are constants for the run.
4. **Rotate**: every 90 days minimum, ideally every 30. See "Rotating a
   PAT" below.
5. **Revoke**: <https://github.com/settings/personal-access-tokens> →
   Delete. shipreport will start failing on the next run with a clear
   401 error message.

## Audit log entries

Every run that resolves a PAT writes one row:

```json
{
  "actor": "pat:env:SHIPREPORT_GITHUB_TOKEN",
  "event": "token_resolved",
  "target": "<org>",
  "payload": { "kind": "pat" }
}
```

The token itself is **never** logged. Only the identity (env var name).

## Rotating a PAT

Zero-downtime rotation:

1. Create a new PAT with the same scopes.
2. Update the GitHub Action secret `SHIPREPORT_TOKEN` with the new value.
3. Run the workflow once in `mode: doctor` to confirm. ✅
4. Revoke the old PAT.

shipreport caches no tokens between runs, so step 3 is instantaneous —
the next dispatch picks up the new value.

## Common pitfalls

| Symptom                                                              | Root cause                                    | Fix                                                |
| -------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| `GitHub token not set. Either configure github.app or export …`      | Env var is unset or empty.                    | Re-export, or check the GH Actions secret name.    |
| `401 Unauthorized` on the first GraphQL call                         | PAT lacks the required scopes / repos.        | Re-grant; see scopes table above.                  |
| `403 Resource not accessible by personal access token`               | Resource owner hasn't approved the PAT.       | Org admin: approve in `Settings → PAT`.            |
| `Cannot find any user matching: members`                             | `Members:read` scope missing or denied.       | Add it, or remove `members:` lookup needs.         |
| Workflow ran but produced no PRs                                     | Repos in scope have no merged PRs in window.  | Run with `mode: dry-run` and check warnings.       |

Continue → [04 · Auth: GitHub App](./04-auth-github-app.md) for enterprise
patterns, or skip to [06 · Configuration reference](./06-config.md).
