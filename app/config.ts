import { loadAppCredential, parseStoreKey } from "@usequeek/app-sdk";

/** Runtime config for the app (no side effects; safe to import in tests). */

export const APP_SLUG = "my-app";
export const DEFAULT_BASE_URL = "https://my-app.apps.queek.com.ng";

export interface AppConfig {
  appBaseUrl: string;
  port: number;
  appSecret: string;
  storeKey: string;
  appKeyId: string;
  appPrivateKey: string;
  dbPath: string;
  /**
   * Exact origins of the Queek merchant dashboard that frames the admin
   * page (`QUEEK_DASHBOARD_ORIGINS`, comma-separated https origins): the
   * `frame-ancestors` list and the only postMessage peers. Optional —
   * defaults to the production dashboard so `queek app dev` works without
   * extra env.
   */
  dashboardOrigins: string[];
}

/** The production dashboard origin (the default admin frame-ancestor). */
export const DEFAULT_DASHBOARD_ORIGIN = "https://dashboard.usequeek.com";

/** `https://host[:port]` origins only — no path, query, userinfo or wildcard. */
export function parseOrigins(raw: string, name: string): string[] {
  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (origins.length === 0) throw new Error(`Missing required env ${name} (see .env.example).`);
  return origins.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid ${name} entry ${JSON.stringify(value)}: must be an https origin.`);
    }
    if (url.protocol !== "https:" || url.origin !== value.replace(/\/+$/, "") || url.username !== "") {
      throw new Error(`Invalid ${name} entry ${JSON.stringify(value)}: must be a bare https origin.`);
    }
    return url.origin;
  });
}

/**
 * Map the grouped `queek.app.toml` onto the flat manifest shape (the same
 * groups the CLI deploys: top level, [listing], [access], [webhooks], [app],
 * [[settings]], [extensions], [dashboard]). No validation here — `queek app
 * deploy` runs the real manifest validation; this only flattens so boot and
 * tests read the same file the deploy ships.
 */
export function staticManifestFromToml(doc: Record<string, unknown>): Record<string, unknown> {
  const manifest: Record<string, unknown> = {};
  for (const key of ["slug", "name", "distribution", "icon", "developer", "category"] as const) {
    if (doc[key] !== undefined) manifest[key] = doc[key];
  }
  const listing = (doc.listing ?? {}) as Record<string, unknown>;
  for (const key of [
    "description",
    "tagline",
    "description_long",
    "highlights",
    "logo_url",
    "pricing",
    "developer_url",
    "privacy_url",
    "support_url",
  ] as const) {
    if (listing[key] !== undefined) manifest[key] = listing[key];
  }
  const access = (doc.access ?? {}) as Record<string, unknown>;
  if (access.scopes !== undefined) manifest.scopes = access.scopes;
  const webhooks = (doc.webhooks ?? {}) as Record<string, unknown>;
  if (webhooks.topics !== undefined) manifest.webhook_topics = webhooks.topics;
  if (webhooks.url !== undefined) manifest.webhook_url = webhooks.url;
  const app = (doc.app ?? {}) as Record<string, unknown>;
  for (const key of ["install_url", "uninstall_url", "settings_url"] as const) {
    if (app[key] !== undefined) manifest[key] = app[key];
  }
  if (doc.settings !== undefined) manifest.settings = doc.settings;
  if (doc.extensions !== undefined) manifest.extensions = doc.extensions;
  if (doc.dashboard !== undefined) manifest.dashboard = doc.dashboard;
  return manifest;
}

const URL_FIELDS = [
  "install_url",
  "uninstall_url",
  "settings_url",
  "webhook_url",
  "logo_url",
  "developer_url",
  "privacy_url",
  "support_url",
] as const;

/**
 * The servable manifest: the static manifest (from `queek.app.toml`) with
 * its base URL substituted from `APP_BASE_URL`, so staging renders staging
 * URLs without forking the file. Served at GET /manifest.json.
 */
export function renderManifest(
  staticManifest: Record<string, unknown>,
  appBaseUrl: string,
): Record<string, unknown> {
  const base = appBaseUrl.replace(/\/+$/, "");
  const rendered = JSON.parse(JSON.stringify(staticManifest)) as Record<string, unknown>;
  const substitute = (value: unknown): unknown =>
    typeof value === "string" && value.startsWith(DEFAULT_BASE_URL)
      ? `${base}${value.slice(DEFAULT_BASE_URL.length)}`
      : value;
  for (const field of URL_FIELDS) {
    rendered[field] = substitute(rendered[field]);
  }
  const extensions = rendered.extensions;
  if (extensions && typeof extensions === "object" && !Array.isArray(extensions)) {
    const record = extensions as Record<string, unknown>;
    const proxy = record.proxy;
    if (proxy && typeof proxy === "object" && !Array.isArray(proxy)) {
      const proxyRecord = proxy as Record<string, unknown>;
      proxyRecord.url = substitute(proxyRecord.url);
    }
    const blocks = record.blocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks) {
        if (block && typeof block === "object" && !Array.isArray(block)) {
          const blockRecord = block as Record<string, unknown>;
          blockRecord.link_url = substitute(blockRecord.link_url);
        }
      }
    }
    if (typeof record.merchant_page_url === "string") {
      record.merchant_page_url = substitute(record.merchant_page_url);
    }
  }
  return rendered;
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env ${name} (see .env.example).`);
  }
  return value.trim();
}

