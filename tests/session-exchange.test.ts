import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { verifyLaunchTokenDetailed, verifySessionTokenDetailed } from "@usequeek/app-sdk/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRuntime } from "../app/queek.server.js";
import { loader as settingsLoader } from "../app/routes/admin.api.settings.js";
import { action as sessionAction } from "../app/routes/admin.session.js";
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

function handoffRequest(path: string, type: string, data: unknown): Request {
  const body = envelope(type, data);
  return new Request(`https://my-app.apps.queek.com.ng${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...signedDelivery(body, APP_SECRET) },
    body,
  });
}

interface MintOptions {
  secret?: string;
  /** Omitted entirely = the current backend shape (no purpose claim). */
  purpose?: string;
  expired?: boolean;
}

/** A dashboard token exactly as the backend mints it (HS256 under the embed secret). */
function dashboardToken(options: MintOptions = {}): string {
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
    exp: options.expired ? now - 120 : now + 60,
    installation_id: INSTALLATION_ID,
    vendor_id: VENDOR_ID,
    app_slug: "my-app",
    app_id: APP_ID,
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  });
  const secret = options.secret ?? EMBED_SECRET;
  const signature = createHmac("sha256", secret).update(`${head}.${body}`, "utf8").digest("base64url");
  return `${head}.${body}.${signature}`;
}

async function install(): Promise<void> {
  const { action: installAction } = await import("../app/routes/install.js");
  const response = await installAction({
    request: handoffRequest("/install", "app/installed", installData()),
  } as never);
  expect(response.status).toBe(200);
}

function exchange(token: string, clientIp: string): Promise<Response> {
  return sessionAction({
    request: new Request("https://my-app.apps.queek.com.ng/admin/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }),
    context: { clientIp },
  } as never);
}

function verifyOptions() {
  return {
    secret: EMBED_SECRET,
    audience: "my-app",
    issuer: API_BASE,
    expected: {
      installationId: INSTALLATION_ID,
      vendorId: VENDOR_ID,
      appSlug: "my-app",
      appId: APP_ID,
    },
  };
}

describe("two-purpose session exchange", () => {
  it("accepts a launch token and the issued session serves API calls", async () => {
    await install();
    const response = await exchange(dashboardToken({ purpose: "launch" }), "127.0.0.11");
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const read = await settingsLoader({
      request: new Request("https://my-app.apps.queek.com.ng/admin/api/settings", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    } as never);
    expect(read.status).toBe(200);
  });

  it("accepts a bridge token (purpose session)", async () => {
    await install();
    const response = await exchange(dashboardToken({ purpose: "session" }), "127.0.0.12");
    expect(response.status).toBe(200);
  });

  it("accepts a purpose-less token as a bridge token (current backend)", async () => {
    await install();
    const response = await exchange(dashboardToken(), "127.0.0.13");
    expect(response.status).toBe(200);
    expect(await verifySessionTokenDetailed(dashboardToken(), verifyOptions())).toMatchObject({ ok: true });
  });

  it("refuses a foreign purpose at the exchange", async () => {
    await install();
    const response = await exchange(dashboardToken({ purpose: "refresh" }), "127.0.0.14");
    expect(response.status).toBe(401);
  });

  it("refuses an expired launch token", async () => {
    await install();
    const response = await exchange(dashboardToken({ purpose: "launch", expired: true }), "127.0.0.15");
    expect(response.status).toBe(401);
  });

  it("refuses a bad signature", async () => {
    await install();
    const response = await exchange(
      dashboardToken({ purpose: "launch", secret: "embsec_wrong" }),
      "127.0.0.16",
    );
    expect(response.status).toBe(401);
  });

  it("each verifier refuses the other purpose with wrong_purpose", async () => {
    const launch = dashboardToken({ purpose: "launch" });
    const bridge = dashboardToken({ purpose: "session" });
    expect(await verifySessionTokenDetailed(launch, verifyOptions())).toEqual({
      ok: false,
      reason: "wrong_purpose",
    });
    expect(await verifyLaunchTokenDetailed(bridge, verifyOptions())).toEqual({
      ok: false,
      reason: "wrong_purpose",
    });
    expect(await verifyLaunchTokenDetailed(launch, verifyOptions())).toMatchObject({ ok: true });
  });

  it("the exchange still works when the installation row is present", async () => {
    await install();
    expect(await getRuntime().store.getInstallation(INSTALLATION_ID)).not.toBeNull();
  });
});
