import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InstallationRecord, InstallationStore, Logger, QueekClient } from "@usequeek/app-sdk";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import {
  bearerToken,
  establishAdminSession,
  issueAdminSession,
  verifyAdminSession,
} from "./admin-session.js";

/**
 * The merchant's embedded admin — one React page served at `/admin`
 * (the manifest's `extensions.merchant_page_url`), following the Booking
 * pattern (`queek-app-booking/src/admin.ts`, server shell only — the
 * booking views stay in that repo).
 *
 * The dashboard frames `GET /admin` and hands the page a session token by
 * postMessage from the exact dashboard origin; the page sends it to
 * `POST /admin/session` ONCE (SDK-verified, installation-bound — see
 * admin-session.ts) and then calls the JSON API under `/admin/app/api/*`
 * with its own short session bearer `Authorization`. No cookies, no
 * token in any URL, CSRF-proof (a cross-site form cannot set a header).
 * Every admin response carries `Content-Security-Policy: frame-ancestors
 * <dashboard origins from config>`, no-store and noindex. Every read and
 * write is scoped to the session's installation; foreign ids answer 404
 * (there are no id-addressed routes — the session IS the scope).
 */

/** The merchant page the manifest declares (`extensions.merchant_page_url`). */
export const ADMIN_PAGE_PATH = "/admin";
/** Every session-guarded admin view lives under here. */
export const ADMIN_APP_PATH = "/admin/app";
/** The JSON API the React page calls with its own session bearer. */
const ADMIN_API_PATH = "/admin/app/api";

export interface AdminDeps {
  installations: Pick<InstallationStore, "getInstallation" | "listInstallations" | "saveInstallation">;
  /** Merchant API client for the example call (`GET …/api/store`). */
  clientFor: (
    installation: Pick<InstallationRecord, "installationId" | "apiBase">,
  ) => Pick<QueekClient, "getStore">;
  log: Logger;
  /** Exact dashboard origins: frame-ancestors + the only postMessage peers. */
  dashboardOrigins: string[];
  /** Clock seam (unix seconds) for session expiry tests. */
  nowSeconds?: () => number;
  /**
   * Local dev preview: `/admin` opened directly on this machine (not framed
   * by Queek) signs in as the local dev install, so the page can be worked
   * on with live reload. Only ever true under NODE_ENV=development; the
   * route also refuses anything that did not arrive on loopback (the tunnel
   * adds forwarding headers), so a public tunnel URL never gets it.
   */
  devPreview?: boolean;
  /** The built React admin directory; null/absent = 404 with a build hint. */
  adminUiDir?: string | null;
}

/** Where `npm run build:admin` writes the React admin (next to dist/). */
export const DEFAULT_ADMIN_UI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist-admin");
const ADMIN_MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveAdminFile(dir: string | null, relative: string, cacheControl: string): Response {
  if (!dir) return new Response("Not found", { status: 404 });
  const file = resolve(dir, relative);
  if (!file.startsWith(`${dir}/`) || !existsSync(file)) return new Response("Not found", { status: 404 });
  const type = ADMIN_MIME[extname(file)] ?? "application/octet-stream";
  return new Response(readFileSync(file), {
    headers: { "Content-Type": type, "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff" },
  });
}

/** Session-exchange throttle: attempts kept per client inside the window. */
const SESSION_WINDOW_MS = 60_000;
const SESSION_MAX_ATTEMPTS = 30;

/** The `greeting` setting (`[[settings]]` in queek.app.toml): one line, never a blob. */
const GREETING_MAX_LENGTH = 280;

type AdminEnv = { Variables: { installation: InstallationRecord } };

/**
 * The admin router: `GET /admin` (the built React page), `POST
 * /admin/session`, and under `/admin/app/api`: `settings` (the starter's
 * one settings form) and `store` (the example Merchant API call).
 */
