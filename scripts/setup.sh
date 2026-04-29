#!/usr/bin/env bash
# One-shot bootstrap for operators who unpacked this archive on a Linux
# or macOS host with Node already installed. Idempotent — re-running is
# safe; it just re-verifies + re-builds.
#
# Usage:
#   bash scripts/setup.sh
#
# What it does:
#   1. Verifies Node version (must be >= 22.13.0).
#   2. Activates pnpm 10 via corepack (or aborts with install instructions).
#   3. Runs `pnpm install --frozen-lockfile` and `pnpm build`.
#   4. Runs the offline preflight to confirm the install is healthy.
#
# What it does NOT do:
#   * Touch any path outside this directory.
#   * Make any network calls beyond the npm registry pnpm uses.
#   * Edit your shipreport.yaml or set any env var.
#
# Air-gapped: this script will fail on `pnpm install` if your host has
# no npm-registry reachability. See HANDOFF.md "Air-gapped install" for
# the offline workflow (vendored node_modules tarball or internal
# proxying registry).

set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf "\n==> %s\n" "$*"; }
fail() { printf "\n[ERROR] %s\n" "$*" >&2; exit 1; }

step "Verifying Node version"
if ! command -v node >/dev/null 2>&1; then
  fail "node not on PATH. Install Node >= 22.13.0 — see HANDOFF.md step 1."
fi
node_version="$(node --version)"
echo "  node: $node_version"
node -e '
  const v = process.versions.node.split(".").map(Number);
  const ok = v[0] > 22 || (v[0] === 22 && v[1] >= 13);
  if (!ok) { console.error("  Node >= 22.13.0 required"); process.exit(1); }
'

step "Activating pnpm 10 via corepack"
if command -v corepack >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@10 --activate >/dev/null 2>&1 || \
    fail "corepack could not prepare pnpm@10. Run 'npm install -g pnpm@10' instead."
elif command -v pnpm >/dev/null 2>&1; then
  echo "  corepack not available; using pnpm already on PATH."
else
  fail "Neither corepack nor pnpm is available. Install pnpm 10 — see HANDOFF.md step 1b."
fi
pnpm_version="$(pnpm --version)"
echo "  pnpm: $pnpm_version"
case "$pnpm_version" in
  10.*) ;;
  *) fail "pnpm $pnpm_version found; require 10.x (see package.json engines).";;
esac

step "Installing npm packages (pnpm install --frozen-lockfile)"
pnpm install --frozen-lockfile

step "Building TypeScript + copying templates (pnpm build)"
pnpm build

step "Running offline preflight"
node scripts/preflight.mjs

cat <<'EOF'

[OK] Setup complete.

Next steps:
  1. cp examples/shipreport.yaml ./shipreport.yaml
  2. $EDITOR shipreport.yaml          # set your org, teams, repos
  3. node scripts/validate-config.mjs shipreport.yaml
  4. node bin/shipreport.js doctor --config shipreport.yaml --offline
  5. export SHIPREPORT_GITHUB_TOKEN=ghp_...
  6. node bin/shipreport.js doctor --config shipreport.yaml
  7. node bin/shipreport.js run --config shipreport.yaml --all

Full walkthrough: HANDOFF.md
Operator manual:  docs/README.md
EOF
