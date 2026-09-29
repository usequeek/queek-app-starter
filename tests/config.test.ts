import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APP_SLUG,
  DEFAULT_BASE_URL,
  loadConfig,
  renderManifest,
  staticManifestFromToml,
} from "../src/config.js";

const VALID_KEY = Buffer.alloc(32, 5).toString("base64");
// Ephemeral test-only RSA key (generated per run, never committed, never real).
const { privateKey: TEST_PRIVATE_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Expectations derive from src/config.ts (APP_SLUG/DEFAULT_BASE_URL), never a
// hardcoded slug — `npm create` renames both, and the scaffold must stay green.
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_BASE_URL: DEFAULT_BASE_URL,
    PORT: "3000",
    QUEEK_APP_SECRET: "whsec_dGVzdGFwcHNlY3JldHRlc3RhcHBzZWNyZXQ=",
    APP_ENCRYPTION_KEY: VALID_KEY,
    APP_KEY_ID: "test-kid-1",
    APP_PRIVATE_KEY: TEST_PRIVATE_KEY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("strict boot config", () => {
  it("loads valid env", () => {
    const config = loadConfig(env());
    expect(config.port).toBe(3000);
    expect(config.appBaseUrl).toBe(DEFAULT_BASE_URL);
    expect(APP_SLUG).not.toBe("");
  });

  it("defaults PORT and trims a trailing slash on the base URL", () => {
    const config = loadConfig(
      env({
        PORT: undefined,
        APP_BASE_URL: `${DEFAULT_BASE_URL}/`,
      }),
    );
    expect(config.port).toBe(3000);
    expect(config.appBaseUrl).toBe(DEFAULT_BASE_URL);
  });

  it.each(["abc", "3.5", "-1", "0", "65536", "99999"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig(env({ PORT: port }))).toThrow(/Invalid PORT/);
  });

  it.each([DEFAULT_BASE_URL.replace("https://", "http://"), "notaurl", ""])(
    "rejects APP_BASE_URL=%s",
    (base) => {
      expect(() => loadConfig(env({ APP_BASE_URL: base }))).toThrow(/APP_BASE_URL/);
    },
  );

  it("rejects a missing app secret and a missing/invalid storage key", () => {
    expect(() => loadConfig(env({ QUEEK_APP_SECRET: "" }))).toThrow(/QUEEK_APP_SECRET/);
    expect(() => loadConfig(env({ APP_ENCRYPTION_KEY: "" }))).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => loadConfig(env({ APP_ENCRYPTION_KEY: "too-short" }))).toThrow(/APP_ENCRYPTION_KEY/);
  });

  it("rejects a missing or unparseable app key pair", () => {
    expect(() => loadConfig(env({ APP_KEY_ID: "" }))).toThrow(/APP_KEY_ID/);
    expect(() => loadConfig(env({ APP_PRIVATE_KEY: "" }))).toThrow(/APP_PRIVATE_KEY/);
    expect(() => loadConfig(env({ APP_PRIVATE_KEY: "not-a-pem" }))).toThrow(/APP_PRIVATE_KEY/);
  });
});

describe("static manifest from queek.app.toml", () => {
  const doc = {
    slug: APP_SLUG,
    access: { scopes: ["merchant-business_profile-read"] },
    webhooks: { topics: ["orders/updated"], url: `${DEFAULT_BASE_URL}/webhooks` },
    app: { install_url: `${DEFAULT_BASE_URL}/install` },
  };

  it("flattens the groups without validating", () => {
    const manifest = staticManifestFromToml(doc);
    expect(manifest.slug).toBe(APP_SLUG);
    expect(manifest.scopes).toEqual(["merchant-business_profile-read"]);
    expect(manifest.webhook_topics).toEqual(["orders/updated"]);
  });

  it("renders staging URLs from APP_BASE_URL", () => {
    const rendered = renderManifest(staticManifestFromToml(doc), "https://staging.example.test");
    expect(rendered.install_url).toBe("https://staging.example.test/install");
    expect(rendered.webhook_url).toBe("https://staging.example.test/webhooks");
  });
});
