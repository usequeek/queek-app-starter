import { getRuntime, servableManifest } from "../queek.server.js";

/** The grouped `queek.app.toml` rendered with this boot's APP_BASE_URL. */
export async function loader() {
  return Response.json(servableManifest(getRuntime()));
}
