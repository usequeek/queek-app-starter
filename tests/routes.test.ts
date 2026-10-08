import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { signQueekPayload } from "@usequeek/app-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSafeBridgePath } from "../app/bridge.client.js";
import { isLoopbackRequest } from "../app/load-context.js";
import {
  checkSessionThrottle,
  getAdminSession,
  getRuntime,
  webhookAction as serverWebhookAction,
  sessionThrottleSize,
} from "../app/queek.server.js";
import { action as settingsAction, loader as settingsLoader } from "../app/routes/admin.api.settings.js";
import { loader as storeLoader } from "../app/routes/admin.api.store.js";
import { action as devSessionAction } from "../app/routes/admin.dev-session.js";
import { action as sessionAction } from "../app/routes/admin.session.js";
import { loader as healthLoader } from "../app/routes/health.js";
import { action as installAction } from "../app/routes/install.js";
import { loader as manifestLoader } from "../app/routes/manifest[.]json.js";
import { action as uninstallAction } from "../app/routes/uninstall.js";
import { action as webhookAction } from "../app/routes/webhooks.js";
import { signedDelivery, useRuntime } from "./helpers.js";

const INSTALLATION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VENDOR_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const API_BASE = "https://api.usequeek.com/api/v1/merchant";
const APP_SECRET = "whsec_dGVzdGFwcHNlY3JldHRlc3RhcHBzZWNyZXQ=";
const WEBHOOK_SECRET = "test-webhook-secret";
const EMBED_SECRET = `embsec_${randomBytes(32).toString("base64")}`;
const APP_ID = "0199f0c2-app-starter";

let restore: () => void;
beforeEach(() => {
  restore = useRuntime();
});
afterEach(() => restore());

function installData() {
  return {
    installation: { id: INSTALLATION_ID, p_id: "inst_starter" },
    app_id: APP_ID,
    store: { id: VENDOR_ID, p_id: "store_xyz", name: "Suya Spots", is_test: true },
    api_base: API_BASE,
    scopes: ["merchant-business_profile-read"],
    settings: {},
    webhook_secret: WEBHOOK_SECRET,
    proxy_secret: null,
    embed_secret: EMBED_SECRET,
    webhook_url: "https://my-app.apps.queek.com.ng/webhooks",
    webhook_topics: ["orders/updated"],
  };
}

function envelope(type: string, data: unknown) {
  return JSON.stringify({
    id: `evt-${randomUUID()}`,
    type,
    api_version: "v1",
    created_at: new Date().toISOString(),
    data,
  });
}

