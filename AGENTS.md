# My App: a Queek app

FIRST run the capacity check. Install the Queek AI toolkit (`github.com/usequeek/queek-ai-toolkit`) and follow its `queek-capacity` skill before you write any app code:

```sh
npx skills add usequeek/queek-ai-toolkit
```

If the skill or the live capability document (`https://api.usequeek.com/docs/capabilities.json`) cannot be fetched, tell the developer, continue with the steps below, and verify every API against the live Merchant spec instead. Never assume a capability.

## Rules

- **Layout.** Handlers live in `app/` (there is no `src/`). The install, uninstall and settings handoff is in `app/queek.server.ts` and `app/lifecycle.ts`: answer 2xx first, verify the Merchant API after. The embedded admin is in `app/routes/admin*`, served at `/admin`. `queek.app.toml` is the manifest source of truth, and `queek app deploy` runs the real validator.
- **Dev loop.** `queek app dev` starts a tunnel, installs on the dev store and watches. Without the CLI on PATH, prefix every `queek` command with `npx -y @usequeek/cli`. Requires Node 22.14 or later (`node:sqlite`).
- **SDK.** Use the `@usequeek/app-sdk` version pinned in `package.json`. Its entries: the main entry is server and universal code (handlers, client, stores, verifiers) and is NOT browser-bundlable; `/server` is the session-token verifier; `/hono` holds the Hono wrappers; `/react` holds `<QueekProvider>` and `useQueek()`; `/browser` holds the plain-browser bridge and theme helpers. Browser code imports from `/browser` (or `/react`), never from the main entry.
- **Never invent APIs.** Verify every Merchant API path, scope and webhook topic against the live spec at `https://api.usequeek.com/docs/merchant.json`. Fetch ONE path at a time with `jq`, never the whole file. Per-path fetch tips are in `https://api.usequeek.com/docs/merchant/llms.txt`.
- **Types are generated.** `queek app codegen` writes the committed `types/merchant.ts` (the spec hash is in its provenance header; `.queek/codegen.json` is a local debug aid). Never edit it by hand. Re-run it when the Merchant API changes and review the diff before you commit. The Merchant client is typed through `createInstallationClient<AppPaths>` over those generated paths.
- **UI.** shadcn with the Queek theme: `npx shadcn add @queek/queek-theme`, plus blocks from `https://dashboard.usequeek.com/r/v1/`. Use registry blocks and never restyle tokens. The page trades a dashboard token for its own session bearer, sent in the `Authorization` header, never in cookies or URLs.
- **Verify before you finish.** Run `npm run typecheck && npm run lint && npm test && npm run build`.
- **No new tooling.** Do not add build systems, linters, formatters, test frameworks or CI beyond what the starter ships. Fix the app, not the scaffold.
