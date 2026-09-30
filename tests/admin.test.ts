import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstallationRecord, createLogger, SqliteInstallationStore } from "@usequeek/app-sdk";
import { describe, expect, it } from "vitest";
import { createAdminRouter } from "../src/admin.js";
import { issueAdminSession } from "../src/admin-session.js";

const STORE_KEY = Buffer.alloc(32, 7).toString("base64");
const API_BASE = "https://queek.test/api/v1/merchant";
const DASHBOARD_ORIGINS = ["https://dashboard.usequeek.com"];
const EMBED_SECRET = `embsec_${randomBytes(32).toString("base64")}`;
const INSTALLATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VENDOR_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const FAKE_PROFILE = { data: { p_id: "store_xyz", name: "Suya Spots" } };

function installData(settings: Record<string, unknown> = {}) {
  return {
    installation: { id: INSTALLATION_ID, p_id: "inst_starter_admin" },
    app_id: "0199f0c2-app-starter",
    store: { id: VENDOR_ID, p_id: "store_xyz", name: "Suya Spots", is_test: true },
    api_base: API_BASE,
    scopes: ["merchant-business_profile-read"],
    settings,
    webhook_secret: null,
    proxy_secret: null,
    embed_secret: EMBED_SECRET,
    webhook_url: "https://my-app.apps.queek.com.ng/webhooks",
    webhook_topics: ["orders/updated"],
  } as never;
}

/** A dashboard session token exactly as the backend mints it (HS256 under the embed secret). */
function dashboardToken(secret: string = EMBED_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const head = encode({ typ: "JWT", alg: "HS256" });
  const body = encode({
    aud: "my-app",
    iss: API_BASE,
    sub: "user-uuid-merchant",
    sid: randomUUID(),
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: now + 60,
    installation_id: INSTALLATION_ID,
    vendor_id: VENDOR_ID,
    app_slug: "my-app",
    app_id: "0199f0c2-app-starter",
  });
  const signature = createHmac("sha256", secret).update(`${head}.${body}`, "utf8").digest("base64url");
  return `${head}.${body}.${signature}`;
}

