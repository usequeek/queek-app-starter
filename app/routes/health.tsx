import { APP_SLUG } from "../config.js";

/** Unauthenticated liveness (the Dokploy check): never a session here. */
export async function loader() {
  return Response.json({ ok: true, app: APP_SLUG, time: new Date().toISOString() });
}
