/**
 * Session + dashboard bridge for the React admin.
 *
 * Framed by the Queek dashboard: say `ready` to the parent (exact origins
 * only), take its short-lived session token, trade it ONCE at
 * `POST /admin/session` for the app's own session bearer. Opened directly
 * on this machine in development: `POST /admin/dev-session` instead.
 * The session bearer lives in memory only (cross-site iframe: no cookies).
 * Moves to @usequeek/app-sdk's installAuthFetch once it ships.
 */

interface AdminConfig {
  origins: string[];
  devPreview: boolean;
}

function readConfig(): AdminConfig {
  try {
    const raw = document.getElementById("queek-admin-config")?.textContent ?? "";
    const parsed = JSON.parse(raw) as Partial<AdminConfig>;
    return {
      origins: Array.isArray(parsed.origins) ? parsed.origins.filter((o) => typeof o === "string") : [],
      devPreview: parsed.devPreview === true,
    };
  } catch {
    return { origins: [], devPreview: false };
  }
}

const config = readConfig();
const framed = window.parent !== window;
let session: string | null = null;
let pending: Promise<string> | null = null;

function post(message: Record<string, unknown>): void {
  if (!framed) return;
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

async function establish(): Promise<string> {
  if (!framed && config.devPreview) {
    const response = await fetch("/admin/dev-session", {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Local preview needs `queek app dev` to have installed the app once.");
    return ((await response.json()) as { token: string }).token;
  }
  if (!framed) throw new Error("Open My App from your Queek dashboard.");
  const token = await dashboardToken();
  const response = await fetch("/admin/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Queek did not accept this session. Close the app and open it again.");
  return ((await response.json()) as { token: string }).token;
}

async function ensureSession(): Promise<string> {
  if (session) return session;
  pending ??= establish().finally(() => {
    pending = null;
  });
  session = await pending;
  return session;
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
    const response = await fetch(`/admin/app/api${path}`, {
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
      session = null;
      continue;
    }
    const data = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) throw new ApiError(data.message ?? "Something went wrong. Try again.", response.status);
    return data;
  }
  throw new ApiError("Your session ended. Close the app and open it again.", 401);
}

export function applyTheme(mode: "dark" | "light"): void {
  document.documentElement.classList.toggle("dark", mode === "dark");
  try {
    sessionStorage.setItem("queek-theme", mode);
  } catch {
    // Storage blocked: this page view only.
  }
}

/** Keep the dashboard frame as tall as the page. */
export function startAutoHeight(): void {
  if (!framed || !("ResizeObserver" in window)) return;
  const report = () => post({ type: "resize", height: Math.ceil(document.documentElement.scrollHeight) });
  new ResizeObserver(report).observe(document.body);
  report();
}

export const isLocalPreview = !framed && config.devPreview;
/** Inside the Queek dashboard: the dashboard's sidebar carries the app menu. */
export const isFramed = framed;

/** Tell the dashboard which app page is showing, so its address and sidebar follow. */
export function reportNavigated(path: string): void {
  post({ type: "navigated", path });
}

/** The dashboard asks the app to move (sidebar menu, back/forward): exact origin + parent only. */
export function onDashboardNavigate(handler: (path: string) => void): () => void {
  if (!framed) return () => undefined;
  const listener = (event: MessageEvent) => {
    if (event.source !== window.parent || !config.origins.includes(event.origin)) return;
    const data = event.data as { source?: string; type?: string; path?: string };
    if (data?.source !== "queek-merchant" || data.type !== "navigate" || typeof data.path !== "string")
      return;
    if (!data.path.startsWith("/") || data.path.startsWith("//")) return;
    handler(data.path);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
