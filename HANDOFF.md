# shipreport — handover guide

You received this codebase as a static archive. **There is no upstream
repository, no support contract, and no further updates.** This file
walks you from "I just unzipped the archive" to a working first run.
Read it once, top to bottom; the rest of the repo is reference material.

> **Air-gapped operators**: the only network calls shipreport ever
> makes at runtime are to **your** GitHub instance (`api.github.com` or
> your GHES). Once Node + the npm packages are installed, no part of
> shipreport's runtime needs the public Internet. See `docs/05-auth-ghes.md`
> and the "Air-gapped install" section near the end of this file for
> the offline build recipe.

---

## What you have

A TypeScript source tree implementing a quarterly engineering success-
story generator. Inputs: a YAML config + a GitHub PAT (or App private
key). Outputs: per-developer Markdown / HTML / optional PDF / PNG plus
a hash-chained SQLite audit log.

The major directories:

| Path                   | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `src/`                 | TypeScript source.                                   |
| `bin/shipreport.js`    | The CLI entry point (Node shim + dynamic import of the built `dist/`). |
| `tests/`               | 300+ unit + e2e tests run by vitest.                 |
| `docs/`                | 16-page operator manual (`docs/README.md` is the index). |
| `examples/`            | Annotated `shipreport.yaml`, public-repo demo config, GitHub Actions caller workflows, sample rendered outputs. |
| `docker/Dockerfile`    | Multi-stage build for the optional Docker image.     |
| `scripts/`             | Build helpers (template copy, config validator, sample renderer). |
| `.github/workflows/`   | CI + release pipeline (only relevant if you push this code into a GitHub repository). |

What is **not** in the archive: a `.git/` history, a `node_modules/`
directory, a `dist/` directory, signed release artifacts, npm-registry
publication, or any phone-home telemetry.

## What it costs at rest

Once installed, shipreport is **dormant**. It does not run a daemon, a
web server, or a scheduled task on its own. It executes only when you
invoke `bin/shipreport.js` (or schedule something to invoke it). All
state lives in two SQLite files that you control:

- `~/.local/share/shipreport/state.sqlite` — the audit log + scheduler bookkeeping.
- `~/.cache/shipreport/cache.sqlite` — the extract cache.

You can change those paths in your config. Both files are created at
mode `0600` (POSIX hosts).

---

## Step 1 — Install Node and pnpm

shipreport supports **Node `>= 22.13.0`** (where `node:sqlite` was
unflagged) and **pnpm `>= 10.0.0 <11.0.0`**. The bundled `.nvmrc` is
`24`, the version this code was developed and tested against.

### 1a. Node

If you don't already have Node installed:

- **Linux / macOS via nvm**:
  ```bash
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  exec $SHELL
  nvm install 24
  nvm use 24
  ```
- **Direct download**: <https://nodejs.org/en/download> — pick the LTS
  build for your OS, run the installer.
- **Windows**: install via the official `.msi` from nodejs.org, or via
  `winget install OpenJS.NodeJS.LTS`.

Verify:
```bash
node --version    # expect v22.13.0 or newer
```

If `node --version` reports anything older than `v22.13.0`, `pnpm
install` will refuse to proceed (per the bundled `.npmrc`'s
`engine-strict=true`). Upgrade Node before going further.

### 1b. pnpm

The cleanest path is corepack, which ships with Node:

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm --version    # expect 10.x.y
```

If corepack isn't available, install pnpm directly:

```bash
npm install -g pnpm@10
```

(or follow <https://pnpm.io/installation> for OS-native installers).

---

## Step 2 — Install the npm packages and build

From the unpacked archive directory:

```bash
pnpm install --frozen-lockfile
pnpm build
```

`--frozen-lockfile` reproduces the exact `pnpm-lock.yaml` versions the
code was tested against; `pnpm build` runs the TypeScript compiler and
copies the Eta templates into `dist/`.

Run the bundled smoke check:

```bash
pnpm typecheck
pnpm lint
pnpm test
```

`pnpm test` exercises **300+ unit + integration tests** in ~10 seconds.
A green run means the codebase is healthy on your runtime.

---

## Step 3 — Verify the binary

```bash
node bin/shipreport.js --version    # prints 0.2.0 (or whatever package.json says)
node bin/shipreport.js --help       # prints the subcommand listing
```

If you'd rather invoke `shipreport` directly, symlink the binary into
your `$PATH`:

```bash
sudo ln -s "$PWD/bin/shipreport.js" /usr/local/bin/shipreport
shipreport --version
```

(On Windows: `node bin\shipreport.js` from PowerShell or cmd.)

---

## Step 4 — Provide a GitHub credential

Pick **one** of the two auth methods:

### 4a. Fine-grained PAT (simplest)

1. Visit `https://github.com/settings/personal-access-tokens/new` (or
   the equivalent on your GHES instance).
2. Resource owner: the org you want to read from.
3. Repository access: select only the repos you'll list in
   `shipreport.yaml`.
