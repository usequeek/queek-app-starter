import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import {
  buildInstallationRecord,
  createInstallHandlers,
  createLogger,
  createQueekClient,
  createWebhookHandler,
  type InstallEnvelope,
  InvalidApiBaseError,
  QueekApiError,
  SqliteInstallationStore,
} from "@usequeek/app-sdk";
import { Hono } from "hono";
import { APP_SLUG, loadConfig } from "./config.js";

const config = loadConfig();
const log = createLogger({ service: `queek-app-${APP_SLUG}` });

mkdirSync(dirname(config.dbPath), { recursive: true });
const store = new SqliteInstallationStore({
  path: config.dbPath,
  storeKey: config.storeKey,
});

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, app: APP_SLUG, time: new Date().toISOString() }));

async function onInstall(envelope: InstallEnvelope): Promise<void> {
  const { data } = envelope;
  // Prove the handed-off key works BEFORE answering 2xx: GET /store through
  // the Merchant API. Only the store p_id is logged — never the key.
  // createQueekClient validates api_base (https + allowlisted host) before
  // any fetch, so a rogue handoff fails closed here.
  const client = createQueekClient({
    apiBase: data.api_base,
    apiKey: data.api_key,
  });
  let storePid: string;
  try {
    const profile = (await client.getStore()) as unknown as Record<string, unknown>;
    const nested = profile.data as Record<string, unknown> | undefined;
    const pid = nested?.p_id ?? profile.p_id;
    storePid = typeof pid === "string" ? pid : "unknown";
  } catch (error) {
    // A dead key (or a rogue api_base) must fail the install
    // (non-2xx → Queek revokes it).
    log.error("install proof-call failed", {
      installation: data.installation.p_id,
    });
    if (error instanceof QueekApiError || error instanceof InvalidApiBaseError) throw error;
    throw new Error("Merchant API proof-call failed.");
  }
  await store.saveInstallation(buildInstallationRecord(data));
  log.info("installed", {
    store: storePid,
    installation: data.installation.p_id,
  });
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
