import { type AppTokens, createLogger, SqliteInstallationStore } from "@usequeek/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildLifecycle } from "../src/lifecycle.js";

const STORE_KEY = Buffer.alloc(32, 9).toString("base64");
const INSTALLATION_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/** Stub token minting: the merchant fake sees the same static key as before S1. */
const stubTokens: AppTokens = {
  acquireToken: async () => "sk_test_key",
  dropCachedToken: async () => undefined,
  revokeAppAccess: async () => undefined,
};

function makeLifecycle(queekFetchImpl?: typeof fetch) {
  const store = new SqliteInstallationStore({ path: ":memory:", storeKey: STORE_KEY });
  const logged: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
  const log = createLogger({
    service: "test",
    sink: (line) => {
      const parsed = JSON.parse(line) as { level: string; msg: string } & Record<string, unknown>;
      const { level, msg, ts, service, ...fields } = parsed;
      void ts;
      void service;
      logged.push({ level, message: msg, fields });
    },
  });
  const lifecycle = buildLifecycle({ store, tokens: stubTokens, log, queekFetchImpl });
  return { store, lifecycle, logged };
}

function installEnvelope() {
  return {
    id: "evt-install-1",
    type: "app/installed",
    api_version: "v1",
    created_at: "2026-09-24T00:00:00+00:00",
    data: {
      installation: { id: INSTALLATION_ID, p_id: "inst_starter" },
      store: {
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        p_id: "store_xyz",
        name: "Suya Spots",
        is_test: true,
      },
      api_base: "https://api.usequeek.com/api/v1/merchant",
      scopes: [],
      settings: {},
      webhook_secret: null,
      webhook_url: null,
      webhook_topics: [],
    },
  } as never;
}

function successFetch() {
  return vi.fn(async () => {
    return new Response(JSON.stringify({ data: { p_id: "store_xyz", name: "Suya Spots" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function waitFor(condition: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for background install work.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("install lifecycle", () => {
  it("answers the handoff before any Merchant API call; a failing post-handoff proof is logged, not thrown", async () => {
    const failingFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: { code: "app_installation_pending", message: "Installation pending." } }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const { store, lifecycle, logged } = makeLifecycle(failingFetch);
    // The handoff answers 2xx (onInstall resolves) before any Merchant API call.
    await lifecycle.onInstall(installEnvelope());
    expect(failingFetch).not.toHaveBeenCalled();
    expect(await store.getInstallation(INSTALLATION_ID)).not.toBeNull();
    // The proof runs after the handoff; its failure is logged, never thrown,
    // and the stored install is kept (no purge).
    await waitFor(() => (failingFetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0);
    await waitFor(() => logged.some((entry) => entry.message.includes("post-install")));
    expect(await store.getInstallation(INSTALLATION_ID)).not.toBeNull();
    const errors = logged.filter((entry) => entry.level === "error").map((entry) => entry.message);
    expect(errors.some((message) => message.includes("post-install Merchant API check failed"))).toBe(true);
  });

  it("stores the install then logs the Merchant API check in the background", async () => {
    const fetchImpl = successFetch();
    const { store, lifecycle, logged } = makeLifecycle(fetchImpl);
    await lifecycle.onInstall(installEnvelope());
    expect(await store.getInstallation(INSTALLATION_ID)).not.toBeNull();
    await waitFor(() => logged.some((entry) => entry.message === "installed"));
    const installed = logged.find((entry) => entry.message === "installed");
    expect(installed?.fields).toMatchObject({ store: "store_xyz" });
  });

  it("purges the installation on uninstall", async () => {
    const { store, lifecycle } = makeLifecycle(successFetch());
    await lifecycle.onInstall(installEnvelope());
    await lifecycle.onUninstall({ data: { installation: { id: INSTALLATION_ID, p_id: "inst_starter" } } });
    expect(await store.getInstallation(INSTALLATION_ID)).toBeNull();
  });
});
