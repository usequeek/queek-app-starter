/** Per-request load context from the app server (server.js). */
export interface AppLoadContext {
  /** Direct socket peer (`req.socket.remoteAddress`), unspoofable. */
  clientIp?: string;
  /** Loopback socket AND no forwarding headers (tunnel adds them). */
  isLoopback?: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded"];

function hasProxyHeaders(headers: Headers): boolean {
  return PROXY_HEADERS.some((name) => (headers.get(name) ?? "") !== "");
}

/** True for a loopback socket peer (the tunnel client is never loopback). */
export function isLoopbackIp(ip: string | undefined): boolean {
  return ip !== undefined && LOOPBACK_IPS.has(ip.trim().toLowerCase());
}

/**
 * Loopback-only gate for the dev preview (the old Hono rule, kept byte for
 * byte in spirit): the URL host is loopback AND no proxy headers are present
 * (the tunnel adds forwarding headers, so a public tunnel URL never passes).
 * When the server supplies the socket peer it must be loopback too.
 */
export function isLoopbackRequest(request: Request, context?: AppLoadContext | null): boolean {
  const host = new URL(request.url).hostname;
  if (!LOOPBACK_HOSTS.has(host) || hasProxyHeaders(request.headers)) return false;
  if (context?.clientIp !== undefined && !isLoopbackIp(context.clientIp)) return false;
  return true;
}
