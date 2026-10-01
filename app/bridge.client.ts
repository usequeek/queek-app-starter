/**
 * Session + dashboard bridge for the embedded admin (client-only).
 *
 * Framed by the Queek dashboard: on the signed first load the launch token
 * rides `?queek_token=` (read + stripped from the URL at once, exchanged
 * directly — no bridge round-trip for first paint); otherwise say `ready`
 * to the parent (exact origins only), take its short-lived bridge token
 * and trade it ONCE at `POST /admin/session` for the app's own session
 * bearer. Opened directly on this machine in development:
 * `POST /admin/dev-session` instead. The session Bearer [REDACTED] in memory only
 * (cross-site iframe: no cookies).
 *
 * Server side already runs SDK 0.6.0's two-purpose exchange (launch first,
 * bridge fallback — see admin-session.ts). Client side stays hand-rolled
 * postMessage for now: SDK 0.6.0's browser modules (`installAuthFetch`,
 * frame/theme) ship only behind the package's main entry, whose barrel
 * also re-exports node-only modules — ANY main-entry import breaks the
 * Vite browser build (verified with a bare `sendResize` probe and a 3-file
 * control barrel: Rollup binds the node-only modules' `node:crypto`
 * imports before tree-shaking can drop them; only `./react` bundles, and
 * it does not export these helpers). TODO(SDK browser subpaths): replace
 * `takeLaunchToken` + the ready/token/resize/navigated plumbing below with
 * `installAuthFetch()` + `listenToDashboard`/`sendResize`/`sendNavigated`/
 * `installThemeListener` once the SDK exports its browser-safe modules
 * (frame/auth-fetch/theme) under their own subpaths.
 */

export interface BridgeConfig {
  origins: string[];
  devPreview: boolean;
}

let config: BridgeConfig = { origins: [], devPreview: false };

export function configureBridge(next: BridgeConfig): void {
  config = next;
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isFramed(): boolean {
  return isBrowser() && window.parent !== window;
}

/** Inside the Queek dashboard: the dashboard's sidebar carries the app menu. */
export function getIsFramed(): boolean {
  return isFramed();
}

/** Direct local open of the dev server with preview enabled. */
export function getIsLocalPreview(): boolean {
  return isBrowser() && !isFramed() && config.devPreview;
}

let session: string | null = null;
let pending: Promise<string> | null = null;

/** Launch-token query param on the signed first load (mirrors the SDK's `LAUNCH_TOKEN_PARAM`). */
const LAUNCH_TOKEN_PARAM = "queek_token";

let launchConsumed = false;

/**
 * Take the launch token off the signed first load, stripping it from the
 * URL at once so it never lingers in history. Single-use per page load:
 * later calls (every 401 refresh) return null and use the bridge flow.
 */
function takeLaunchToken(): string | null {
  if (launchConsumed || !isBrowser()) return null;
  launchConsumed = true;
  try {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(LAUNCH_TOKEN_PARAM);
    if (token === null || token === "") return null;
    url.searchParams.delete(LAUNCH_TOKEN_PARAM);
    window.history.replaceState(null, "", url.toString());
    return token;
  } catch {
    return null;
  }
}

function post(message: Record<string, unknown>): void {
  if (!isFramed()) return;
  for (const origin of config.origins) {
    try {
      window.parent.postMessage({ source: "queek-app", ...message }, origin);
    } catch {
      // A wrong origin throws; the right one delivers.
    }
  }
}

function dashboardToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("The Queek dashboard did not answer."));
    }, 8000);
    function onMessage(event: MessageEvent) {
      if (event.source !== window.parent || !config.origins.includes(event.origin)) return;
      const data = event.data as { source?: string; type?: string; token?: string; mode?: string };
      if (data?.source !== "queek-merchant") return;
      if (data.type === "theme" && (data.mode === "dark" || data.mode === "light")) {
        applyTheme(data.mode);
        return;
      }
      if (data.type !== "token" || typeof data.token !== "string") return;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      post({ type: "ack" });
      resolve(data.token);
    }
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
  });
}

