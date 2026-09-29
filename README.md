# My App

A [Queek](https://usequeek.com) installable app, from
[`usequeek/queek-app-starter`](https://github.com/usequeek/queek-app-starter).

## Develop

```bash
npm install
cp .env.example .env   # fill in QUEEK_APP_SECRET + APP_ENCRYPTION_KEY
npm run build && npm start   # terminal 1: the app server
queek login                  # once: browser OAuth for a developer token
queek app dev                # terminal 2: tunnel + test-store install + watch
```

`queek app dev` registers `queek.app.toml` as a `development` build, installs it
on an owned test store, and re-registers whenever the toml changes. The app
server itself (`npm start`) stays yours to run.

## Deploy & submit

```bash
queek app deploy            # toml → version N+1 (secret shown once on first registration)
queek app versions list my-app
queek app release my-app 1.2.0
queek app submit my-app     # → in_review
```

CI deploys on main pushes that carry the masked repo secret
`QUEEK_APP_AUTOMATION_TOKEN` (`.github/workflows/ci.yml`, otherwise the step
skips): create a per-app App Automation Token on the Developer page
(Dashboard → Developers → your app → Automation tokens). The token deploys,
releases and submits that one app only — a 403 means it belongs to a
different app.

`queek.app.toml` is the local source of truth — same names as the server
manifest, grouped (`[listing]`, `[access]`, `[webhooks]`, `[app]`,
`[[settings]]`, `[extensions]`, `[dashboard]`). Secrets never live there:
`type = "secret"` settings declare a slot only, and the registration secret
(`whsec_…`) lives in `.queek/.env.local` (gitignored).

## Routes

`GET /health` (Dokploy check) · `/install` · `/uninstall` · `/settings`
(handoff, signature-verified) · `POST /webhooks` (`orders/updated`) ·
`GET /manifest.json` (the toml rendered with `APP_BASE_URL`).

Installations live in SQLite (`QUEEK_DB_PATH`, `./data/my-app.db` locally —
development only). Production takes `DATABASE_URL` (Postgres, own database)
instead. `GET /health` must stay unauthenticated.

Needs Node 22 (the SDK stores installations in `node:sqlite`; on Node 22.12
and earlier run tests with `NODE_OPTIONS=--experimental-sqlite`).

## License

MIT — see [LICENSE](LICENSE).
