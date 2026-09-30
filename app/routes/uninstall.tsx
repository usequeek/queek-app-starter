import type { ActionFunctionArgs } from "react-router";
import { installAction } from "../queek.server.js";

/** Uninstall handoff (Queek → `POST /uninstall`): purges the installation. */
export const action = async ({ request }: ActionFunctionArgs) => installAction(request);
