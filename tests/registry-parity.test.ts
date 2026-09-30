import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Registry parity: the vendored UI is a byte-identical copy of the Queek
 * registry items (`shadcn add` copy semantics), and the theme CSS carries
 * every token value. Refresh = `npx shadcn add @queek/<item> --overwrite`
 * (then `npm run lint`, which ignores `admin-ui/src/components/**` via
 * biome.json overrides so vendored bytes stay frozen).
 *
 * The registry lives outside this repo (built, not yet deployed); the dir
 * is overridable for scaffolds created from this starter, and the suite
 * skips when it is absent instead of failing a renamed copy.
 */

const REGISTRY_DIR =
  process.env.QUEEK_REGISTRY_DIR ?? "/Users/benny/Documents/nextjs/queek-merchant-wt-devux/public/r/v1";
const HAS_REGISTRY = existsSync(join(REGISTRY_DIR, "registry.json"));

const ADMIN_UI = join(dirname(fileURLToPath(import.meta.url)), "..", "admin-ui");

/** Resolve a registry `target` (`@ui/x`, `@components/y`) through components.json aliases. */
function resolveTarget(target: string): string {
  const components = JSON.parse(readFileSync(join(ADMIN_UI, "components.json"), "utf8")) as {
    aliases: Record<string, string>;
  };
  const noAt = target.startsWith("@") ? target.slice(1) : target;
  const slash = noAt.indexOf("/");
  const key = slash === -1 ? noAt : noAt.slice(0, slash);
  const rest = slash === -1 ? "" : noAt.slice(slash);
  const base = components.aliases[key];
  if (typeof base !== "string" || !base.startsWith("@/")) throw new Error(`Unknown alias ${key}`);
  return join(ADMIN_UI, "src", base.slice(2) + rest);
}

describe.skipIf(!HAS_REGISTRY)("registry item bytes", () => {
  for (const name of ["queek-style", "page-header", "empty-state"]) {
    it(`${name} is byte-identical on disk`, () => {
      const item = JSON.parse(readFileSync(join(REGISTRY_DIR, `${name}.json`), "utf8")) as {
        files?: Array<{ path: string; content: string; target: string }>;
      };
      expect(item.files?.length).toBeGreaterThan(0);
      for (const file of item.files ?? []) {
        expect(readFileSync(resolveTarget(file.target), "utf8")).toBe(file.content);
      }
    });
  }

  it("all items ship the same registry version marker", () => {
    const versions = new Set<string>();
    for (const name of [
      "queek-theme",
      "queek-font",
      "queek-style",
      "setup-guide",
      "weekly-hours",
      "page-header",
      "empty-state",
      "resource-picker-button",
    ]) {
      const item = JSON.parse(readFileSync(join(REGISTRY_DIR, `${name}.json`), "utf8")) as {
        meta?: { queek?: { registryVersion?: string } };
      };
      versions.add(item.meta?.queek?.registryVersion ?? "missing");
    }
    expect([...versions]).toEqual(["1.0.0"]);
  });
});

describe.skipIf(!HAS_REGISTRY)("queek-theme values", () => {
  it("index.css carries every light/dark token value", () => {
    const theme = JSON.parse(readFileSync(join(REGISTRY_DIR, "queek-theme.json"), "utf8")) as {
      cssVars: { theme: Record<string, string>; light: Record<string, string>; dark: Record<string, string> };
    };
    // Lowercased: biome formats hex (`#00A884` → `#00a884`) — same color.
    const css = readFileSync(join(ADMIN_UI, "src", "index.css"), "utf8").toLowerCase();
    for (const [scope, vars] of Object.entries(theme.cssVars)) {
      for (const [key, value] of Object.entries(vars)) {
        if (key === "font-sans" || key === "font-mono") continue;
        expect(css, `${scope}.${key}`).toContain(`--${key}: ${value.toLowerCase()};`);
      }
    }
  });
});

describe("components.json", () => {
  it("declares the @queek registry so npx shadcn add @queek/... resolves", () => {
    const components = JSON.parse(readFileSync(join(ADMIN_UI, "components.json"), "utf8")) as {
      registries?: Record<string, string>;
    };
    expect(components.registries?.["@queek"]).toBe("https://dashboard.usequeek.com/r/v1/{name}.json");
  });
});