function handoffRequest(path: string, type: string, data: unknown, secret = APP_SECRET): Request {
  const body = envelope(type, data);
  return new Request(`https://my-app.apps.queek.com.ng${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedDelivery(body, secret) },
    body,
  });
}

async function install(): Promise<void> {
  const response = await installAction({
    request: handoffRequest("/install", "app/installed", installData()),
  } as never);
  expect(response.status).toBe(200);
}

/** A dashboard session token as Queek mints it (HS256 under the embed secret). */
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
    app_id: APP_ID,
  });
  const signature = createHmac("sha256", secret).update(`${head}.${body}`, "utf8").digest("base64url");
  return `${head}.${body}.${signature}`;
}

async function adminBearer(): Promise<string> {
  const response = await sessionAction({
    request: new Request("https://my-app.apps.queek.com.ng/admin/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${dashboardToken()}` },
    }),
    context: { clientIp: "127.0.0.1" },
  } as never);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function authed(path: string, sessionBearer: string, method = "GET", body?: unknown): Request {
  return new Request(`https://my-app.apps.queek.com.ng${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${sessionBearer}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("machine routes", () => {
  it("GET /health is unauthenticated", async () => {
    const response = await healthLoader();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, app: "my-app" });
  });

  it("GET /manifest.json renders the toml with APP_BASE_URL", async () => {
    const response = await manifestLoader();
    expect(response.status).toBe(200);
    const manifest = (await response.json()) as Record<string, unknown>;
    expect(manifest.install_url).toBe("https://my-app.apps.queek.com.ng/install");
    expect(manifest.extensions).toMatchObject({
      merchant_page_url: "https://my-app.apps.queek.com.ng/admin",
    });
  });

  it("install answers 2xx and stores; uninstall purges", async () => {
    await install();
    const runtime = getRuntime();
    expect(await runtime.store.getInstallation(INSTALLATION_ID)).not.toBeNull();

    const uninstall = await uninstallAction({
      request: handoffRequest("/uninstall", "app/uninstalled", {
        installation: { id: INSTALLATION_ID, p_id: "inst_starter" },
        store: { id: VENDOR_ID, p_id: "store_xyz", name: "Suya Spots", is_test: true },
      }),
    } as never);
    expect(uninstall.status).toBe(200);
    expect(await runtime.store.getInstallation(INSTALLATION_ID)).toBeNull();
  });

  it("rejects a forged handoff signature", async () => {
    const response = await installAction({
      request: handoffRequest("/install", "app/installed", installData(), "whsec_wrong"),
    } as never);
    expect(response.status).toBe(401);
  });

  it("webhooks: orders/updated answers 2xx and logs the order", async () => {
    await install();
    const logs: string[] = [];
    const runtime = getRuntime();
    const origInfo = runtime.log.info.bind(runtime.log);
    runtime.log.info = ((message: string, fields?: Record<string, unknown>) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
      return origInfo(message, fields);
    }) as typeof runtime.log.info;

    const body = JSON.stringify({
      id: `evt-${randomUUID()}`,
      topic: "orders/updated",
      api_version: "v1",
      created_at: new Date().toISOString(),
      data: { id: "order-1", order_number: "ON-1", status: "placed" },
    });
    const response = await webhookAction({
      request: new Request("https://my-app.apps.queek.com.ng/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Queek-Topic": "orders/updated",
          ...signedDelivery(body, WEBHOOK_SECRET),
        },
        body,
      }),
    } as never);
    expect(response.status).toBe(200);
    expect(logs.some((line) => line.includes("order updated") && line.includes("order-1"))).toBe(true);
  });

  it("webhooks: a forged signature answers 401", async () => {
    await install();
    const body = JSON.stringify({
      id: `evt-${randomUUID()}`,
      topic: "orders/updated",
      api_version: "v1",
      created_at: new Date().toISOString(),
      data: { id: "order-forged", order_number: "ON-2", status: "placed" },
    });
    const response = await webhookAction({
      request: new Request("https://my-app.apps.queek.com.ng/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Queek-Topic": "orders/updated",
          ...signedDelivery(body, "wrong-secret"),
        },
        body,
      }),
    } as never);
    expect(response.status).toBe(401);
  });

  it("webhooks: with two installs, B's secret authenticates against B; an unknown secret 401s", async () => {
    const secondId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    const secretA = "whsec_install_a_secret_aaaaaaaaaaaaaaaa";
    const secretB = "whsec_install_b_secret_bbbbbbbbbbbbbbbb";
    const installAs = (installationId: string, pid: string, storePid: string, webhookSecret: string) => ({
      ...installData(),
      installation: { id: installationId, p_id: pid },
      store: {
        id: installationId === INSTALLATION_ID ? VENDOR_ID : "dddddddd-dddd-dddd-dddd-dddddddddddd",
        p_id: storePid,
        name: "Shop",
        is_test: true,
      },
      webhook_secret: webhookSecret,
      embed_secret: `embsec_${randomBytes(32).toString("base64")}`,
    });
    for (const payload of [
      installAs(INSTALLATION_ID, "inst_a", "store_aaa", secretA),
      installAs(secondId, "inst_b", "store_bbb", secretB),
    ]) {
      const installed = await installAction({
        request: handoffRequest("/install", "app/installed", payload),
      } as never);
      expect(installed.status).toBe(200);
    }
    const runtime = getRuntime();
    expect(await runtime.store.getInstallation(INSTALLATION_ID)).not.toBeNull();
    expect(await runtime.store.getInstallation(secondId)).not.toBeNull();

    const logs: string[] = [];
    const origInfo = runtime.log.info.bind(runtime.log);
    runtime.log.info = ((message: string, fields?: Record<string, unknown>) => {
      logs.push(`${message} ${JSON.stringify(fields)}`);
      return origInfo(message, fields);
    }) as typeof runtime.log.info;

    const delivery = (secret: string) => {
      const body = JSON.stringify({
        id: `evt-${randomUUID()}`,
        topic: "orders/updated",
        api_version: "v1",
        created_at: new Date().toISOString(),
        data: { id: "order-b-1", order_number: "ON-B-1", status: "placed" },
      });
      return new Request("https://my-app.apps.queek.com.ng/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Queek-Topic": "orders/updated",
          ...signedDelivery(body, secret),
        },
        body,
      });
    };

    // Signed with install B's secret: the try-each-secret lookup must resolve B.
    const ok = await serverWebhookAction(delivery(secretB));
    expect(ok.status).toBe(200);
    expect(logs.some((line) => line.includes("order updated") && line.includes("store_bbb"))).toBe(true);

    // Signed with a secret no install holds: rejected.
    const forged = await serverWebhookAction(delivery("whsec_unknown_third_secret"));
    expect(forged.status).toBe(401);
  });

  it("webhooks: a stale timestamp answers 401 even with a valid signature", async () => {
    await install();
    const id = `evt-${randomUUID()}`;
    const timestamp = (Math.floor(Date.now() / 1000) - 3600).toString();
    const body = JSON.stringify({
      id,
      topic: "orders/updated",
      api_version: "v1",
      created_at: new Date().toISOString(),
      data: { id: "order-stale", order_number: "ON-3", status: "placed" },
    });
    const response = await webhookAction({
      request: new Request("https://my-app.apps.queek.com.ng/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Queek-Topic": "orders/updated",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": signQueekPayload(id, timestamp, body, WEBHOOK_SECRET),
        },
        body,
      }),
    } as never);
    expect(response.status).toBe(401);
  });

  it("webhooks: GET answers 405", async () => {
    const response = await webhookAction({
      request: new Request("https://my-app.apps.queek.com.ng/webhooks", { method: "GET" }),
    } as never);
    expect(response.status).toBe(405);
  });
});

describe("admin session", () => {
  it("exchanges a dashboard token once; a bad token answers 401", async () => {
    await install();
    const bad = await sessionAction({
      request: new Request("https://my-app.apps.queek.com.ng/admin/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${dashboardToken("embsec_wrong")}` },
      }),
      context: { clientIp: "127.0.0.1" },
    } as never);
    expect(bad.status).toBe(401);

    const bearer = await adminBearer();
    expect(typeof bearer).toBe("string");
  });

  it("throttles the exchange per client with Retry-After", async () => {
    await install();
    const call = () =>
      sessionAction({
        request: new Request("https://my-app.apps.queek.com.ng/admin/session", {
          method: "POST",
          headers: { Authorization: "Bearer invalid" },
        }),
        context: { clientIp: "10.9.9.9" },
      } as never);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect((await call()).status).toBe(401);
    }
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(((await limited.json()) as { error: string }).error).toBe("too_many_requests");
  });

  it("evicts stale throttle buckets once past the client cap", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 1005; i += 1) checkSessionThrottle(`evict-client-${i}`);
      expect(sessionThrottleSize()).toBeGreaterThan(1000);
      vi.setSystemTime(Date.now() + 61_000);
      expect(checkSessionThrottle("evict-client-fresh")).toBeNull();
      expect(sessionThrottleSize()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dev-session: 404 outside development, loopback-only inside it", async () => {
    await install();
    const direct = (host: string, headers: Record<string, string> = {}, clientIp?: string) =>
      devSessionAction({
        request: new Request(`http://${host}/admin/dev-session`, { method: "POST", headers }),
        context: { clientIp },
      } as never);

    // NODE_ENV=test here: refused outright.
    expect((await direct("127.0.0.1", {}, "127.0.0.1")).status).toBe(404);
    expect(
      isLoopbackRequest(new Request("http://127.0.0.1:3000/admin/dev-session", { method: "POST" }), {
        clientIp: "127.0.0.1",
      }),
    ).toBe(true);
    expect(
      isLoopbackRequest(
        new Request("http://127.0.0.1:3000/admin/dev-session", {
          method: "POST",
          headers: { "x-forwarded-for": "10.0.0.1" },
        }),
        { clientIp: "127.0.0.1" },
      ),
    ).toBe(false);
    expect(
      isLoopbackRequest(new Request("http://tunnel.example.test/admin/dev-session", { method: "POST" }), {
        clientIp: "127.0.0.1",
      }),
    ).toBe(false);
    expect(
      isLoopbackRequest(new Request("http://127.0.0.1:3000/admin/dev-session", { method: "POST" }), {
        clientIp: "203.0.113.7",
      }),
    ).toBe(false);
  });

  it("dev-session: with several installs, previews the most recently updated one", async () => {
    const secondId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await installAction({
      request: handoffRequest("/install", "app/installed", installData()),
    } as never);
    await installAction({
      request: handoffRequest("/install", "app/installed", {
        ...installData(),
        installation: { id: secondId, p_id: "inst_two" },
        embed_secret: `embsec_${randomBytes(32).toString("base64")}`,
      }),
    } as never);
    // Touch the second row last: the store stamps updated_at on every save,
    // so this makes "most recent" unambiguous (a first-match lookup would
    // still return the first install here).
    const runtime = getRuntime();
    const second = await runtime.store.getInstallation(secondId);
    if (!second) throw new Error("second install did not store a row");
    // updated_at has millisecond resolution: leave a gap so the touch can
    // never land in the same millisecond as the second install's own save.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.store.saveInstallation({ ...second });

    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const response = await devSessionAction({
        request: new Request("http://127.0.0.1:3000/admin/dev-session", { method: "POST" }),
        context: { clientIp: "127.0.0.1" },
      } as never);
      expect(response.status).toBe(200);
      const { token } = (await response.json()) as { token: string };
      const session = await getAdminSession(
        new Request("https://my-app.apps.queek.com.ng/admin/api/store", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      expect(session?.installation.installationId).toBe(secondId);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });
});

