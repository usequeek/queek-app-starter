# My App — Queek app

FIRST run the capacity check: install the Queek AI toolkit
(`github.com/usequeek/queek-ai-toolkit`) and follow its `queek-capacity`
skill before writing any app code:

```sh
npx skills add usequeek/queek-ai-toolkit
```

- Layout — handlers live in `app/` (there is no `src/`): install/uninstall/settings handoff in `app/queek.server.ts` + `app/lifecycle.ts` (answer 2xx first, verify the Merchant API after); embedded admin in `app/routes/admin*` (served at `/admin`); `queek.app.toml` is the manifest source of truth (`queek app deploy` runs the real validator).
- Dev loop: `queek app dev` — tunnel + dev-store install + watch (without the CLI on PATH, prefix every `queek …` command with `npx -y @usequeek/cli`).
- SDK (`@usequeek/app-sdk@0.6.1`) entries: main = server/universal code (handlers, client, stores, verifiers — NOT browser-bundlable); `/server` = session-token verifier; `/hono` = Hono wrappers; `/react` = `<QueekProvider>` + `useQueek()`; `/browser` = plain-browser bridge/theme helpers. Browser code imports from `/browser` (or `/react`), never the main entry.
- Never invent APIs: verify every Merchant API path, scope and webhook topic against the live spec `https://api.usequeek.com/docs/merchant.json` — fetch ONE path at a time with `jq` (per-path fetch tips in `https://api.usequeek.com/docs/merchant/llms.txt`), never the whole file.
- Merchant types are generated, not hand-written: `queek app codegen` writes the committed `types/merchant.ts` (spec hash in its provenance header; `.queek/codegen.json` is a local debug aid). Re-run after every backend deploy and diff before committing. The Merchant client is typed through `createInstallationClient<AppPaths>` over those generated paths.
- UI = shadcn with the Queek theme (`npx shadcn add @queek/queek-theme` + blocks from `https://dashboard.usequeek.com/r/v1/`); use registry blocks, never restyle tokens. The page trades a dashboard token for its own session bearer (`Authorization` header — never cookies, never URLs).

Do not add tooling to this repo: no new build systems, linters, formatters, test frameworks or CI beyond what the starter ships. Fix the app, not the scaffold.
