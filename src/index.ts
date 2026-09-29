import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  buildInstallationRecord,
  createAppTokenProvider,
  createInstallationClient,
  createLogger,
  type InstallEnvelope,
  InvalidApiBaseError,
  loadAppCredential,
  QueekApiError,
  SqliteInstallationStore,
} from "@usequeek/app-sdk";
import { createInstallHandlers, createWebhookHandler } from "@usequeek/app-sdk/hono";
import { Hono } from "hono";
import { parse as parseToml } from "smol-toml";
import { APP_SLUG, loadConfig, renderManifest, staticManifestFromToml } from "./config.js";

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

async function onInstall(envelope: InstallEnvelope): Promise<void> {
  const { data } = envelope;
  // Save first, then prove the minted credential works BEFORE answering 2xx:
  // GET /store through the installation client. A failed proof on a fresh
  // row purges it (non-2xx → Queek revokes the install). Only the store p_id
  // is logged — never a token.
  const existing = await store.getInstallation(data.installation.id);
  await store.saveInstallation(buildInstallationRecord(data));
  const client = createInstallationClient({
    installationId: data.installation.id,
    apiBase: data.api_base,
    tokens,
  });
  let storePid: string;
  try {
    const profile = (await client.getStore()) as unknown as Record<string, unknown>;
    const nested = profile.data as Record<string, unknown> | undefined;
    const pid = nested?.p_id ?? profile.p_id;
    storePid = typeof pid === "string" ? pid : "unknown";
  } catch (error) {
    if (!existing) await store.deleteInstallation(data.installation.id);
    log.error("install proof-call failed", { installation: data.installation.p_id });
    if (error instanceof QueekApiError || error instanceof InvalidApiBaseError) throw error;
    throw new Error("Merchant API proof-call failed.");
  }
  log.info("installed", { store: storePid, installation: data.installation.p_id });
}

const handoff = createInstallHandlers({
  appSecret: config.appSecret,
  store,
  onInstall,
  onUninstall: async (envelope) => {
    await store.deleteInstallation(envelope.data.installation.id);
    log.info("uninstalled", { installation: envelope.data.installation.p_id });
  },
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info("listening", { port: info.port });
});

export { app };