describe("admin JSON", () => {
  it("answers 401 without a session bearer", async () => {
    await install();
    const plain = new Request("https://my-app.apps.queek.com.ng/admin/api/store");
    expect((await storeLoader({ request: plain } as never)).status).toBe(401);
    expect((await settingsLoader({ request: plain } as never)).status).toBe(401);
  });

  it("reads and saves the greeting on the installation row", async () => {
    await install();
    const bearer = await adminBearer();
    const read = await settingsLoader({ request: authed("/admin/api/settings", bearer) } as never);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ greeting: null });

    const write = await settingsAction({
      request: authed("/admin/api/settings", bearer, "PUT", { greeting: "Hello" }),
    } as never);
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ greeting: "Hello" });
    expect((await getRuntime().store.getInstallation(INSTALLATION_ID))?.settings).toMatchObject({
      greeting: "Hello",
    });

    const bad = await settingsAction({
      request: authed("/admin/api/settings", bearer, "PUT", { greeting: "x".repeat(281) }),
    } as never);
    expect(bad.status).toBe(422);
  });

  it("store: 502 when Queek is unreachable, never a throw", async () => {
    const { setQueekFetchImpl } = await import("../app/queek.server.js");
    setQueekFetchImpl(
      vi.fn(async () => {
        throw new Error("Queek is down");
      }) as unknown as typeof fetch,
    );
    await install();
    const bearer = await adminBearer();
    const response = await storeLoader({ request: authed("/admin/api/store", bearer) } as never);
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toBe("merchant_unreachable");
  });

  it("store: returns the profile when Queek answers", async () => {
    const { setQueekFetchImpl } = await import("../app/queek.server.js");
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ data: { p_id: "store_xyz", name: "Suya Spots" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    setQueekFetchImpl(fetchImpl);
    await install();
    // The installation client mints via the app key first: stub the mint so
    // this test exercises the loader end to end without network.
    getRuntime().tokens.acquireToken = async () => "sk_test_key";
    const bearer = await adminBearer();
    const response = await storeLoader({ request: authed("/admin/api/store", bearer) } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ store: { data: { p_id: "store_xyz" } } });
    expect(fetchImpl).toHaveBeenCalled();
  });
});

describe("bridge path validation", () => {
  it.each(["/admin", "/admin/settings", "/admin/a-b_c"])("accepts %s", (path) => {
    expect(isSafeBridgePath(path)).toBe(true);
  });

  it.each([
    "/admin/../x",
    "/admin/%2e%2e/x",
    "/admin/%252e%252e/x",
    "//evil.test/admin",
    "https://evil.test/admin",
    "javascript:alert(1)",
    "/admin\\x",
    "/admin/x\\",
    "admin/settings",
    "/admin/\u0001",
    "/admin/%",
  ])("refuses %s", (path) => {
    expect(isSafeBridgePath(path)).toBe(false);
  });
});
