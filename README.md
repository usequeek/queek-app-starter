# My App

A starter for [Queek](https://usequeek.com) installable apps. It is a React Router app with server loaders and actions, built on [`@usequeek/app-sdk`](https://www.npmjs.com/package/@usequeek/app-sdk), with the Queek shadcn theme preinstalled.

It already does the parts every app needs: the signed install, uninstall and settings handoff, webhook verification, an embedded admin page inside the Queek dashboard, one typed Merchant API call, and a Dockerfile for production.

## Requirements

- Node.js 22.14 or later (the SDK stores installations in `node:sqlite` during development)
- A Queek account with developer access. See [Build an app](https://docs.usequeek.com/docs/apps/build-an-app) for the steps.
- The Queek CLI, `@usequeek/cli`. Install it once with `npm install -g @usequeek/cli`, or prefix each `queek` command below with `npx -y @usequeek/cli`.

## Quick start

```bash
npm create @usequeek/app my-app   # or: queek app init my-app
cd my-app
npm install
npm run dev
```

`npm run dev` runs `queek app dev`. It starts a tunnel, registers `queek.app.toml` as a development build, installs the app on your dev store, and starts the server from the `[dev]` table of the manifest (`node ./server.js`). The app gets its environment from `.queek/.env.local`, which the CLI creates on first run and never prints. Your own `.env` supplies the rest. When `/health` answers, the CLI prints the store admin and storefront links.

Edit `queek.app.toml` and save to register the change. `Ctrl+C` stops the app and the tunnel.

Without the CLI, `npm run dev:server` starts the same server. You then set the variables from `.env.example` yourself.

## Check your work

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

| Script | What it does |
| --- | --- |
| `npm run dev` | `queek app dev`: tunnel, dev-store install, watch |
| `npm run dev:server` | The server alone, in development mode with Vite HMR |
| `npm start` | The server on the production build (run `npm run build` first) |
| `npm run codegen` | Regenerate `types/merchant.ts` from the live Merchant API spec |
| `npm run deploy` | `queek app deploy`: manifest to a new app version |
| `npm run typecheck` | React Router typegen, then `tsc --noEmit` |
| `npm run lint` | Biome check (`npm run lint:fix` applies fixes) |
| `npm test` | Vitest |

## Project layout

| Path | Purpose |
| --- | --- |
| `queek.app.toml` | The app manifest and the source of truth for `queek app deploy` |
| `app/queek.server.ts` | Config, installation store, token minting and the handoff, webhook and session helpers |
| `app/lifecycle.ts` | Install and uninstall callbacks |
| `app/admin-session.ts` | Exchanges a dashboard session token for the app's own short admin session |
| `app/routes/` | Routes, defined by file name through `flatRoutes` in `app/routes.ts` |
| `app/routes/admin*` | The embedded admin page and its JSON endpoints |
| `app/entry.server.tsx` | Sets the `frame-ancestors` policy that lets only the dashboard frame `/admin` |
| `app/components/` | shadcn components copied from the Queek registry |
| `server.js` | Express host: React Router build in production, Vite middleware in development |
| `types/merchant.ts` | Generated Merchant API types. Never edit by hand. |
| `Dockerfile` | One production image for the app |

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Readiness for your host. Unauthenticated. Answers 200 when the config is valid and the store is open, otherwise 503. |
| `POST /install`, `/uninstall`, `/settings` | Signed handoff from Queek. Verified with `QUEEK_APP_SECRET`. |
| `POST /webhooks` | Topic deliveries (`orders/updated`). Verified per installation. |
| `GET /manifest.json` | `queek.app.toml` rendered with `APP_BASE_URL` |
| `/admin` | The embedded page. Session-guarded JSON lives under `/admin/api/*`. |
| `POST /admin/session` | Trades the dashboard token for the page's own session bearer |

The Merchant API call is `GET /admin/api/store`. It goes through `createInstallationClient<AppPaths>`, typed by the generated `types/merchant.ts`.

## Admin page and sessions

The admin page is React Router plus shadcn. Server loaders render the shell. The browser then trades the dashboard token at `POST /admin/session` for a short session bearer and sends it in the `Authorization` header on every call. Cookies and URLs never carry it. The page sits in a cross-site frame, where cookies are unreliable.

To preview outside the dashboard, run `queek app dev` and open `/admin` on the same machine. The page signs in as your dev install through `POST /admin/dev-session`. That route works only in development, only on a loopback address, and only when no forwarding headers are present, so a public tunnel URL gets a 404.

`app/components/**` are copies of registry items. Refresh one with `npx shadcn add @queek/<item> --overwrite` and do not edit it by hand. `tests/registry.test.ts` pins where each came from.

## Merchant API types

`types/merchant.ts` is generated, not written. `npm run codegen` reads the live spec at `https://api.usequeek.com/docs/merchant.json` and rewrites the file. No login is needed, and an offline run keeps the existing types. Run it when the Merchant API changes, then review the diff before you commit.

## Configuration

Every variable is documented in `.env.example`. In development `queek app dev` injects the credentials, so you set none of them by hand.

| Variable | Purpose |
| --- | --- |
| `APP_BASE_URL` | Public https origin of the app. Must match the URLs in `queek.app.toml`. |
| `QUEEK_APP_SECRET` | `whsec_` signing secret, shown once by the first `queek app deploy` |
| `APP_ENCRYPTION_KEY` | 32 random bytes, base64 or hex. Encrypts installation secrets at rest. |
| `APP_KEY_ID`, `APP_PRIVATE_KEY` | The app key pair that mints short-lived installation tokens |
| `DATABASE_URL` | Postgres database of the app's own. Required in production. |
| `QUEEK_DB_PATH` | SQLite file for development only. Production refuses SQLite. |
| `QUEEK_DASHBOARD_ORIGINS` | Dashboard origins allowed to frame `/admin`. Defaults to the production dashboard. |
| `PORT`, `HOST` | Listen port (default 3000) and optional bind address |

The server validates all of this at boot and names the variable that is wrong. Secrets never go in `queek.app.toml`: a `type = "secret"` setting declares a slot only.

## Deploy

Queek calls your app over https, so a deployed app needs a public https URL.

1. Build and run the image. It runs as the unprivileged `node` user and reports health through `/health`.

   ```bash
   docker build -t my-app .
   docker run --init -p 3000:3000 --env-file .env -e DATABASE_URL=postgres://... my-app
   ```

   The container drains in-flight requests on `SIGTERM` and exits within ten seconds.

2. Put the public origin in `queek.app.toml` and `APP_BASE_URL`, then register the version:

   ```bash
   queek app deploy
   queek app versions list my-app
   queek app release my-app 1.2.0
   queek app submit my-app        # sends the version to review
   ```

   `queek app deploy` prints the registration secret once, in an interactive terminal. Store it as `QUEEK_APP_SECRET`.

CI runs the checks on every push and pull request, builds the image, and runs `queek app deploy` on pushes to `main` when the repository secret `QUEEK_APP_AUTOMATION_TOKEN` exists. Create that token under Dashboard, Developers, your app, Automation tokens. It can deploy, release and submit that one app and nothing else. A 401 or 403 means the app is outside the token's grant.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `queek: command not found` | Install the CLI (see Requirements) or use `npx -y @usequeek/cli`. |
| `/health` answers 503 | The log names the missing or malformed variable. Fix it and restart. |
| `Refusing to start on SQLite in production` | Set `DATABASE_URL` to the app's Postgres database. |
| `/admin` shows 401 outside the dashboard | Open it from the dashboard, or use the loopback preview described above. |
| Types look stale | Run `npm run codegen` and review the diff. |

## Versioning and support

This is a template. Fork it and keep your copy; it is not a library to depend on. The SDK version is pinned in `package.json` and the lockfile. Raise it deliberately and read its release notes first.

Questions and bugs: open an issue on [`usequeek/queek-app-starter`](https://github.com/usequeek/queek-app-starter/issues). Pull requests that fix the starter are welcome, and they must keep `typecheck`, `lint`, `test` and `build` green. Report a vulnerability to Queek support privately, never in a public issue.

## License

MIT. See [LICENSE](LICENSE). Copyright Queekx Technology LTD.
