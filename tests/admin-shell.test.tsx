import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

// `bridge.client` is an empty module during server rendering. Any bridge call
// made while rendering would throw here, exactly as it does on the server.
vi.mock("../app/bridge.client.js", () => ({}));
vi.mock("../app/queek.server.js", () => ({
  getRuntime: () => ({ config: { dashboardOrigins: ["https://dashboard.example"] } }),
}));

import Admin, { loader } from "../app/routes/admin.js";

async function render(): Promise<string> {
  const routes = [
    {
      path: "/admin",
      loader,
      Component: Admin,
      children: [{ index: true, Component: () => <p>child page</p> }],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/admin"));
  if (context instanceof Response) throw new Error("unexpected redirect");
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(<StaticRouterProvider router={router} context={context} />);
}

describe("the embedded admin shell, rendered on the server", () => {
  it("renders without touching the browser-only bridge", async () => {
    const html = await render();
    expect(html).toContain("Home");
    expect(html).toContain("Settings");
  });

  it("mounts the page only after the shell has configured the bridge", async () => {
    const html = await render();
    expect(html).not.toContain("child page");
  });
});
