import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Like Shopify's template (vite.config.ts): the tunnel origin replaces HOST
// so the Vite server allows it, and the port follows the injected PORT.
if (process.env.HOST && (!process.env.APP_BASE_URL || process.env.APP_BASE_URL === process.env.HOST)) {
  process.env.APP_BASE_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.APP_BASE_URL || "http://localhost").hostname;

let hmrConfig: { protocol: string; host: string; port: number; clientPort: number };
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws",
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss",
    host: host,
    port: Number(process.env.FRONTEND_PORT) || 8002,
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: {
      preflightContinue: true,
    },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
}) satisfies UserConfig;
