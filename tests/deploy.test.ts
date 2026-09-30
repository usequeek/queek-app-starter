import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The runtime image must serve the built admin — otherwise prod GET /admin is admin_not_built. */
describe("deploy ships the admin UI", () => {
  it("Dockerfile copies dist-admin into the runtime image", () => {
    const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("COPY --from=build /repo/dist-admin ./dist-admin");
  });

  it(".dockerignore keeps the admin sources out of the ignore list", () => {
    const ignored = readFileSync(join(ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .map((line) => line.trim().replace(/\/+$/, ""))
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(ignored).not.toContain("admin-ui");
    expect(ignored).not.toContain("dist-admin");
  });

  it("the manifest merchant page is the served /admin path", () => {
    const doc = parseToml(readFileSync(join(ROOT, "queek.app.toml"), "utf8")) as unknown as {
      extensions?: { merchant_page_url?: unknown };
    };
    expect(doc.extensions?.merchant_page_url).toBe("https://my-app.apps.queek.com.ng/admin");
  });
});