export function createAdminRouter(deps: AdminDeps): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();
  const { log } = deps;

  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const ancestors = deps.dashboardOrigins.join(" ");

  const sessionAttempts = new Map<string, number[]>();
  function sessionThrottled(clientKey: string): { throttled: true; retryAfter: number } | null {
    const at = Date.now();
    const windowStart = at - SESSION_WINDOW_MS;
    const seen = (sessionAttempts.get(clientKey) ?? []).filter((mark) => mark > windowStart);
    if (seen.length >= SESSION_MAX_ATTEMPTS) {
      const retryAfter = Math.max(1, Math.ceil(((seen[0] as number) + SESSION_WINDOW_MS - at) / 1000));
      sessionAttempts.set(clientKey, seen);
      return { throttled: true, retryAfter };
    }
    sessionAttempts.set(clientKey, [...seen, at]);
    return null;
  }

  /** Every admin response: framable by the dashboard only, never cached or indexed. */
  function adminHeaders(c: Context, policy = ""): void {
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", `${policy}frame-ancestors ${ancestors}`);
    c.header("X-Robots-Tag", "noindex, nofollow");
  }

  function unauthorized(c: Context) {
    adminHeaders(c, "default-src 'none'; ");
    return c.json({ error: "session_required" }, 401);
  }

  /**
   * The React admin (admin-ui/, built to dist-admin/): served for /admin and
   * every client route under it, with the dashboard origins + dev-preview
   * flag injected as inert JSON. Null when the build is absent (tests, or
   * before the first `npm run build:admin`).
   */
  function reactAdminShell(c: Context): Response | null {
    if (!deps.adminUiDir) return null;
    const indexPath = join(deps.adminUiDir, "index.html");
    if (!existsSync(indexPath)) return null;
    const config = JSON.stringify({
      origins: deps.dashboardOrigins,
      devPreview: deps.devPreview === true,
    }).replace(/</g, "\\u003c");
    const html = readFileSync(indexPath, "utf8").replace('"__QUEEK_ADMIN_CONFIG__"', config);
    adminHeaders(
      c,
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; form-action 'self'; base-uri 'none'; ",
    );
    return c.html(html);
  }

  function missingBuild(c: Context) {
    adminHeaders(c, "default-src 'none'; ");
    return c.json(
      { error: "admin_not_built", message: "The admin UI is not built yet — run npm run build:admin." },
      404,
    );
  }

  // The embedded page itself: the built React admin. No data is served here;
  // the page exchanges a dashboard token for its own session first.
  app.get(ADMIN_PAGE_PATH, (c) => reactAdminShell(c) ?? missingBuild(c));

  if (deps.devPreview === true) {
    app.post(`${ADMIN_PAGE_PATH}/dev-session`, async (c) => {
      const host = new URL(c.req.url).hostname;
      const viaProxy = ["x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded"].some((name) =>
        c.req.header(name),
      );
      if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(host) || viaProxy) {
        adminHeaders(c, "default-src 'none'; ");
        return c.json({ error: "not_found" }, 404);
      }
      const installs = await deps.installations.listInstallations();
      const target = installs.find((row) => row.embedSecret);
      const issued = target ? issueAdminSession(target, "dev-preview", now()) : null;
      if (!issued) {
        adminHeaders(c, "default-src 'none'; ");
        return c.json(
          {
            error: "no_dev_install",
            message: "Run queek app dev once so this app is installed on your dev store.",
          },
          409,
        );
      }
      log.info("admin dev preview session", { installation: issued.installation.installationPid });
      adminHeaders(c, "default-src 'none'; ");
      return c.json({ token: issued.token, expires_in: issued.expiresIn });
    });
  }

  // The ONE server-side verification of the dashboard token.
  app.post(`${ADMIN_PAGE_PATH}/session`, async (c) => {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    const clientKey = forwarded || c.req.header("x-real-ip") || "unknown";
    const limited = sessionThrottled(clientKey);
    if (limited) {
      log.warn("admin session throttled", { client: clientKey });
      adminHeaders(c, "default-src 'none'; ");
      c.header("Retry-After", String(limited.retryAfter));
      return c.json({ error: "too_many_requests" }, 429);
    }
    const dashboardToken = bearerToken(c.req.header("Authorization"));
    const established = dashboardToken
      ? await establishAdminSession(deps.installations, dashboardToken, now())
      : null;
    if (!established) {
      log.warn("admin session refused");
      return unauthorized(c);
    }
    log.info("admin session started", { installation: established.installation.installationPid });
    adminHeaders(c, "default-src 'none'; ");
    return c.json({ token: established.token, expires_in: established.expiresIn });
  });

  async function guard(c: Context<AdminEnv>, next: Next) {
    const session = await verifyAdminSession(
      deps.installations,
      bearerToken(c.req.header("Authorization")),
      now(),
    );
    if (!session) return unauthorized(c);
    adminHeaders(c, "default-src 'none'; ");
    c.set("installation", session.installation);
    await next();
  }
  app.use(ADMIN_APP_PATH, guard);
  app.use(`${ADMIN_APP_PATH}/*`, guard);

  function greetingOf(installation: InstallationRecord): string | null {
    const greeting = installation.settings?.greeting;
    return typeof greeting === "string" ? greeting : null;
  }

  // The starter's one settings form: read the `greeting` setting.
  app.get(`${ADMIN_API_PATH}/settings`, (c) => {
    const installation = c.get("installation");
    return c.json({ greeting: greetingOf(installation) });
  });

  // Save the `greeting` setting onto the stored installation row (the same
  // row the install handoff wrote — Queek re-sends settings on resync).
  app.put(`${ADMIN_API_PATH}/settings`, async (c) => {
    const installation = c.get("installation");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_greeting", message: "Send a JSON body with a greeting string." }, 422);
    }
    const greeting = (body as Record<string, unknown>).greeting;
    if (typeof greeting !== "string" || greeting.length > GREETING_MAX_LENGTH) {
      return c.json(
        {
          error: "invalid_greeting",
          message: `Greeting must be a string up to ${GREETING_MAX_LENGTH} chars.`,
        },
        422,
      );
    }
    await deps.installations.saveInstallation({
      ...installation,
      settings: { ...installation.settings, greeting },
      updatedAt: new Date().toISOString(),
    });
    log.info("admin saved settings", { installation: installation.installationPid });
    return c.json({ greeting });
  });

  // The example Merchant API call: the store profile, through the
  // installation client (short-lived token, never the page's session).
  app.get(`${ADMIN_API_PATH}/store`, async (c) => {
    const installation = c.get("installation");
    try {
      const profile = await deps.clientFor(installation).getStore();
      return c.json({ store: profile });
    } catch {
      log.error("admin Merchant API check failed", { installation: installation.installationPid });
      return c.json({ error: "merchant_unreachable", message: "Queek did not answer. Try again." }, 502);
    }
  });

  // React admin assets (hashed, immutable) and client routes.
  app.get(`${ADMIN_PAGE_PATH}/assets/*`, (c) =>
    serveAdminFile(
      deps.adminUiDir ?? null,
      c.req.path.slice(ADMIN_PAGE_PATH.length + 1),
      "public, max-age=31536000, immutable",
    ),
  );
  app.get(`${ADMIN_PAGE_PATH}/theme-boot.js`, () =>
    serveAdminFile(deps.adminUiDir ?? null, "theme-boot.js", "no-cache"),
  );
  app.get(`${ADMIN_PAGE_PATH}/fonts/*`, (c) =>
    serveAdminFile(
      deps.adminUiDir ?? null,
      c.req.path.slice(ADMIN_PAGE_PATH.length + 1),
      "public, max-age=31536000, immutable",
    ),
  );
  app.get(`${ADMIN_PAGE_PATH}/*`, (c) => {
    if (c.req.path.startsWith(`${ADMIN_APP_PATH}/`) || c.req.path === ADMIN_APP_PATH) return c.notFound();
    return reactAdminShell(c) ?? missingBuild(c);
  });

  return app;
}
