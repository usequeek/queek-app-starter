import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The merchant admin: a React SPA served by the app's Hono server at /admin.
export default defineConfig({
  root: __dirname,
  base: "/admin/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: { outDir: path.resolve(__dirname, "../dist-admin"), emptyOutDir: true },
});