/** A built admin-ui/ directory: index.html with the config placeholder, one asset, theme-boot. */
function builtAdminUi(): string {
  const dir = mkdtempSync(join(tmpdir(), "starter-admin-ui-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    '<!doctype html><html><head><script src="/admin/theme-boot.js"></script><script type="application/json" id="queek-admin-config">"__QUEEK_ADMIN_CONFIG__"</script></head><body><div id="root"></div></body></html>',
  );
  writeFileSync(join(dir, "assets", "index-abc.js"), "console.log(1)");
  writeFileSync(join(dir, "theme-boot.js"), "void 0");
  return dir;
}

function quietLog() {
  return createLogger({ service: "admin-test", sink: () => undefined });
}

interface BootOptions {
  withUi: boolean;
  devPreview?: boolean;
  storeFails?: boolean;
}

async function boot(options: BootOptions) {
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  await store.saveInstallation(buildInstallationRecord(installData()));
  const router = createAdminRouter({
    installations: store,
    clientFor: () => ({
      getStore: async () => {
        if (options.storeFails) throw new Error("Queek is down");
        return FAKE_PROFILE as never;
      },
    }),
    log: quietLog(),
    dashboardOrigins: DASHBOARD_ORIGINS,
    devPreview: options.devPreview,
    adminUiDir: options.withUi ? builtAdminUi() : null,
  });
  const session = await router.request("/admin/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${dashboardToken()}` },
  });
  expect(session.status).toBe(200);
  const bearer = ((await session.json()) as { token: string }).token;
  const call = (method: string, path: string, body?: unknown) =>
    router.request(`/admin/app/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { router, store, call };
}

describe("admin shell", () => {
  it("serves the built admin at /admin and every client route, config injected, strict CSP", async () => {
    const { router } = await boot({ withUi: true });
    for (const path of ["/admin", "/admin/anything"]) {
      const response = await router.request(path);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(JSON.stringify({ origins: DASHBOARD_ORIGINS, devPreview: false }));
      expect(body).not.toContain("__QUEEK_ADMIN_CONFIG__");
      const csp = response.headers.get("Content-Security-Policy") ?? "";
      expect(csp).toContain("script-src 'self';");
      expect(csp).toContain(`frame-ancestors ${DASHBOARD_ORIGINS.join(" ")}`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    const asset = await router.request("/admin/assets/index-abc.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("javascript");
    expect(asset.headers.get("Cache-Control")).toContain("immutable");
    expect((await router.request("/admin/assets/..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await router.request("/admin/app/nope")).status).toBe(401);
  });

  it("answers 404 with a build hint when the admin UI was never built", async () => {
    const { router } = await boot({ withUi: false });
    const response = await router.request("/admin");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe("admin_not_built");
  });

  it("refuses the session exchange without a verifiable dashboard token", async () => {
    const { router } = await boot({ withUi: false });
    expect((await router.request("/admin/session", { method: "POST" })).status).toBe(401);
    expect(
      (
        await router.request("/admin/session", {
          method: "POST",
          headers: { Authorization: "Bearer not-a-token" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await router.request("/admin/session", {
          method: "POST",
          headers: { Authorization: `Bearer ${dashboardToken("wrong-secret")}` },
        })
      ).status,
    ).toBe(401);
  });

  it("refuses the JSON API without a session, and an expired session", async () => {
    const { router, store } = await boot({ withUi: false });
    expect((await router.request("/admin/app/api/settings")).status).toBe(401);
    const installation = await store.getInstallation(INSTALLATION_ID);
    expect(installation).not.toBeNull();
    const expired = issueAdminSession(installation ?? ({} as never), "user-1", 1);
    expect(expired).not.toBeNull();
    expect(
      (
        await router.request("/admin/app/api/settings", {
          headers: { Authorization: `Bearer ${expired?.token}` },
        })
      ).status,
    ).toBe(401);
  });
});

describe("admin settings API", () => {
  it("reads an empty greeting, saves a valid one, rejects bad input", async () => {
    const { call, store } = await boot({ withUi: false });
    expect(((await (await call("GET", "/settings")).json()) as { greeting: unknown }).greeting).toBeNull();
    const saved = await call("PUT", "/settings", { greeting: "Hello, Suya Spots" });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { greeting: unknown }).greeting).toBe("Hello, Suya Spots");
    expect((await store.getInstallation(INSTALLATION_ID))?.settings).toMatchObject({
      greeting: "Hello, Suya Spots",
    });
    expect((await call("PUT", "/settings", { greeting: 42 })).status).toBe(422);
    expect((await call("PUT", "/settings", { greeting: "x".repeat(281) })).status).toBe(422);
  });
});

describe("admin store API", () => {
  it("returns the Merchant API profile through the installation client", async () => {
    const { call } = await boot({ withUi: false });
    const response = await call("GET", "/store");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ store: FAKE_PROFILE });
  });

  it("answers 502 when Queek does not answer, without leaking", async () => {
    const { call } = await boot({ withUi: false, storeFails: true });
    const response = await call("GET", "/store");
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.error).toBe("merchant_unreachable");
    expect(JSON.stringify(body)).not.toContain("Queek is down");
  });
});

describe("admin dev preview", () => {
  it("signs in as the local install on loopback, refuses a public host", async () => {
    const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    await store.saveInstallation(buildInstallationRecord(installData()));
    const router = createAdminRouter({
      installations: store,
      clientFor: () => ({ getStore: async () => FAKE_PROFILE as never }),
      log: quietLog(),
      dashboardOrigins: DASHBOARD_ORIGINS,
      devPreview: true,
      adminUiDir: null,
    });
    const local = await router.request("http://localhost/admin/dev-session", { method: "POST" });
    expect(local.status).toBe(200);
    expect(typeof ((await local.json()) as { token: string }).token).toBe("string");
    const publicHost = await router.request("http://my-app.apps.queek.com.ng/admin/dev-session", {
      method: "POST",
    });
    expect(publicHost.status).toBe(404);
  });

  it("answers 409 when no install exists yet, and is absent outside dev", async () => {
    const empty = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
    const dev = createAdminRouter({
      installations: empty,
      clientFor: () => ({ getStore: async () => FAKE_PROFILE as never }),
      log: quietLog(),
      dashboardOrigins: DASHBOARD_ORIGINS,
      devPreview: true,
      adminUiDir: null,
    });
    expect((await dev.request("http://localhost/admin/dev-session", { method: "POST" })).status).toBe(409);
    const prod = createAdminRouter({
      installations: empty,
      clientFor: () => ({ getStore: async () => FAKE_PROFILE as never }),
      log: quietLog(),
      dashboardOrigins: DASHBOARD_ORIGINS,
      adminUiDir: null,
    });
    expect((await prod.request("http://localhost/admin/dev-session", { method: "POST" })).status).toBe(404);
  });
});
