# My App — Queek app

Use the Queek AI toolkit (`usequeek/queek-ai-toolkit` skills: `queek-app`, `queek-manifest`, `queek-bridge`, `queek-review`, `queek-types`) — do not add tooling to this repo.

- UI = shadcn with the Queek theme (`npx shadcn add @queek/queek-theme` + blocks from `https://dashboard.usequeek.com/r/v1/`); use registry blocks, never restyle tokens.
- Embedded admin is React Router (`app/routes/admin*`, served at `/admin`); the page trades a dashboard token for its own session bearer (`Authorization` header — never cookies, never URLs).
- Install handoff first (answer 2xx), Merchant API verify after — see `app/lifecycle.ts`.
- `queek.app.toml` is the manifest source of truth; `queek app deploy` runs the real validator.
