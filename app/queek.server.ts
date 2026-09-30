import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createAppTokenProvider,
  createInstallationClient,
  createInstallationStore,
  createLogger,
  handleInstallRequest,
  handleWebhookRequest,
  type InstallationRecord,
  type InstallationStore,
  type Logger,
  loadAppCredential,
  type QueekClient,
} from "@usequeek/app-sdk";
import { parse as parseToml } from "smol-toml";
import type { AdminSession } from "./admin-session.js";
import { bearerToken, establishAdminSession, verifyAdminSession } from "./admin-session.js";
import {
  APP_SLUG,
  type AppConfig,
  DEFAULT_DASHBOARD_ORIGIN,
  loadConfig,
  renderManifest,
  staticManifestFromToml,
} from "./config.js";
import { buildLifecycle } from "./lifecycle.js";
import type { AppLoadContext } from "./load-context.js";

/**
 * The Queek wiring (Shopify's `app/shopify.server.ts` equivalent): config,
 * installation store, token minting, lifecycle callbacks, and the shared
 * action/loader helpers every route calls. Lazy — importing this module
 * never touches env or disk; `getRuntime()` boots once, on first request.
 *
 * Only SDK 0.5.1 APIs are used here. Newer SDK work (bridge v1 in
 * app-sdk-wt-bridge) is named in TODOs where it will slot in:
 * - TODO(SDK bridge v1): replace the hand-rolled postMessage bridge in
 *   `app/bridge.client.ts` with `installAuthFetch()` + `./react`
 *   `useQueek()` (`toast`, `saveBar`, `pickResource`, `navigate`).
 * - TODO(SDK bridge v1): `sendToast`/`sendTitle`/`sendSaveBar` for the
 *   dashboard title bar + toasts instead of the v0 `ready`/`token`/`resize`
 *   messages below.
 * - TODO(SDK): `INSUFFICIENT_SCOPE_CODE`/`isInsufficientScope` — drop the
 *   cached installation token and re-mint once on a grant refresh instead
 *   of surfacing merchant_unreachable.
 */

export interface Runtime {
  config: AppConfig;
  store: InstallationStore;
  tokens: ReturnType<typeof createAppTokenProvider>;
  log: Logger;
  lifecycle: ReturnType<typeof buildLifecycle>;
  staticManifest: Record<string, unknown>;
  clientFor: (
    installation: Pick<InstallationRecord, "installationId" | "apiBase">,
  ) => Pick<QueekClient, "getStore">;
}

let cached: Runtime | null = null;

/** Test seam: override the Merchant-API fetch (production uses global fetch). */
export let queekFetchImpl: typeof fetch = fetch;
export function setQueekFetchImpl(impl: typeof fetch): void {
  queekFetchImpl = impl;
}

export function createRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const config = loadConfig(env);
  const log = createLogger({ service: `queek-app-${APP_SLUG}` });
  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  // DATABASE_URL set (production) → Postgres; otherwise SQLite (local dev).
  const store = createInstallationStore({
    storeKey: config.storeKey,
    databaseUrl: env.DATABASE_URL,
    sqlitePath: config.dbPath,
  });
  // The app credential mints short-lived installation tokens: no
  // store-callable key ever crosses the install handoff any more.
  const tokens = createAppTokenProvider({
    credential: loadAppCredential({
      appSlug: APP_SLUG,
      keyId: config.appKeyId,
      privateKeyPem: config.appPrivateKey,
    }),
    store,
  });
  const lifecycle = buildLifecycle({ store, tokens, log, queekFetchImpl });
  // The static manifest is the grouped `queek.app.toml` — the same file
  // `queek app deploy` ships — flattened onto the manifest shape and rendered
  // per-request with APP_BASE_URL (see renderManifest).
  const tomlPath = join(process.cwd(), "queek.app.toml");
  const staticManifest = staticManifestFromToml(
    parseToml(readFileSync(tomlPath, "utf8")) as Record<string, unknown>,
  );
  return {
    config,
    store,
    tokens,
    log,
    lifecycle,
    staticManifest,
    clientFor: (installation) =>
      createInstallationClient({
        installationId: installation.installationId,
        apiBase: installation.apiBase,
        tokens,
        fetchImpl: queekFetchImpl,
      }),
  };
}

export function getRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  if (!cached) cached = createRuntime(env);
  return cached;
}

/** Tests only: drop the cached runtime so each test boots its own. */
export function resetRuntime(): void {
  cached = null;
  queekFetchImpl = fetch;
}

/** The servable manifest: the toml rendered with this boot's APP_BASE_URL. */
export function servableManifest(runtime: Runtime): Record<string, unknown> {
  return renderManifest(runtime.staticManifest, runtime.config.appBaseUrl);
}

/**
 * Install/uninstall/settings handoff (one action serves all three paths —
 * the SDK routes on the trailing `install`/`uninstall`/`settings` segment).
 * The install callback answers 2xx first and verifies the Merchant API
 * after, in the background (see lifecycle.ts).
 */
