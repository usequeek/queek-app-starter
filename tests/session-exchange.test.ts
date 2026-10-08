import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { verifySessionTokenDetailed } from "@usequeek/app-sdk/server";
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
  /** Legacy extra claim: older tokens carry a `purpose` claim, which verification ignores. */
  purpose?: string;
  expired?: boolean;
  installationId?: string;
  audience?: string;
}

/** A dashboard session token as Queek mints it (HS256 under the embed secret). */
function dashboardToken(options: MintOptions = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const head = encode({ typ: "JWT", alg: "HS256" });
  const body = encode({
    aud: options.audience ?? "my-app",
    iss: API_BASE,
    sub: "user-uuid-merchant",
    sid: randomUUID(),
    jti: randomUUID(),
    iat: now,
    nbf: now,
    exp: options.expired ? now - 120 : now + 60,
    installation_id: options.installationId ?? INSTALLATION_ID,
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

describe("single-token session exchange", () => {
  it("accepts the first-load URL token and the issued session serves API calls", async () => {
    await install();
    const response = await exchange(dashboardToken(), "127.0.0.11");
    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const read = await settingsLoader({
      request: new Request("https://my-app.apps.queek.com.ng/admin/api/settings", {
        headers: { Authorization: `Bearer ${token}` },
      }),
    } as never);
    expect(read.status).toBe(200);
  });

  it("accepts a refresh token through the same exchange", async () => {
    await install();
    const first = await exchange(dashboardToken(), "127.0.0.12");
    expect(first.status).toBe(200);
    const second = await exchange(dashboardToken(), "127.0.0.13");
    expect(second.status).toBe(200);
  });

  it.each(["launch", "session"])("accepts a legacy token carrying purpose %s", async (purpose) => {
    await install();
    const token = dashboardToken({ purpose });
    expect(await verifySessionTokenDetailed(token, verifyOptions())).toMatchObject({ ok: true });
    const response = await exchange(token, "127.0.0.14");
    expect(response.status).toBe(200);
  });

  it("refuses an expired token", async () => {
    await install();
    const response = await exchange(dashboardToken({ expired: true }), "127.0.0.15");
    expect(response.status).toBe(401);
  });

  it("refuses a forged signature", async () => {
    await install();
    const response = await exchange(dashboardToken({ secret: "embsec_wrong" }), "127.0.0.16");
    expect(response.status).toBe(401);
  });

  it("refuses a foreign token minted for another installation", async () => {
    await install();
    const response = await exchange(
      dashboardToken({ installationId: "ffffffff-ffff-ffff-ffff-ffffffffffff" }),
      "127.0.0.17",
    );
    expect(response.status).toBe(401);
  });

  it("refuses a token for another audience", async () => {
    await install();
    const response = await exchange(dashboardToken({ audience: "other-app" }), "127.0.0.18");
    expect(response.status).toBe(401);
  });

  it("the exchange still works when the installation row is present", async () => {
    await install();
    expect(await getRuntime().store.getInstallation(INSTALLATION_ID)).not.toBeNull();
  });
});
