import {
  applyTheme as applySdkTheme,
  type InstalledAuth,
  installAuthFetch,
  installThemeListener,
  listenToDashboard,
  sendNavigated,
} from "@usequeek/app-sdk/browser";

/**
 * Session + dashboard bridge for the embedded admin (client-only), on SDK
 * 0.6.1 browser primitives (`@usequeek/app-sdk/browser` — the main entry
 * barrel cannot load in browser bundles, so browser code imports from
 * there; no alias, no deep `dist/` imports).
 *
 * Framed by the Queek dashboard: `installAuthFetch()` reads the session
 * token off the signed first load (`?queek_token=…`, stripped from the URL
 * at once — the SAME token type the bridge answers with on refresh),
 * exchanges it ONCE at `POST /admin/session` for the app's own session
 * bearer, and attaches it to every same-origin fetch (cookies stay out —
 * cross-site iframe, no cookies). A 401 re-establishes via the bridge
 * `ready→token` flow and retries once. Opened directly on this machine in
 * development: `POST /admin/dev-session` instead. The session Bearer [REDACTED] in
 * memory only.
 *
 * Theme rides the SDK too: `?theme=` is a plain unsigned URL param for
 * first paint (see root.tsx), and the live bridge `theme` message
 * overrides it via `installThemeListener`. No React provider here — the
 * admin pages only need session carriage, nav, theme and resize, so
 * `./react` (`useQueek`, toasts, save bar, pickers) stays out until a page
 * uses it.
 */

export interface BridgeConfig {
  origins: string[];
  devPreview: boolean;
}

let config: BridgeConfig = { origins: [], devPreview: false };

/** One installed auth per wiring: recreated lazily after `dropSession`. */
let auth: InstalledAuth | null = null;
/** The live theme subscriptions, replaced on every reconfigure. */
let stopTheme: (() => void) | null = null;
/** Local-preview session (development, unframed): never the framed path. */
let devSession: string | null = null;
let devPending: Promise<string> | null = null;

export function configureBridge(next: BridgeConfig): void {
  config = next;
  stopTheme?.();
  stopTheme = null;
  if (!isBrowser() || !isFramed() || config.origins.length === 0) return;
  // Live dashboard theme from every configured origin (normally one): the
  // SDK applies the mode, remembers it for the bootstrap fallback, rewrites
  // the `theme` URL param and announces `ready`, so reloads never flash.
  const stops = config.origins.map((dashboardOrigin) => installThemeListener({ dashboardOrigin }));
  stopTheme = () => {
    for (const stop of stops) stop();
  };
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

/** Trade one dashboard token (first load or refresh — one token type) for the app session. */
async function exchangeDashboardToken(token: string): Promise<string> {
  const response = await fetch("/admin/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Queek did not accept this session. Close the app and open it again.");
  return ((await response.json()) as { token: string }).token;
}

function ensureAuth(): InstalledAuth {
  // The refresh `ready` goes to the primary origin; token replies are
  // accepted on every configured origin by the auth's own listener.
  auth ??= installAuthFetch({
    exchange: exchangeDashboardToken,
    dashboardOrigin: config.origins[0] ?? "",
  });
  return auth;
}

/** Forget the session (after a terminal 401 the next call re-establishes). */
export function dropSession(): void {
  auth?.dispose();
  auth = null;
  devSession = null;
  devPending = null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function devSessionToken(): Promise<string> {
  if (devSession) return devSession;
  devPending ??= fetch("/admin/dev-session", {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
  })
    .then(async (response) => {
      if (!response.ok)
        throw new Error("Local preview needs `queek app dev` to have installed the app once.");
      return ((await response.json()) as { token: string }).token;
    })
    .finally(() => {
      devPending = null;
    });
  devSession = await devPending;
  return devSession;
}

async function devApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sessionBearer = await devSessionToken();
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

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!isFramed()) {
    if (config.devPreview) return devApi<T>(method, path, body);
    throw new Error("Open My App from your Queek dashboard.");
  }
  // The auth fetch carries the session and already retried once on a 401
  // (bridge refresh); a 401 here means the dashboard token itself was
  // refused — drop the session and surface, never loop.
  const response = await ensureAuth().fetch(`/admin/api${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as T & { message?: string };
  if (!response.ok) {
    if (response.status === 401) {
      dropSession();
      throw new ApiError("Your session ended. Close the app and open it again.", 401);
    }
    throw new ApiError(data.message ?? "Something went wrong. Try again.", response.status);
  }
  return data;
}

/** Dashboard-following theme (U7): the SDK toggles shadcn's own `dark` class, live. */
export function applyTheme(mode: "dark" | "light"): void {
  applySdkTheme(mode);
}

/** Keep the dashboard frame as tall as the page (`resize` is v0 protocol — kept hand-rolled). */
export function startAutoHeight(): void {
  if (!isFramed() || !("ResizeObserver" in window)) return;
  const report = () => {
    for (const dashboardOrigin of config.origins) {
      try {
        window.parent.postMessage(
          {
            source: "queek-app",
            type: "resize",
            height: Math.ceil(document.documentElement.scrollHeight),
          },
          dashboardOrigin,
        );
      } catch {
        // A wrong origin throws; the right one delivers.
      }
    }
  };
  new ResizeObserver(report).observe(document.body);
  report();
}

/** Tell the dashboard which app page is showing, so its address and sidebar follow. */
export function reportNavigated(path: string): void {
  if (!isFramed()) return;
  for (const dashboardOrigin of config.origins) {
    sendNavigated(dashboardOrigin, window.parent, path);
  }
}

/**
 * A dashboard-sent app path is safe to route when it satisfies the manifest
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
  // One SDK subscription per configured origin (normally one): each checks
  // the exact origin plus the parent source, and unknown types are ignored.
  const stops = config.origins.map((dashboardOrigin) =>
    listenToDashboard({
      dashboardOrigin,
      onNavigate: (path) => {
        if (!isSafeBridgePath(path)) return;
        handler(path);
      },
    }),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
