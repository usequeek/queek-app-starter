import type { ActionFunctionArgs } from "react-router";
import { issueAdminSession } from "../admin-session.js";
import { type AppLoadContext, isLoopbackRequest } from "../load-context.js";
import { adminJson, getRuntime } from "../queek.server.js";

/**
 * Local dev preview: `/admin` opened directly on this machine (not framed
 * by Queek) signs in as the local dev install. Only ever under
 * NODE_ENV=development, and only on loopback without forwarding headers
 * (the tunnel adds them), so a public tunnel URL never gets a session.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  if (process.env.NODE_ENV !== "development") return adminJson({ error: "not_found" }, 404);
  if (!isLoopbackRequest(request, context as AppLoadContext | null)) {
    return adminJson({ error: "not_found" }, 404);
  }
  const runtime = getRuntime();
  const installs = await runtime.store.listInstallations();
  // Several dev installs can each hold an embed secret — preview the most
  // recently updated one (the store just installed), deterministically.
  const candidates = installs.filter((row) => row.embedSecret);
  candidates.sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return a.installationId < b.installationId ? -1 : 1;
    return a.updatedAt < b.updatedAt ? 1 : -1;
  });
  const target = candidates[0];
  const issued = target ? issueAdminSession(target, "dev-preview") : null;
  if (!issued) {
    return adminJson(
      {
        error: "no_dev_install",
        message: "Run queek app dev once so this app is installed on your dev store.",
      },
      409,
    );
  }
  runtime.log.info("admin dev preview session", { installation: issued.installation.installationPid });
  return adminJson({ token: issued.token, expires_in: issued.expiresIn });
};
