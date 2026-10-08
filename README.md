# My App

A [Queek](https://usequeek.com) installable app, from
[`usequeek/queek-app-starter`](https://github.com/usequeek/queek-app-starter):
a full-stack React Router app — server loaders and actions over
[`@usequeek/app-sdk`](https://www.npmjs.com/package/@usequeek/app-sdk) —
plus shadcn with the Queek registry preinstalled.

Layout: `app/routes.ts` (`flatRoutes`) defines the routes;
`app/queek.server.ts` holds config, the installation store, token minting
and the install/webhook/session helpers (over `@usequeek/app-sdk@0.6.1`);
`app/routes/admin*` is the embedded admin UI (shadcn + Queek registry);
`app/entry.server.tsx` adds the dashboard-only `frame-ancestors` CSP;
`queek.app.toml` is the app manifest. The one Merchant API call
(`GET /admin/api/store`) goes through the SDK installation client, typed
through `createInstallationClient<AppPaths>` over the generated
`types/merchant.ts` (refresh with `npm run codegen`).

SDK entries (`@usequeek/app-sdk@0.6.1`): main = server/universal code
(handlers, client, stores, verifiers — NOT browser-bundlable); `/server` =
session-token verifier; `/hono` = Hono wrappers; `/react` =
`<QueekProvider>` + `useQueek()`; `/browser` = plain-browser bridge/theme
helpers. Browser code imports from `/browser` (or `/react`), never the
main entry.

Merchant types are generated, not hand-written: `npm run codegen`
(`queek app codegen`) regenerates the committed `types/merchant.ts` from
the live Merchant spec (`https://api.usequeek.com/docs/merchant.json`) —
no login needed, offline runs keep the existing types. Re-run it when the
Merchant API changes and diff before committing.

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## Develop

Prerequisite: the Queek CLI (`@usequeek/cli` — the same CLI CI deploys
with: `npx -y @usequeek/cli app deploy`). `npm run dev` is `queek app dev`,
so without the CLI on PATH it fails with `queek: command not found`.
Install it once:

```bash
npm install -g @usequeek/cli
```

(or prefix every `queek …` command below with `npx -y @usequeek/cli` —
no install needed). Then:

```bash
npm install
npm run dev   # the whole loop: tunnel + dev-store install + your app, started with the dev env
```

`queek app dev` registers `queek.app.toml` as a `development` build, installs
it on an owned dev store, then starts the app from the toml's `[dev]` table
(`node ./server.js`) with the dev env injected: `APP_BASE_URL` (the
tunnel origin), `PORT`, `NODE_ENV=development`, plus the signing secret,
keypair and encryption key from `.queek/.env.local` (minted on first run,
never printed). Your project's own `.env` fills the rest. In development the
server runs Vite in middleware mode (HMR); in production it serves the
React Router build. Save `queek.app.toml` to re-register; `Ctrl+C` stops the
app and the tunnel. When the app answers `/health`, the command prints the
store-admin and storefront links — open them.

Without the CLI: `npm run dev:server` runs the same server (needs the env
from `.env.example` yourself).

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

The embedded merchant page is React Router + shadcn (`app/routes/admin*`,
Queek registry theme): home (the store profile, the example Merchant API
call) plus one settings form. Server loaders render the shell; the page
trades the dashboard token at `POST /admin/session` for its own short
session bearer and calls `GET /admin/api/store` and `GET|PUT
/admin/api/settings` with it (`Authorization` header — never cookies, never
URLs). Local preview (`queek app dev` + open `/admin` directly on this
machine) signs in as the dev install via `POST /admin/dev-session`
(loopback without forwarding headers only — a public tunnel URL answers
404). `app/components/**` are copies of the registry items — refresh with
`npx shadcn add @queek/<item> --overwrite` (never hand-edit;
`tests/registry.test.ts` pins the provenance).

## Routes

`GET /health` (your host's health check) · `/install` · `/uninstall` · `/settings`
(handoff, signature-verified) · `POST /webhooks` (`orders/updated`) ·
`GET /manifest.json` (the toml rendered with `APP_BASE_URL`) ·
`/admin` (embedded home + settings, session-guarded JSON under
`/admin/api/*`, exchange at `POST /admin/session`).

Installations live in SQLite (`QUEEK_DB_PATH`, `./data/my-app.db` locally —
development only). Production takes `DATABASE_URL` (Postgres, own database)
instead. `GET /health` must stay unauthenticated.

Needs Node >= 22.14 (the SDK stores installations in `node:sqlite`, stable since 22.14).

## License

MIT — see [LICENSE](LICENSE).