4. Repository permissions: **Read** on `Contents`, `Issues`, `Metadata`,
   `Pull requests`. (`Members` org-level read is only required if you
   want auto-member discovery.)
5. Copy the token.

```bash
export SHIPREPORT_GITHUB_TOKEN=github_pat_...
```

### 4b. GitHub App (recommended for many teams or stricter compliance)

Follow `docs/04-auth-github-app.md` end-to-end. The short version:

```bash
export SHIPREPORT_APP_PRIVATE_KEY="$(cat path/to/app-private-key.pem)"
```

…and add a `github.app:` block to `shipreport.yaml` (see
`examples/shipreport.yaml`).

---

## Step 5 — Write a config

Copy the annotated example as your starting point:

```bash
cp examples/shipreport.yaml ./shipreport.yaml
$EDITOR shipreport.yaml
```

Minimum viable config:

```yaml
org: your-github-org

teams:
  - name: checkout
    manager: alice
    members: [alice, bob, carol]
    repos:
      - your-github-org/checkout-service
      - your-github-org/billing-api

defaults:
  quarter: 2026Q1
  timezone: America/New_York

audit:
  enabled: true
```

Validate the config without spending API quota:

```bash
node scripts/validate-config.mjs shipreport.yaml
```

Then run the **offline doctor** — it confirms the schema, paths, cron
expressions, and optional-dep availability without making any GitHub
calls:

```bash
node bin/shipreport.js doctor --config shipreport.yaml --offline
```

---

## Step 6 — Smoke-test against GitHub

```bash
node bin/shipreport.js doctor --config shipreport.yaml
```

Expected output (PAT auth, github.com):

```
Auth kind:        pat
Identity:         pat:env:SHIPREPORT_GITHUB_TOKEN
Authenticated as: <your-username>
Token scopes:     (fine-grained PAT or App installation)
GHES version:     github.com
Base URL:         https://api.github.com
Cache path:       /home/<you>/.cache/shipreport/cache.sqlite
Audit enabled:    true
State path:       /home/<you>/.local/share/shipreport/state.sqlite
Teams:            checkout
```

If something's wrong, `docs/13-troubleshooting.md` lists every error
shipreport can plausibly emit, with root cause and fix.

---

## Step 7 — First real run

```bash
node bin/shipreport.js run --config shipreport.yaml --all
```

Outputs land in `./out/` as Markdown + HTML by default. PDF/PNG are
opt-in (require `puppeteer` — `pnpm add puppeteer`, ~400 MB Chromium).

That's the whole loop. Re-run any time. The extract cache means second
runs are 10× faster than the first.

---

## How to operate it day-to-day

Pick the deployment shape that matches your environment. All three are
first-class — none is a downgrade.

### Local CLI (simplest)

Run on demand from a workstation or ops box. Schedule with OS cron or
systemd if you want it automatic. See `docs/11-deployment-local-cron.md`
for a hardened systemd-timer recipe.

### Docker

```bash
docker build -t shipreport:local -f docker/Dockerfile .
docker run --rm -e SHIPREPORT_GITHUB_TOKEN \
  -v "$PWD/shipreport.yaml:/cfg/shipreport.yaml:ro" \
  -v "$PWD/out:/app/out" \
  -v shipreport-state:/home/shipreport/.local/share/shipreport \
  -v shipreport-cache:/home/shipreport/.cache/shipreport \
  shipreport:local run --config /cfg/shipreport.yaml --all
```

Full recipe + air-gapped variants: `docs/10-deployment-docker.md`.

### GitHub Actions (only if you push this code to a GitHub repository)

The `.github/workflows/` workflows are ready to use **after** you:

1. Push this code into a repository under your own GitHub owner.
2. Replace every `YOUR-GITHUB-OWNER/YOUR-FORK` placeholder in
   `examples/github-actions/*.yml` with the actual `<owner>/<repo>`
   path you pushed to.
3. Replace every `REPLACE_WITH_TAG_OR_SHA` placeholder with a release
   tag (e.g. `v0.2.0`) or a 40-hex commit SHA — both `uses:` lines and
   `shipreport_ref:` inputs.
4. Set the `SHIPREPORT_TOKEN` repository secret.
5. (Optional) Set `SHIPREPORT_APP_PRIVATE_KEY` and `SHIPREPORT_AUDIT_KEY`.

The recommended pattern is hourly tick (`examples/github-actions/hourly-tick.yml`).
See `docs/09-deployment-github-actions.md` for the full matrix.

---

## Air-gapped install

If the host you'll deploy to has no public-Internet egress, do the
build on a connected "transit" host, then ship the result.

### Option A — Source + vendored `node_modules`

