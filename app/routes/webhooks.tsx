import type { ActionFunctionArgs } from "react-router";
import { webhookAction } from "../queek.server.js";

/** Topic deliveries (Queek → `POST /webhooks`, per-installation secret). */
export const action = async ({ request }: ActionFunctionArgs) => webhookAction(request);
