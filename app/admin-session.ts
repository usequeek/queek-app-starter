import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { InstallationRecord, InstallationStore } from "@usequeek/app-sdk";
import { sessionTokenInstallationId, verifySessionTokenDetailed } from "@usequeek/app-sdk/server";
import { APP_SLUG } from "./config.js";

/**
 * Merchant admin sessions for the EMBEDDED app page.
 *
 * The dashboard frames `GET /admin` with a signed first load
 * (`?queek_token=…`) and answers bridge `ready` requests with the SAME
 * short-lived session token on every refresh. The page sends each here
 * ONCE through the SAME exchange callback; it is verified server-side
 * with the SDK's ONE verifier (`verifySessionTokenDetailed`: HS256 under
 * the installation's `embed_secret`, audience = app slug, issuer = the
 * handoff `api_base`, bound to this installation, vendor, slug and the
 * handoff `app_id`). Extra claims a mint may carry (including the old
 * launch/bridge `purpose`) are ignored, never gated. A valid token
 * starts the app's OWN short session, so admin requests never depend on
 * the dashboard token's 60s life.
 *
 * Carrier: an in-memory session bearer page sends as `Authorization`, NOT a
 * cookie. The page is a cross-site iframe (the dashboard and the app page
 * live on different sites), where cookies are third-party: Safari blocks
 * them outright and Chrome only keeps them partitioned (CHIPS) or while
 * third-party cookies are allowed — a session that silently vanishes by
 * browser. A header session bearer the same in every browser, is CSRF-proof
 * by construction (a cross-site form cannot set a header) and is gone with
 * the frame.
 *
 * Session format: `stadm.<base64url(json)>.<hex HMAC-SHA256>`, keyed by a
 * key DERIVED from the installation's embed secret (never the raw secret —
 * key separation from the tokens Queek signs). Installation-bound twice:
 * by the key and by the `i` claim. Uninstall (row gone) or reinstall (new
 * secret) kills every session at once. Tokens are never logged.
 */

/** Admin session life. The page re-establishes from the latest dashboard token on a 401. */
export const ADMIN_SESSION_TTL_SECONDS = 600;
const SESSION_PREFIX = "stadm";
const SIG_RE = /^[0-9a-f]{64}$/;

export interface AdminSession {
  installation: InstallationRecord;
  /** The dashboard user (`sub`) the session was established for. */
  subject: string;
  expiresAt: number;
}

type InstallationLookup = Pick<InstallationStore, "getInstallation">;

function sessionKey(embedSecret: string): Buffer {
  return createHmac("sha256", embedSecret).update("starter-admin-session-v1", "utf8").digest();
}

function sign(embedSecret: string, payload: string): string {
  return createHmac("sha256", sessionKey(embedSecret)).update(payload, "utf8").digest("hex");
}

/** `Authorization: Bearer <token>` → the token, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((header ?? "").trim());
  return match?.[1] ?? null;
}

/**
 * Verify a dashboard token ONCE and start an admin session. ONE token type:
 * the same token arrives in the first-load URL and on every refresh, so this
 * one callback verifies both with the single
 * `verifySessionTokenDetailed`. Null for anything that does not verify:
 * unknown installation, missing embed secret or app id (installed before
 * the handoff carried them — reinstall), bad signature, expired, wrong
 * audience/issuer/binding.
 */
export async function establishAdminSession(
  installations: InstallationLookup,
  dashboardToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresIn: number; installation: InstallationRecord } | null> {
  const installationId = sessionTokenInstallationId(dashboardToken);
  if (!installationId) return null;
  const installation = await installations.getInstallation(installationId);
  const embedSecret = installation?.embedSecret;
  const appId = installation?.appId;
  if (!installation || !embedSecret || !appId) return null;
  const verified = await verifySessionTokenDetailed(dashboardToken, {
    secret: embedSecret,
    audience: APP_SLUG,
    issuer: installation.apiBase.replace(/\/+$/, ""),
    expected: {
      installationId: installation.installationId,
      vendorId: installation.vendorId,
      appSlug: APP_SLUG,
      appId,
    },
  });
  if (!verified.ok) return null;
  return issueAdminSession(installation, verified.claims.subject, nowSeconds);
}

/**
 * Sign an admin session for an installation. The ONE issuer: the dashboard
 * token path above and the local dev preview (`admin.ts`, development +
 * loopback only) both end here. Null when the installation has no embed
 * secret (installed before the handoff carried it — reinstall).
 */
export function issueAdminSession(
  installation: InstallationRecord,
  subject: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { token: string; expiresIn: number; installation: InstallationRecord } | null {
  const embedSecret = installation.embedSecret;
  if (!embedSecret) return null;
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      i: installation.installationId,
      sub: subject,
      sid: randomBytes(12).toString("hex"),
      exp: nowSeconds + ADMIN_SESSION_TTL_SECONDS,
    }),
    "utf8",
  ).toString("base64url");
  return {
    token: `${SESSION_PREFIX}.${payload}.${sign(embedSecret, payload)}`,
    expiresIn: ADMIN_SESSION_TTL_SECONDS,
    installation,
  };
}

/** Verify an admin session bearer: signature under that installation's key, live, installation still here. */
export async function verifyAdminSession(
  installations: InstallationLookup,
  token: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<AdminSession | null> {
  const parts = (token ?? "").split(".");
  if (parts.length !== 3 || parts[0] !== SESSION_PREFIX || !SIG_RE.test(parts[2] ?? "")) return null;
  const [, payload = "", signature = ""] = parts;
  let claims: { v?: unknown; i?: unknown; sub?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims;
  } catch {
    return null;
  }
  if (claims.v !== 1 || typeof claims.i !== "string" || typeof claims.exp !== "number") return null;
  if (claims.exp <= nowSeconds) return null;
  const installation = await installations.getInstallation(claims.i);
  const embedSecret = installation?.embedSecret;
  if (!installation || !embedSecret) return null;
  const expected = Buffer.from(sign(embedSecret, payload), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return {
    installation,
    subject: typeof claims.sub === "string" ? claims.sub : "",
    expiresAt: claims.exp,
  };
}
