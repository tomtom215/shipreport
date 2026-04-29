# shipreport — Quarterly engineering success story generator.
# Slim image, no native deps. Uses the `node:sqlite` built-in (unflagged
# since Node 22.13 / 23.4; still tagged ExperimentalWarning by Node — see
# bin/shipreport.js for the targeted suppression at the binary boundary).
# ~150 MB.
#
# Pinning policy:
#   * Base image is `node:24-alpine`. shipreport's `engines.node` floor
#     is `>=22.13.0` (where `node:sqlite` was unflagged); the image
#     intentionally tracks the most recent LTS-track Node that CI exercises.
#   * The digest below is the multi-arch manifest list for `node:24-alpine`
#     as of 2026-04-16. Resolve a fresh digest yourself before cutting a
#     release with:
#       docker buildx imagetools inspect node:24-alpine | grep '^Digest'
#     OR for a single arch:
#       docker pull node:24-alpine
#       docker inspect --format='{{index .RepoDigests 0}}' node:24-alpine
#   * .github/dependabot.yml refreshes the digest weekly.
#   * Reproducibility: a CI build that pulls a different digest than the
#     one pinned here will fail, surfacing supply-chain drift.
ARG NODE_BASE=node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f

FROM ${NODE_BASE} AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

FROM ${NODE_BASE}
WORKDIR /app
ENV NODE_ENV=production

# Non-root user. shipreport only needs to read its config file and write to
# a mounted output directory + the state/cache volumes — no privileged
# operations. Running as root would be an unnecessary blast-radius expansion
# if an attacker ever gained RCE through a malicious PR body or label.
RUN addgroup -S shipreport && adduser -S -G shipreport -u 10001 shipreport

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --frozen-lockfile --prod \
 && rm -rf /root/.local/share/pnpm/store ~/.pnpm-store

COPY --from=build /app/dist ./dist
COPY bin ./bin

# PDF output needs puppeteer + Chromium. Install with:
#   docker build --build-arg WITH_PDF=1 -t shipreport:pdf .
# Adds ~250 MB (apk Chromium + nss + freetype + harfbuzz + ttf-freefont).
ARG WITH_PDF=0
RUN if [ "$WITH_PDF" = "1" ]; then \
      apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont \
      && pnpm add puppeteer \
      && echo "export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser" >> /etc/profile; \
    fi

# Give the runtime user a home they can write to.
RUN mkdir -p /home/shipreport/.local/share/shipreport \
           /home/shipreport/.cache/shipreport \
           /home/shipreport/.config/shipreport \
 && chown -R shipreport:shipreport /app /home/shipreport \
 && chmod 0700 /home/shipreport/.config/shipreport

USER shipreport
ENV HOME=/home/shipreport

# Persist the state DB (audit log + scheduler last-runs) across container
# restarts by mounting a volume at /home/shipreport/.local/share/shipreport.
# If you don't, the audit log starts empty on every run and the scheduler
# treats every team as "never run".
VOLUME ["/home/shipreport/.local/share/shipreport", "/home/shipreport/.cache/shipreport"]

# OCI image labels — make `docker inspect` informative for compliance.
# `org.opencontainers.image.source` is intentionally left as a generic
# placeholder; if you fork this code into your own GitHub repository,
# replace the URL with your fork (or pass it as a build arg) so SBOM
# tooling can resolve provenance back to your source.
LABEL org.opencontainers.image.title="shipreport" \
      org.opencontainers.image.description="Quarterly engineering success story generator." \
      org.opencontainers.image.source="https://example.com/REPLACE_WITH_YOUR_REPO_URL" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["node", "bin/shipreport.js"]
CMD ["--help"]
