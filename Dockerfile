# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
# (AG Grid license keys are client-side by design: they ship in the browser bundle, so the build arg isn't a secret.)
#
# One image serves everything: Fastify API + webhooks + BullMQ worker + the built web app.
#
# Build-time vs runtime config:
#   - VITE_* variables are compiled into the web bundle, so they MUST be passed as build args
#     (Dokploy: "Build Args", not just "Environment").
#   - Everything else (DATABASE_URL, REDIS_URL, PayPal, AI keys, PUBLIC_BASE_URL) is runtime env only.
#     No secrets are baked into the image.

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
# Corepack reads "packageManager" from package.json and installs exactly that pnpm version.
COPY package.json ./
RUN corepack install

# ---------------------------------------------------------------- deps
FROM base AS deps
# Lockfile only: this layer is reused until dependencies change.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --offline --frozen-lockfile

# ---------------------------------------------------------------- build
FROM deps AS build
ARG VITE_AG_GRID_LICENSE_KEY=""
ENV VITE_AG_GRID_LICENSE_KEY=${VITE_AG_GRID_LICENSE_KEY}
COPY . .
# Dependency order: shared → web → api.
RUN pnpm --filter @pod/shared build \
 && pnpm --filter web build \
 && pnpm --filter api build
# Pruned, production-only api bundle: dist + drizzle migrations + prod node_modules, with @pod/shared
# copied in (injectWorkspacePackages). Resolved from the lockfile and the store populated by `pnpm fetch`.
RUN pnpm --filter api deploy --prod --offline /out \
 && cp -r apps/web/dist /out/public

# ---------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
# UV_THREADPOOL_SIZE: DNS lookups (getaddrinfo) run on libuv's pool (default 4). While Redis is
# unreachable, reconnecting clients can tie up all 4 threads and starve Postgres's lookups, so
# /health would report a healthy DB as down.
ENV NODE_ENV=production \
    API_PORT=3000 \
    API_HOST=0.0.0.0 \
    UV_THREADPOOL_SIZE=16 \
    UPLOAD_DIR=/app/uploads
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Rider photos. Mount a volume here; a fresh named volume inherits this node-owned directory.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
VOLUME /app/uploads
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# tini forwards SIGTERM to node (graceful shutdown) and reaps zombies.
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
