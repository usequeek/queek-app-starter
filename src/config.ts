import { parseStoreKey } from "@usequeek/app-sdk";

/** Runtime config for the app (no side effects; safe to import in tests). */

export const APP_SLUG = "my-app";
export const DEFAULT_BASE_URL = "https://my-app.apps.queek.com.ng";

export interface AppConfig {
  appBaseUrl: string;
  port: number;
  appSecret: string;
  storeKey: string;
  dbPath: string;
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
 * out-of-range PORT, non-https APP_BASE_URL, and a missing or undecodable
 * APP_ENCRYPTION_KEY all fail fast.
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

  return {
    appBaseUrl,
    port,
    appSecret,
    storeKey: rawStoreKey,
    dbPath: env.QUEEK_DB_PATH ?? "./data/my-app.db",
  };
}
