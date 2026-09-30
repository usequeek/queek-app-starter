import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { adminJson, getAdminSession, getRuntime, greetingOf, saveGreeting } from "../queek.server.js";

/** The starter's one settings form: read the `greeting` setting. */
export async function loader({ request }: LoaderFunctionArgs) {
  const runtime = getRuntime();
  const session = await getAdminSession(request, runtime);
  if (!session) return adminJson({ error: "session_required" }, 401);
  return adminJson({ greeting: greetingOf(session.installation) });
}

/** Save the `greeting` setting onto the stored installation row. */
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "PUT") {
    const methodNotAllowed = adminJson({ error: "method_not_allowed" }, 405);
    methodNotAllowed.headers.set("Allow", "PUT");
    return methodNotAllowed;
  }
  const runtime = getRuntime();
  const session = await getAdminSession(request, runtime);
  if (!session) return adminJson({ error: "session_required" }, 401);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return adminJson({ error: "invalid_greeting", message: "Send a JSON body with a greeting string." }, 422);
  }
  const saved = await saveGreeting(
    runtime.store,
    session.installation,
    (body as Record<string, unknown>).greeting,
  );
  if (!saved.ok) {
    return adminJson({ error: "invalid_greeting", message: saved.message }, 422);
  }
  runtime.log.info("admin saved settings", { installation: session.installation.installationPid });
  return adminJson({ greeting: saved.greeting });
};
