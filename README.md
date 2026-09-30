# My App

A [Queek](https://usequeek.com) installable app, from
[`usequeek/queek-app-starter`](https://github.com/usequeek/queek-app-starter).

## Develop

```bash
npm install
npm run dev   # the whole loop: tunnel + test-store install + your app, started with the dev env
```

`queek app dev` registers `queek.app.toml` as a `development` build, installs
it on an owned test store, then starts the app from the toml's `[dev]` table
(`tsx watch src/index.ts`) with the dev env injected: `APP_BASE_URL` (the
tunnel origin), `PORT`, `NODE_ENV=development`, plus the signing secret,
keypair and encryption key from `.queek/.env.local` (minted on first run,
never printed). Your project's own `.env` fills the rest. Output streams
prefixed with `[app]`; a crash restarts with backoff. Save `queek.app.toml`
to re-register; `Ctrl+C` stops the app and the tunnel. When the app answers
`/health`, the command prints the store-admin and storefront links — open
them.

## Deploy & submit

```bash
queek app deploy            # toml → version N+1 (secret shown once on first registration, interactive terminal only)
queek app versions list my-app
queek app release my-app 1.2.0
queek app submit my-app     # → in_review
```

CI deploys on main pushes that carry the masked repo secret
`QUEEK_APP_AUTOMATION_TOKEN` (`.github/workflows/ci.yml`, otherwise the step
skips): create a per-app App Automation Token on the Developer page
(Dashboard → Developers → your app → Automation tokens). The token deploys,
releases and submits that one app only — a 401/403 means it is outside that
app's grant (never a dead session, never a login prompt).

`queek.app.toml` is the local source of truth — same names as the server
manifest, grouped (`[listing]`, `[access]`, `[webhooks]`, `[app]`,
`[[settings]]`, `[extensions]`, `[dashboard]`). Secrets never live there:
`type = "secret"` settings declare a slot only, and the registration secret
(`whsec_…`) lives in `.queek/.env.local` (gitignored).

## Admin UI

The embedded merchant page is a React + shadcn SPA (`admin-ui/`, Queek
registry theme) served by Hono at `GET /admin` — one settings form plus an
example Merchant API call. Build it with `npm run build:admin` (output:
`dist-admin/`, gitignored); the server exchanges the dashboard token at
`POST /admin/session` and guards `GET|PUT /admin/app/api/settings` and
`GET /admin/app/api/store` with its own short session bearer. Local preview
(`queek app dev` + open `/admin` directly) signs in as the dev install.
`admin-ui/src/components/**` are byte-identical copies of the registry
items — refresh with `npx shadcn add @queek/<item> --overwrite` (never
hand-edit; `tests/registry-parity.test.ts` enforces the bytes).

## Routes

`GET /health` (Dokploy check) · `/install` · `/uninstall` · `/settings`
(handoff, signature-verified) · `POST /webhooks` (`orders/updated`) ·
`GET /manifest.json` (the toml rendered with `APP_BASE_URL`) ·
`GET /admin` (embedded React page) · `POST /admin/session` ·
`/admin/app/api/*` (session-guarded JSON).

Installations live in SQLite (`QUEEK_DB_PATH`, `./data/my-app.db` locally —
development only). Production takes `DATABASE_URL` (Postgres, own database)
instead. `GET /health` must stay unauthenticated.

Needs Node 22 (the SDK stores installations in `node:sqlite`; on Node 22.12
and earlier run tests with `NODE_OPTIONS=--experimental-sqlite`).

## License

MIT — see [LICENSE](LICENSE).
