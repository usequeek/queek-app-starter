import type { LoaderFunctionArgs } from "react-router";
import { adminJson, getAdminSession, getRuntime, storeProfileFor } from "../queek.server.js";

/**
 * The example Merchant API call: the store profile, through the
 * installation client (short-lived token, never the page's session).
 * Session-guarded: the session bearer IS the scope (foreign ids 404 — here
 * there are no id-addressed routes at all).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const runtime = getRuntime();
  const session = await getAdminSession(request, runtime);
  if (!session) return adminJson({ error: "session_required" }, 401);
  const result = await storeProfileFor(session.installation, runtime);
  if (!result.ok) {
    return adminJson({ error: "merchant_unreachable", message: "Queek did not answer. Try again." }, 502);
  }
  return adminJson({ store: result.store });
}
