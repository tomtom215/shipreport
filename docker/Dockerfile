# shipreport — Quarterly engineering success story generator.
# Slim image, no native deps (Node 24 ships stable SQLite). ~150MB.
#
# Base image is pinned by digest so supply-chain provenance is deterministic.
# .github/dependabot.yml bumps this pin weekly; resolve the current digest
# locally with:
#   docker pull node:24-alpine
#   docker inspect --format='{{index .RepoDigests 0}}' node:24-alpine
FROM node:24-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000 AS build
# NOTE: digest above is a placeholder; dependabot resolves it on first
# weekly scan. If you're cutting a release before dependabot has run,
# replace the digest manually using the command above.

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --no-frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

FROM node:24-alpine@sha256:0000000000000000000000000000000000000000000000000000000000000000
WORKDIR /app
ENV NODE_ENV=production

# Non-root user. shipreport only needs to read its config file and write to
# a mounted output directory + the state/cache volumes — no privileged
# operations. Running as root would be an unnecessary blast-radius expansion
# if an attacker ever gained RCE through a malicious PR body or label.
RUN addgroup -S shipreport && adduser -S -G shipreport -u 10001 shipreport

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --prod --no-frozen-lockfile \
 && rm -rf /root/.local/share/pnpm/store ~/.pnpm-store

COPY --from=build /app/dist ./dist
COPY bin ./bin

# PDF output needs puppeteer + chromium; install with:
#   docker build --build-arg WITH_PDF=1 -t shipreport:pdf .
# (Leaves image ~400MB larger.)
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
 && chown -R shipreport:shipreport /app /home/shipreport

USER shipreport
ENV HOME=/home/shipreport

# Persist the state DB (audit log + scheduler last-runs) across container
# restarts by mounting a volume at /home/shipreport/.local/share/shipreport.
# If you don't, the audit log starts empty on every run and the scheduler
# treats every team as "never run".
VOLUME ["/home/shipreport/.local/share/shipreport", "/home/shipreport/.cache/shipreport"]

ENTRYPOINT ["node", "bin/shipreport.js"]
CMD ["--help"]
