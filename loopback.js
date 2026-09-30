/**
 * Shared loopback constants — the single source of truth for `server.js`
 * (the Express host, plain Node) and `app/load-context.ts` (the request
 * gate, TypeScript). The tunnel client is never loopback, so a direct
 * loopback socket with no forwarding headers means "this machine".
 */

/** Direct socket peers that count as this machine. */
export const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Headers a proxy or tunnel adds — their presence voids the loopback gate. */
export const PROXY_HEADERS = ["x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded"];
