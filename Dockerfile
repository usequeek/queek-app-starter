# One Docker image for THIS app (build context = this repo root):
#   docker build -t my-app .
# No secrets are baked in — every secret arrives as environment at run time
# (see .env.example).

FROM node:22.23.3-alpine AS build
WORKDIR /repo
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22.23.3-alpine AS runtime
# Runs as non-root (app), production mode, and a capped V8 heap: idle RSS
# measures ~50-60 MB, so --max-old-space-size=96 leaves headroom while keeping
# worst-case RSS just under the 128 MB container limit Dokploy enforces
# (the cgroup is the hard backstop).
ENV NODE_ENV=production \
    PORT=3000 \
    QUEEK_DB_PATH=/app/data/my-app.db \
    NODE_OPTIONS=--max-old-space-size=96
WORKDIR /app
COPY --from=build /repo/dist ./dist
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/queek.app.toml ./queek.app.toml
RUN mkdir -p /app/data && addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "dist/index.js"]
