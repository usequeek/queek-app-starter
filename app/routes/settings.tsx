import type { ActionFunctionArgs } from "react-router";
import { installAction } from "../queek.server.js";

/**
 * Settings/resync handoff (Queek → `POST /settings`): merges rotated
 * secrets, non-secret settings and scopes into the stored row.
 */
export const action = async ({ request }: ActionFunctionArgs) => installAction(request);
