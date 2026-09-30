import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Registry provenance (NOT byte parity): shadcn COPIES registry files into
 * the app, so this test pins WHERE they came from and that the copies are
 * present — never that they are identical. Refresh with
 * `npx shadcn add @queek/<item> --overwrite` (never hand-edit); the
 * "Built for Queek" review compares the theme marker with the registry.
 */
describe("Queek registry provenance", () => {
  it("components.json points at the live Queek registry", () => {
    const config = JSON.parse(readFileSync(join(ROOT, "components.json"), "utf8")) as {
      registries?: Record<string, string>;
    };
    expect(config.registries?.["@queek"]).toBe("https://dashboard.usequeek.com/r/v1/{name}.json");
  });

  it("the dashboard tokens are installed (light + dark)", () => {
    // The registry advertises a `meta.queek` version marker, but the live
    // item carries none — so this pins the shipped VALUES instead: brand
    // green in both modes (a re-theme changes them; refresh overwrites).
    const css = readFileSync(join(ROOT, "app", "app.css"), "utf8");
    expect(css).toContain("@theme inline");
    expect(css).toContain(":root");
    expect(css).toContain(".dark");
    expect(css.match(/--queek-green: #00a884/gi)?.length).toBeGreaterThanOrEqual(2);
  });

  it("registry components and blocks are installed", () => {
    for (const file of [
      "app/components/ui/button.tsx",
      "app/components/ui/card.tsx",
      "app/components/ui/input.tsx",
      "app/components/ui/label.tsx",
      "app/components/page-header.tsx",
      "app/components/empty-state.tsx",
    ]) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
  });
});
