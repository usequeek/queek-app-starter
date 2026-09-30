import type { ActionFunctionArgs } from "react-router";
import { installAction } from "../queek.server.js";

/**
 * Install handoff (Queek → `POST /install`, signed with the app secret).
 * Answers 2xx first; the Merchant API proof runs after, in the background.
 */
export const action = async ({ request }: ActionFunctionArgs) => installAction(request);