1. On a connected host:
   ```bash
   pnpm install --frozen-lockfile
   pnpm build
   tar -czf shipreport-deployable.tar.gz \
     --exclude=.git --exclude=coverage --exclude=.vitest-cache \
     -- *
   ```
   Ship `shipreport-deployable.tar.gz` (≈ 200–500 MB depending on
   whether you've added puppeteer) to the air-gapped host.

2. On the air-gapped host:
   ```bash
   tar -xzf shipreport-deployable.tar.gz
   node bin/shipreport.js doctor --config shipreport.yaml --offline
   ```

   No `pnpm install` needed — `node_modules/` is already in the tarball.
   The runtime never reaches out to npm.

### Option B — Internal npm registry

If you run Verdaccio / Sonatype Nexus / JFrog Artifactory:

1. Configure it to proxy `registry.npmjs.org` once from a connected host.
2. On the air-gapped build host, point pnpm at the internal registry:
   ```bash
   pnpm config set registry https://registry.internal/repository/npm/
   pnpm install --frozen-lockfile
   pnpm build
   ```

### Option C — Docker

`docs/10-deployment-docker.md` has a full air-gapped Docker recipe
including base-image mirroring, optional `Dockerfile.airgap` for
pre-baked dependencies, and a Kubernetes CronJob example.

### Runtime egress allowlist

Once installed, shipreport's outbound network calls are:

| Host                                   | Required for                                           |
| -------------------------------------- | ------------------------------------------------------ |
| `api.github.com`                       | github.com REST + GraphQL (omit for GHES-only deploys). |
| `<your-ghes>.example.com/api/v3`       | GHES REST.                                              |
| `<your-ghes>.example.com/api/graphql`  | GHES GraphQL.                                           |

That's it. No telemetry, no third-party APIs, no fonts loaded from
CDNs in the rendered HTML.

---

## Customisation checklist

Before you deploy in earnest, edit these so the project reflects your
ownership:

- [ ] **`SECURITY.md`** — set your private vulnerability-report
      channel (search for `EDIT:` markers).
- [ ] **`.github/CODEOWNERS`** — replace `@YOUR-GITHUB-OWNER` with
      your GitHub team / user, or delete the file if you don't use
      GitHub PR review.
- [ ] **`docker/Dockerfile`** — update the
      `org.opencontainers.image.source` OCI label
      (search for `REPLACE_WITH_YOUR_REPO_URL`).
- [ ] **`examples/github-actions/*.yml`** — replace
      `YOUR-GITHUB-OWNER/YOUR-FORK` and `REPLACE_WITH_TAG_OR_SHA`
      placeholders if you'll use the GitHub Actions deployment.
- [ ] **`LICENSE`** — keep the MIT text but update the copyright
      holder line if your org's lawyers prefer it.
- [ ] **`package.json`** — the `name` field is `shipreport`; if you
      ever publish this to a registry, namespace it
      (e.g. `@your-scope/shipreport`).
- [ ] **`shipreport.yaml`** — your real config (`org:`, `teams:`,
      schedule, classification labels).

The bundled `tests/e2e/workflows.test.ts` enforces that any caller
workflow which references `<owner>/<repo>/.github/workflows/reusable-shipreport.yml@`
uses the `REPLACE_WITH_TAG_OR_SHA` sentinel rather than a 40-hex SHA;
this protects you from shipping a stale or invalid pin by accident.

---

## Where the docs are

Once you're past the bootstrapping step, the operator manual lives in
[`docs/`](./docs/). Recommended reading order for first-time owners:

1. `docs/00-overview.md` — what shipreport is and isn't.
2. `docs/06-config.md` — every field of `shipreport.yaml`.
3. `docs/13-troubleshooting.md` — every error message + fix.
4. `docs/14-security.md` — threat model + secrets handling.
5. `docs/12-audit-log.md` — SOC2 evidence model.

The full index is at `docs/README.md`.

---

## What this archive does NOT include

- A `.git/` history (the archive is a clean export).
- A pre-built `dist/` directory (you run `pnpm build` once on first
  install).
- A vendored `node_modules/` directory (`pnpm install` populates it).
- Any signed release artifacts (`release.yml` is configured for the
  original publication path; you would need to adapt or remove it
  before re-publishing).
- A support channel. This is a one-way handover — there is no
  upstream maintainer to file issues against. You own this code now.

---

## Verifying everything works

A complete first-day checklist:

```bash
# Prerequisites
node --version          # expect v22.13.0 or newer
pnpm --version          # expect 10.x

# Install + build
pnpm install --frozen-lockfile
pnpm build

# Sanity gates
pnpm typecheck
pnpm lint
pnpm test

# Binary works
node bin/shipreport.js --version
node bin/shipreport.js --help

# Config parses (no token required)
cp examples/shipreport.yaml shipreport.yaml
node scripts/validate-config.mjs shipreport.yaml
node bin/shipreport.js doctor --config shipreport.yaml --offline

# Real auth (after editing shipreport.yaml + setting the env var)
export SHIPREPORT_GITHUB_TOKEN=ghp_...
node bin/shipreport.js doctor --config shipreport.yaml
node bin/shipreport.js run --config shipreport.yaml --all
```

If every command above exits zero and `out/` contains the expected
Markdown / HTML files, you're ready for production use.
