# One image for this app. Build context: the repository root.
#
#   docker build -t my-app .
#   docker run --init -p 3000:3000 --env-file .env -e DATABASE_URL=postgres://... my-app
#
# No secret is baked in. Every secret arrives as an environment variable at
# run time (see .env.example). Production needs DATABASE_URL: the app refuses
# to start on SQLite when NODE_ENV=production.

FROM node:22.23.3-alpine AS build
WORKDIR /repo
# The lockfile pins every dependency, including @usequeek/app-sdk.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.3-alpine AS runtime
# Production mode, and a V8 old-space cap below the container's memory limit.
# 192 MB assumes a 256 MB container: leave room for buffers and native memory,
# and raise both numbers together if your app grows.
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--max-old-space-size=192
WORKDIR /app
COPY --from=build --chown=node:node /repo/build ./build
COPY --from=build --chown=node:node /repo/server.js /repo/loopback.js /repo/package.json /repo/queek.app.toml ./
COPY --from=build --chown=node:node /repo/node_modules ./node_modules
# The image ships the unprivileged `node` user; nothing here needs root.
USER node
EXPOSE 3000
# /health answers 503 until the config validates and the store opens, so a
# container with missing secrets is reported unhealthy, not green.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
# server.js handles SIGTERM and SIGINT itself and drains in-flight requests.
CMD ["node", "server.js"]