export function installAction(request: Request, runtime: Runtime = getRuntime()): Promise<Response> {
  return handleInstallRequest(request, {
    appSecret: runtime.config.appSecret,
    store: runtime.store,
    onInstall: runtime.lifecycle.onInstall,
    onUninstall: runtime.lifecycle.onUninstall,
  });
}

/** Topic deliveries (`POST /webhooks`). Only POST is served; else 405. */
export function webhookAction(request: Request, runtime: Runtime = getRuntime()): Promise<Response> {
  return handleWebhookRequest(request, {
    store: runtime.store,
    handlers: {
      "orders/updated": async (envelope, context) => {
        const order = (envelope.data as Record<string, unknown>).order as Record<string, unknown> | undefined;
        runtime.log.info("order updated", {
          store: context.installation.storePid,
          order: String(order?.id ?? "unknown"),
        });
      },
    },
  });
}

/** Session-exchange throttle: attempts kept per client inside the window. */
const SESSION_WINDOW_MS = 60_000;
const SESSION_MAX_ATTEMPTS = 30;
const sessionAttempts = new Map<string, number[]>();

/** Tests only: clear the throttle buckets. */
export function resetSessionThrottle(): void {
  sessionAttempts.clear();
}

export function checkSessionThrottle(clientKey: string): { retryAfter: number } | null {
  const at = Date.now();
  const seen = (sessionAttempts.get(clientKey) ?? []).filter((mark) => mark > at - SESSION_WINDOW_MS);
  if (seen.length >= SESSION_MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil(((seen[0] as number) + SESSION_WINDOW_MS - at) / 1000));
    sessionAttempts.set(clientKey, seen);
    return { retryAfter };
  }
  sessionAttempts.set(clientKey, [...seen, at]);
  return null;
}

/**
 * Throttle peer: the direct socket first (unspoofable, via load context),
 * then the proxy headers, so headerless clients do not all share one
 * "unknown" bucket that a single abuser could exhaust.
 */
export function sessionClientKey(request: Request, context?: AppLoadContext | null): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    [context?.clientIp, forwarded, request.headers.get("x-real-ip")].find(
      (peer) => typeof peer === "string" && peer !== "",
    ) ?? "unknown"
  );
}

/** Verify an admin session bearer: the session IS the scope. */
export function getAdminSession(
  request: Request,
  runtime: Runtime = getRuntime(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AdminSession | null> {
  return verifyAdminSession(
    runtime.store,
    bearerToken(request.headers.get("Authorization") ?? undefined),
    nowSeconds,
  );
}

/**
 * Verify a dashboard session token ONCE and start an admin session.
 * Null for anything that does not verify (see admin-session.ts).
 */
export function exchangeDashboardToken(
  dashboardToken: string,
  runtime: Runtime = getRuntime(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresIn: number; installation: InstallationRecord } | null> {
  return establishAdminSession(runtime.store, dashboardToken, nowSeconds);
}

/** Dashboard origins for CSP frame-ancestors (safe default when unconfigured). */
export function dashboardOrigins(): string[] {
  try {
    return getRuntime().config.dashboardOrigins;
  } catch {
    return [DEFAULT_DASHBOARD_ORIGIN];
  }
}

/** Every admin response: framable by the dashboard only, never cached or indexed. */
export function adminHeaders(policy = ""): Headers {
  const headers = new Headers();
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", `${policy}frame-ancestors ${dashboardOrigins().join(" ")}`.trim());
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return headers;
}

export function adminJson(data: unknown, status = 200, policy = "default-src 'none'; "): Response {
  const headers = adminHeaders(policy);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(data), { status, headers });
}

/** The `greeting` setting (`[[settings]]` in queek.app.toml): one line, never a blob. */
export const GREETING_MAX_LENGTH = 280;

export function greetingOf(installation: InstallationRecord): string | null {
  const greeting = (installation.settings as Record<string, unknown> | undefined)?.greeting;
  return typeof greeting === "string" ? greeting : null;
}

/** Save the `greeting` setting onto the stored installation row. */
export async function saveGreeting(
  store: InstallationStore,
  installation: InstallationRecord,
  greeting: unknown,
): Promise<{ ok: true; greeting: string } | { ok: false; message: string }> {
  if (typeof greeting !== "string" || greeting.length > GREETING_MAX_LENGTH) {
    return { ok: false, message: `Greeting must be a string up to ${GREETING_MAX_LENGTH} chars.` };
  }
  await store.saveInstallation({
    ...installation,
    settings: { ...(installation.settings ?? {}), greeting },
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, greeting };
}

/**
 * The example Merchant API call: the store profile, through the
 * installation client (short-lived token, never the page's session).
 */
export async function storeProfileFor(
  installation: Pick<InstallationRecord, "installationId" | "apiBase">,
  runtime: Runtime = getRuntime(),
): Promise<{ ok: true; store: unknown } | { ok: false }> {
  try {
    const profile = await runtime.clientFor(installation).getStore();
    return { ok: true, store: profile };
  } catch {
    runtime.log.error("admin Merchant API check failed", {
      installation: (installation as InstallationRecord).installationPid ?? installation.installationId,
    });
    return { ok: false };
  }
}
