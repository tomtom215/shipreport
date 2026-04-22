# shipreport — Quarterly engineering success story generator.
# Slim image, no native deps (Node 22 ships SQLite). ~150MB.
FROM node:22-alpine AS build

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm install --no-frozen-lockfile --prod=false
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

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
      && echo "export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser" >> /root/.profile; \
    fi

ENTRYPOINT ["node", "bin/shipreport.js"]
CMD ["--help"]
