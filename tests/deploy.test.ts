import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The runtime image must serve the React Router build — otherwise prod has no app. */
describe("deploy ships the built app", () => {
  it("Dockerfile copies the build output and the server into the runtime image", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY --from=build /repo/build ./build");
    expect(dockerfile).toContain("server.js");
    expect(dockerfile).not.toContain("dist-admin");
  });

  it("the server starts the build (never react-router-serve without the loopback context)", () => {
    const server = readFileSync(join(ROOT, "server.js"), "utf8");
    expect(server).toContain("build/server/index.js");
    expect(server).toContain("getLoadContext");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.start).toContain("server.js");
    expect(pkg.scripts?.build).toBe("react-router build");
  });

  it(".dockerignore keeps build sources out of the ignore list", () => {
    const ignored = readFileSync(join(ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .map((line) => line.trim().replace(/\/+$/, ""))
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(ignored).not.toContain("app");
    expect(ignored).not.toContain("build");
    expect(ignored).not.toContain("server.js");
  });

  it("the manifest merchant page is the served /admin path", () => {
    const doc = parseToml(readFileSync(join(ROOT, "queek.app.toml"), "utf8")) as unknown as {
      extensions?: { merchant_page_url?: unknown };
    };
    expect(doc.extensions?.merchant_page_url).toBe("https://my-app.apps.queek.com.ng/admin");
  });

  it("the dev command runs the app server (HMR via Vite middleware)", () => {
    const doc = parseToml(readFileSync(join(ROOT, "queek.app.toml"), "utf8")) as unknown as {
      dev?: { command?: unknown };
    };
    expect(doc.dev?.command).toBe("node ./server.js");
  });
});
