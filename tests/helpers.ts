import { generateKeyPairSync } from "node:crypto";
import { signQueekPayload } from "@usequeek/app-sdk";
import { resetRuntime, resetSessionThrottle } from "../app/queek.server.js";

const VALID_KEY = Buffer.alloc(32, 5).toString("base64");

/** Ephemeral test-only RSA key (generated per call, never committed, never real). */
export function testEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return {
    APP_BASE_URL: "https://my-app.apps.queek.com.ng",
    PORT: "3000",
    QUEEK_APP_SECRET: "whsec_dGVzdGFwcHNlY3JldHRlc3RhcHBzZWNyZXQ=",
    APP_ENCRYPTION_KEY: VALID_KEY,
    APP_KEY_ID: "test-kid-1",
    APP_PRIVATE_KEY: privateKey,
    QUEEK_DB_PATH: ":memory:",
    NODE_ENV: "test",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

const MANAGED_KEYS = [
  "APP_BASE_URL",
  "PORT",
  "QUEEK_APP_SECRET",
  "APP_ENCRYPTION_KEY",
  "APP_KEY_ID",
  "APP_PRIVATE_KEY",
  "QUEEK_DB_PATH",
  "NODE_ENV",
];

/** Install a fresh runtime env (in-memory store) for one test; returns a restore function. */
export function useRuntime(overrides: Record<string, string | undefined> = {}): () => void {
  const saved = new Map(MANAGED_KEYS.map((key) => [key, process.env[key]]));
  Object.assign(process.env, testEnv(overrides));
  resetRuntime();
  resetSessionThrottle();
  return () => {
    for (const key of MANAGED_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetRuntime();
    resetSessionThrottle();
  };
}

/** Standard-Webhooks headers for a body, exactly as Queek signs it. */
export function signedDelivery(
  body: string,
  secret: string,
  id = `evt-${Math.random().toString(36).slice(2)}`,
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signQueekPayload(id, timestamp, body, secret),
  };
}
