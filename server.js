// The app server: the same `@react-router/express` handler that
// `react-router-serve` runs, with one addition — per-request load context
// carrying the direct socket peer, so loaders can enforce the loopback-only
// dev preview (see app/load-context.ts). Production serves the React Router
// build; development serves Vite in middleware mode (HMR included).
//
// Env: PORT (default 3000), NODE_ENV=production for the build (the Dockerfile
// sets it; `queek app dev` injects development plus the app credentials).

import { createRequestHandler } from "@react-router/express";
import express from "express";

const HOST = process.env.HOST;
const PORT = Number(process.env.PORT ?? "3000");
const MODE = process.env.NODE_ENV === "production" ? "production" : "development";

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PROXY_HEADERS = ["x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded"];

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
    app.use(express.static("public", { maxAge: "1h" }));
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
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => server?.close(console.error));
  }
}

await main();
