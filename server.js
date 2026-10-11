// The app server: the same `@react-router/express` handler that
// `react-router-serve` runs, with one addition: per-request load context
// carrying the direct socket peer, so loaders can enforce the loopback-only
// dev preview (see app/load-context.ts). Production serves the React Router
// build; development serves Vite in middleware mode (HMR included).
//
// Env: PORT (default 3000); HOST (default: all interfaces); NODE_ENV=production
// for the build (the Dockerfile sets it; `queek app dev` injects development
// plus the app credentials). SIGTERM and SIGINT drain in-flight requests, then
// exit; after SHUTDOWN_GRACE_MS the remaining connections are cut.

import { createRequestHandler } from "@react-router/express";
import express from "express";
import { LOOPBACK_IPS, PROXY_HEADERS } from "./loopback.js";

const HOST = process.env.HOST;
const PORT = Number(process.env.PORT ?? "3000");
const MODE = process.env.NODE_ENV === "production" ? "production" : "development";
const SHUTDOWN_GRACE_MS = 10_000;

function getLoadContext(req) {
  const raw = req.socket?.remoteAddress;
  const clientIp = typeof raw === "string" && raw !== "" ? raw : undefined;
  const socketLoopback = clientIp !== undefined && LOOPBACK_IPS.has(clientIp.trim().toLowerCase());
  const viaProxy = PROXY_HEADERS.some((name) => {
    const value = req.headers[name];
    return (Array.isArray(value) ? value[0] : value) !== undefined && value !== "";
  });
  return { clientIp, isLoopback: socketLoopback && !viaProxy };
}

async function loadBuild(vite) {
  if (vite) return () => vite.ssrLoadModule("virtual:react-router/server-build");
  const buildPath = new URL("./build/server/index.js", import.meta.url).href;
  return await import(buildPath);
}

async function main() {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });

  let vite;
  if (MODE === "development") {
    const { createServer } = await import("vite");
    vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
    app.use(vite.middlewares);
  } else {
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.dirname(fileURLToPath(import.meta.url));
    app.use(
      "/assets",
      express.static(path.join(root, "build/client/assets"), { immutable: true, maxAge: "1y" }),
    );
    app.use(express.static(path.join(root, "build/client")));
    app.use(express.static(path.join(root, "public"), { maxAge: "1h" }));
  }

  const build = await loadBuild(vite);
  app.all(
    "*",
    createRequestHandler({
      build,
      mode: MODE,
      getLoadContext: (req) => getLoadContext(req),
    }),
  );

  const server = HOST ? app.listen(PORT, HOST) : app.listen(PORT);
  console.log(`[my-app] ${MODE} server on port ${PORT}`);

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[my-app] ${signal} received, draining requests`);
    // Hard stop if a client holds a connection open past the grace period.
    setTimeout(() => {
      console.error(`[my-app] shutdown exceeded ${SHUTDOWN_GRACE_MS} ms, cutting connections`);
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();
    server.close((error) => {
      if (error) console.error(error);
      void (vite ? vite.close() : Promise.resolve()).finally(() => process.exit(error ? 1 : 0));
    });
    server.closeIdleConnections();
  };
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => shutdown(signal));
}

await main();
