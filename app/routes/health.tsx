import { APP_SLUG } from "../config.js";
import { getRuntime } from "../queek.server.js";

/**
 * Unauthenticated readiness for your host's health check. It boots the
 * runtime (config, key parsing, installation store) once, so a container
 * with missing or malformed secrets answers 503 instead of passing the
 * check and failing on the first install. The body never carries the reason;
 * the reason goes to the log.
 */
export async function loader() {
  try {
    getRuntime();
  } catch (error) {
    console.error(
      `[${APP_SLUG}] not ready: ${error instanceof Error ? error.message : "runtime failed to start"}`,
    );
    return Response.json({ ok: false, app: APP_SLUG }, { status: 503 });
  }
  return Response.json({ ok: true, app: APP_SLUG, time: new Date().toISOString() });
}