/**
 * Strict boot config: every value is validated here, once, with a clear
 * error — the server never starts half-configured. Non-numeric or
 * out-of-range PORT, non-https APP_BASE_URL, a missing or undecodable
 * APP_ENCRYPTION_KEY, and an unparseable APP_PRIVATE_KEY/APP_KEY_ID pair
 * all fail fast.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawBase = env.APP_BASE_URL ?? DEFAULT_BASE_URL;
  let base: URL;
  try {
    base = new URL(rawBase.trim());
  } catch {
    throw new Error(`Invalid APP_BASE_URL ${JSON.stringify(rawBase)}: must be an https URL.`);
  }
  if (base.protocol !== "https:") {
    throw new Error(
      `Invalid APP_BASE_URL ${JSON.stringify(rawBase)}: https only (Queek calls back over https).`,
    );
  }
  const appBaseUrl = base.toString().replace(/\/+$/, "");

  const rawPort = (env.PORT ?? "3000").trim();
  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`Invalid PORT ${JSON.stringify(env.PORT)}: must be a number 1-65535.`);
  }
  const port = Number(rawPort);
  if (port < 1 || port > 65535) {
    throw new Error(`Invalid PORT ${JSON.stringify(env.PORT)}: must be a number 1-65535.`);
  }

  const appSecret = required("QUEEK_APP_SECRET", env);
  const rawStoreKey = required("APP_ENCRYPTION_KEY", env);
  try {
    parseStoreKey(rawStoreKey);
  } catch (error) {
    throw new Error(`Invalid APP_ENCRYPTION_KEY: ${error instanceof Error ? error.message : "undecodable"}`);
  }
  // The asymmetric app key mints short-lived installation tokens (no
  // store-callable key crosses the install handoff). The PEM must parse as
  // RSA here, once — never mid-mint.
  const appKeyId = required("APP_KEY_ID", env);
  const appPrivateKey = required("APP_PRIVATE_KEY", env);
  try {
    loadAppCredential({ appSlug: APP_SLUG, keyId: appKeyId, privateKeyPem: appPrivateKey });
  } catch (error) {
    throw new Error(
      `Invalid APP_PRIVATE_KEY/APP_KEY_ID: ${error instanceof Error ? error.message : "undecodable"}`,
    );
  }

  return {
    appBaseUrl,
    port,
    appSecret,
    storeKey: rawStoreKey,
    appKeyId,
    appPrivateKey,
    dbPath: env.QUEEK_DB_PATH ?? "./data/my-app.db",
    dashboardOrigins: parseOrigins(
      env.QUEEK_DASHBOARD_ORIGINS ?? DEFAULT_DASHBOARD_ORIGIN,
      "QUEEK_DASHBOARD_ORIGINS",
    ),
  };
}
