import type { ActionFunctionArgs } from "react-router";
import { bearerToken } from "../admin-session.js";
import type { AppLoadContext } from "../load-context.js";
import {
  adminJson,
  checkSessionThrottle,
  exchangeDashboardToken,
  getRuntime,
  sessionClientKey,
} from "../queek.server.js";

/**
 * The ONE server-side verification of the dashboard token: trade it ONCE
 * for the app's own short session bearer. Throttled per client (429 +
 * Retry-After); anything unverifiable answers 401.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const runtime = getRuntime();
  const key = sessionClientKey(request, context as AppLoadContext | null);
  const limited = checkSessionThrottle(key);
  if (limited) {
    runtime.log.warn("admin session throttled", { client: key });
    const throttled = adminJson({ error: "too_many_requests" }, 429);
    throttled.headers.set("Retry-After", String(limited.retryAfter));
    return throttled;
  }
  const dashboardToken = bearerToken(request.headers.get("Authorization") ?? undefined);
  const established = dashboardToken ? await exchangeDashboardToken(dashboardToken, runtime) : null;
  if (!established) {
    runtime.log.warn("admin session refused");
    return adminJson({ error: "session_required" }, 401);
  }
  runtime.log.info("admin session started", { installation: established.installation.installationPid });
  return adminJson({ token: established.token, expires_in: established.expiresIn });
};
