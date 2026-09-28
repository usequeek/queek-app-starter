import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const VALID_KEY = Buffer.alloc(32, 5).toString("base64");

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    APP_BASE_URL: "https://my-app.apps.queek.com.ng",
    PORT: "3000",
    QUEEK_APP_SECRET: "whsec_dGVzdGFwcHNlY3JldHRlc3RhcHBzZWNyZXQ=",
    APP_ENCRYPTION_KEY: VALID_KEY,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("strict boot config", () => {
  it("loads valid env", () => {
    const config = loadConfig(env());
    expect(config.port).toBe(3000);
    expect(config.appBaseUrl).toBe("https://my-app.apps.queek.com.ng");
  });

  it("defaults PORT and trims a trailing slash on the base URL", () => {
    const config = loadConfig(
      env({
        PORT: undefined,
        APP_BASE_URL: "https://my-app.apps.queek.com.ng/",
      }),
    );
    expect(config.port).toBe(3000);
    expect(config.appBaseUrl).toBe("https://my-app.apps.queek.com.ng");
  });

  it.each(["abc", "3.5", "-1", "0", "65536", "99999"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig(env({ PORT: port }))).toThrow(/Invalid PORT/);
  });

  it.each(["http://my-app.apps.queek.com.ng", "notaurl", ""])("rejects APP_BASE_URL=%s", (base) => {
    expect(() => loadConfig(env({ APP_BASE_URL: base }))).toThrow(/APP_BASE_URL/);
  });

  it("rejects a missing app secret and a missing/invalid storage key", () => {
    expect(() => loadConfig(env({ QUEEK_APP_SECRET: "" }))).toThrow(/QUEEK_APP_SECRET/);
    expect(() => loadConfig(env({ APP_ENCRYPTION_KEY: "" }))).toThrow(/APP_ENCRYPTION_KEY/);
    expect(() => loadConfig(env({ APP_ENCRYPTION_KEY: "too-short" }))).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