/** Trade one dashboard token (launch or bridge) for the app's own session bearer. */
async function exchangeToken(token: string): Promise<string> {
  const response = await fetch("/admin/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Queek did not accept this session. Close the app and open it again.");
  return ((await response.json()) as { token: string }).token;
}

async function establish(): Promise<string> {
  if (!isFramed() && config.devPreview) {
    const response = await fetch("/admin/dev-session", {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Local preview needs `queek app dev` to have installed the app once.");
    return ((await response.json()) as { token: string }).token;
  }
  if (!isFramed()) throw new Error("Open My App from your Queek dashboard.");
  // Signed first load first: the launch token needs no bridge round-trip.
  // Absent or refused, fall back to the bridge ready→token flow (which also
  // serves every later 401 refresh — same exchange endpoint, both purposes).
  const launch = takeLaunchToken();
  if (launch) {
    try {
      return await exchangeToken(launch);
    } catch {
      // A refused launch token falls back to the bridge token below.
    }
  }
  return exchangeToken(await dashboardToken());
}

async function ensureSession(): Promise<string> {
  if (session) return session;
  pending ??= establish().finally(() => {
    pending = null;
  });
  session = await pending;
  return session;
}

/** Forget the session (after a 401 the next call re-establishes). */
export function dropSession(): void {
  session = null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sessionBearer = await ensureSession();
    const response = await fetch(`/admin/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${sessionBearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
    });
    if (response.status === 401 && attempt === 0) {
      dropSession();
      continue;
    }
    const data = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) throw new ApiError(data.message ?? "Something went wrong. Try again.", response.status);
    return data;
  }
  throw new ApiError("Your session ended. Close the app and open it again.", 401);
}

/** Dashboard-following theme (U7): toggle shadcn's own `dark` class, live. */
export function applyTheme(mode: "dark" | "light"): void {
  if (!isBrowser()) return;
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.style.colorScheme = mode;
  try {
    sessionStorage.setItem("queek-theme", mode);
  } catch {
    // Storage blocked: this page view only.
  }
}

/** Keep the dashboard frame as tall as the page. */
export function startAutoHeight(): void {
  if (!isFramed() || !("ResizeObserver" in window)) return;
  const report = () => post({ type: "resize", height: Math.ceil(document.documentElement.scrollHeight) });
  new ResizeObserver(report).observe(document.body);
  report();
}

/** Tell the dashboard which app page is showing, so its address and sidebar follow. */
export function reportNavigated(path: string): void {
  post({ type: "navigated", path });
}

/**
 * A dashboard-sent app path is safe to route when it mirrors the backend's
 * nav rule: decode fully (repeatedly — the browser resolves %2e as `.`),
 * then no controls, no scheme, no backslashes, a single leading `/`, no
 * `..` segments. The granted-prefix half (`/admin` or under `/admin/`) is
 * enforced by the caller when it maps the path into the router.
 */
export function isSafeBridgePath(path: string): boolean {
  let decoded = path;
  for (let round = 0; round < 5; round += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return false;
    }
  }
  for (const char of decoded) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return false;
  if (decoded.includes("\\")) return false;
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return false;
  if (decoded.split("/").includes("..")) return false;
  return true;
}

/** The dashboard asks the app to move (sidebar menu, back/forward): exact origin + parent only. */
export function onDashboardNavigate(handler: (path: string) => void): () => void {
  if (!isFramed()) return () => undefined;
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent || !config.origins.includes(event.origin)) return;
    const data = event.data as { source?: string; type?: string; path?: string };
    if (data?.source !== "queek-merchant" || data.type !== "navigate" || typeof data.path !== "string")
      return;
    if (!isSafeBridgePath(data.path)) return;
    handler(data.path);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
