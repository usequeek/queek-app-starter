import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  createAppTokenProvider,
  createInstallationClient,
  createLogger,
  loadAppCredential,
  SqliteInstallationStore,
} from "@usequeek/app-sdk";
import { createInstallHandlers, createWebhookHandler } from "@usequeek/app-sdk/hono";
import { Hono } from "hono";
import { parse as parseToml } from "smol-toml";
import { createAdminRouter, DEFAULT_ADMIN_UI_DIR } from "./admin.js";
import { APP_SLUG, loadConfig, renderManifest, staticManifestFromToml } from "./config.js";
import { buildLifecycle } from "./lifecycle.js";

const config = loadConfig();
const log = createLogger({ service: `queek-app-${APP_SLUG}` });

mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new SqliteInstallationStore({ path: config.dbPath, storeKey: config.storeKey });
// The app credential mints short-lived installation tokens: no
// store-callable key ever crosses the install handoff any more.
const tokens = createAppTokenProvider({
  credential: loadAppCredential({
    appSlug: APP_SLUG,
    keyId: config.appKeyId,
    privateKeyPem: config.appPrivateKey,
  }),
  store,
});

// The static manifest is the grouped `queek.app.toml` — the same file
// `queek app deploy` ships — flattened onto the manifest shape and rendered
// per-request with APP_BASE_URL (see renderManifest).
const staticManifest = staticManifestFromToml(
  parseToml(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "queek.app.toml"), "utf8"),
  ) as Record<string, unknown>,
);

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, app: APP_SLUG, time: new Date().toISOString() }));
app.get("/manifest.json", (c) => c.json(renderManifest(staticManifest, config.appBaseUrl)));

const lifecycle = buildLifecycle({ store, tokens, log });

const handoff = createInstallHandlers({
  appSecret: config.appSecret,
  store,
  onInstall: lifecycle.onInstall,
  onUninstall: lifecycle.onUninstall,
});
// The handoff app already declares /install, /uninstall and /settings —
// merge it at root. The webhook app declares POST / and mounts at /webhooks.
app.route("/", handoff);

const webhooks = createWebhookHandler({
  store,
  handlers: {
    "orders/updated": async (envelope, context) => {
      const order = (envelope.data as Record<string, unknown>).order as Record<string, unknown> | undefined;
      log.info("order updated", {
        store: context.installation.storePid,
        order: String(order?.id ?? "unknown"),
      });
    },
  },
});
app.route("/webhooks", webhooks);

// The embedded admin (React, admin-ui/ built to dist-admin/): the merchant
// page at GET /admin, the session exchange, and the JSON API the page calls
// with its own session bearer. Same store, same token minting, same logger.
app.route(
  "/",
  createAdminRouter({
    installations: store,
    clientFor: (installation) =>
      createInstallationClient({
        installationId: installation.installationId,
        apiBase: installation.apiBase,
        tokens,
      }),
    log,
    dashboardOrigins: config.dashboardOrigins,
    devPreview: process.env.NODE_ENV === "development",
    adminUiDir: DEFAULT_ADMIN_UI_DIR,
  }),
);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("listening", { port: info.port });
});

export { app };
