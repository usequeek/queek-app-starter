import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { type EntryContext, ServerRouter } from "react-router";
import { dashboardOrigins } from "./queek.server.js";

export const streamTimeout = 5000;

/**
 * The server entry: streams the document and stamps the Queek document
 * headers. Embedded admin documents (`/admin*`) are framable by the
 * dashboard only (`frame-ancestors`), never cached or indexed.
 */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  const url = new URL(request.url);
  if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
    // Admin documents set no script/style CSP: React Router streams inline
    // hydration scripts, which a strict `script-src` would block without a
    // per-request nonce. The framability, no-cache and no-index headers
    // apply to every admin document.
    responseHeaders.set("Content-Security-Policy", `frame-ancestors ${dashboardOrigins().join(" ")}`);
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.set("X-Robots-Tag", "noindex, nofollow");
  }
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          console.error(error);
        },
      },
    );

    setTimeout(abort, streamTimeout + 1000);
  });
}
