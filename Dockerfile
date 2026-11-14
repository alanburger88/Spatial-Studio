# InfoSlips Spatial Studio — one-command local run (API + production web build + headless Chromium composer).
# Base image: Microsoft's Playwright image (Node + the exact Chromium build for Playwright 1.63).
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV CI=true \
    NODE_ENV=production \
    API_HOST=0.0.0.0 \
    WEB_HOST=0.0.0.0 \
    DATA_DIR=/data \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app

# Dependencies first (cached unless manifests change).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/model/package.json packages/model/
COPY packages/renderers/package.json packages/renderers/
COPY packages/resolver/package.json packages/resolver/
COPY packages/scenarios/package.json packages/scenarios/
COPY packages/validation/package.json packages/validation/
COPY packages/runtime/package.json packages/runtime/
RUN pnpm install --frozen-lockfile --prod=false

COPY . .
RUN pnpm --filter @iss/web build

# Data (SQLite, exports, imported records, image library, batches) lives in a volume.
VOLUME ["/data"]
EXPOSE 5173
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/dev.mjs", "--preview", "--no-build"]
