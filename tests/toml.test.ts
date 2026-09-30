import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { APP_SLUG, DEFAULT_BASE_URL } from "../app/config.js";

/**
 * PARTIAL MIRROR — NOT the backend validator. This starter's queek.app.toml,
 * mapped onto the flat manifest shape and checked against a hand-copied
 * SUBSET of the backend's `App\Services\Apps\AppManifestValidator` rules
 * (queek_backend).
 *
 * What this mirror deliberately does NOT cover: the full Laratrust scope
 * catalogue (KNOWN_SCOPES below is 5 entries; the backend checks
 * `PermissionConstants::ALL_PERMISSIONS`), the URL guard's DNS/SSRF rules
 * (`WebhookUrlGuard::reject`), the dashboard rules, and any future
 * validator rule. Mirror-green NEVER means backend-validator-green.
 *
 * SOURCE OF TRUTH IS THE BACKEND: `queek app deploy` runs the real
 * validator. This test exists so a typo'd toml fails here first — if the
 * backend validator changes, this mirror must be updated to match.
 *
 * Mirrored rules:
 * - top-level keys: slug, name, version, distribution, icon, developer,
 *   category, description, tagline, description_long, highlights, logo_url,
 *   pricing, developer_url, privacy_url, support_url, scopes, webhook_topics,
 *   settings, install_url, uninstall_url, settings_url, webhook_url
 *   (unknown rejected)
 * - extensions: ONLY proxy/blocks/merchant_page_url/nav (the live
 *   `AppManifestValidator::validateExtensions` rejectUnknown list) —
 *   merchant_page_url and proxy.url must be https; nav mirrors
 *   `validateNav`/`assertNavPath` (≤10 entries of {label, path}, label ≤40
 *   chars without control characters, path ≤2048 chars, 5-round decoded,
 *   no `..`/scheme/backslash, single leading `/`, under the merchant page
 *   path prefix, and refused without a merchant_page_url)
 * - slug `^[a-z0-9][a-z0-9-]{1,63}$`, name ≤120, icon `^[a-z0-9_-]+$` ≤64
 * - scopes non-empty; each a known merchant permission and NOT under a
 *   non-delegable prefix (merchant-api_keys/roles/users/employees/pos/apps-)
 * - webhook_topics ⊆ the 11-topic catalogue (App\Enums\WebhookTopic);
 *   topics require webhook_url
 * - settings fields: key `^[a-z0-9_]{1,64}$`, label ≤120,
 *   type ∈ string|secret|number|boolean|select, options required iff select
 * - install/uninstall/settings/webhook URLs must be https
 */

// SUBSET of the backend's PermissionConstants::ALL_PERMISSIONS — just enough
// for this starter's toml. A new app needing other scopes must extend this
// list (and re-check it against the backend), never assume membership.
const KNOWN_SCOPES = new Set([
  "merchant-business_profile-read",
  "merchant-orders-read",
  "merchant-products-read",
  "merchant-inventory-read",
  "merchant-customers-read",
]);
const NON_DELEGABLE_PREFIXES = [
  "merchant-api_keys-",
  "merchant-roles-",
  "merchant-users-",
  "merchant-employees-",
  "merchant-pos-",
  "merchant-apps-",
];
const KNOWN_TOPICS = new Set([
  "orders/create",
  "orders/paid",
  "orders/updated",
  "orders/fulfilled",
  "orders/cancelled",
  "products/create",
  "products/update",
  "products/delete",
  "customers/create",
  "customers/update",
  "inventory_levels/update",
]);
const TOP_LEVEL_KEYS = new Set([
  "slug",
  "name",
  "version",
  "distribution",
  "icon",
  "developer",
  "category",
  "description",
  "tagline",
  "description_long",
  "highlights",
  "logo_url",
  "pricing",
  "developer_url",
  "privacy_url",
  "support_url",
  "scopes",
  "webhook_topics",
  "settings",
  "install_url",
  "uninstall_url",
  "settings_url",
  "webhook_url",
  "extensions",
]);

interface TomlDoc {
  slug?: unknown;
  name?: unknown;
  version?: unknown;
  distribution?: unknown;
  icon?: unknown;
  developer?: unknown;
  category?: unknown;
  handle?: unknown;
  listing?: Record<string, unknown>;
  access?: { scopes?: unknown };
  webhooks?: { topics?: unknown; url?: unknown };
  app?: Record<string, unknown>;
  settings?: unknown;
  extensions?: Record<string, unknown>;
}

/** The grouped toml flattened onto the manifest shape the CLI deploys. */
function toManifest(doc: TomlDoc): Record<string, unknown> {
  const manifest: Record<string, unknown> = {};
  for (const key of [
    "slug",
    "handle",
    "name",
    "version",
    "distribution",
    "icon",
    "developer",
    "category",
  ] as const) {
    if (doc[key] !== undefined) manifest[key] = doc[key];
  }
  Object.assign(manifest, doc.listing ?? {});
  if (doc.access?.scopes !== undefined) manifest.scopes = doc.access.scopes;
  if (doc.webhooks?.topics !== undefined) manifest.webhook_topics = doc.webhooks.topics;
  if (doc.webhooks?.url !== undefined) manifest.webhook_url = doc.webhooks.url;
  Object.assign(manifest, doc.app ?? {});
  if (doc.settings !== undefined) manifest.settings = doc.settings;
  if (doc.extensions !== undefined) manifest.extensions = doc.extensions;
  return manifest;
}

const NAV_MAX_ITEMS = 10;
const NAV_LABEL_MAX = 40;
const NAV_PATH_MAX = 2048;

/**
 * Mirrors `AppManifestValidator::assertNavPath`: decode fully (repeatedly —
 * the browser resolves %2e as `.`, so one pass would let %252e%252e walk
 * out), then the shape rules, then the merchant-page prefix bound.
 */
const hasControlChars = (value: string): boolean =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0) as number;
    return (code >= 0x00 && code <= 0x1f) || code === 0x7f;
  });

function navPathError(path: string, prefix: string, index: number): string | null {
  const where = `extensions.nav[${index}].path`;
  let decoded = path;
  for (let round = 0; round < 5; round += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // rawurldecode leaves malformed sequences literal
    }
    if (next === decoded) break;
    decoded = next;
  }
  if (hasControlChars(decoded)) return `The ${where} must not contain control characters.`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) {
    return `The ${where} must be a relative path, never a URL with a scheme.`;
  }
  if (decoded.includes("\\")) return `The ${where} must not contain backslashes.`;
  if (!decoded.startsWith("/") || decoded.startsWith("//")) {
    return `The ${where} must be a relative path starting with a single '/'.`;
  }
  if (decoded.split("/").includes("..")) return `The ${where} must not contain '..' segments.`;
  if (prefix !== "" && decoded !== prefix && !decoded.startsWith(`${prefix}/`)) {
    return `The ${where} must stay under the app page path '${prefix}'.`;
  }
  return null;
}

function validateManifest(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(manifest)) {
    if (key === "handle") {
      errors.push("CLI-only 'handle' must be translated to 'slug' before deploy.");
    } else if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`Unknown field '${key}' in manifest.`);
    }
  }
  if (typeof manifest.slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.slug)) {
    errors.push("The slug must be 2-64 lowercase letters, digits or dashes.");
  }
  if (typeof manifest.name !== "string" || manifest.name.length > 120) {
    errors.push("The name must be a string up to 120 chars.");
  }
  const icon = manifest.icon;
  if (icon !== undefined && (typeof icon !== "string" || icon.length > 64 || !/^[a-z0-9_-]+$/.test(icon))) {
    errors.push("The icon must be an icon name (letters, digits, dash, underscore) — never a URL or image.");
  }
  const scopes = manifest.scopes;
  if (!Array.isArray(scopes) || scopes.length < 1) {
    errors.push("The scopes must be a non-empty array.");
  } else {
    for (const scope of scopes) {
      if (typeof scope !== "string" || !KNOWN_SCOPES.has(scope)) {
        errors.push(`Unknown scope '${String(scope)}'. Scopes are Laratrust merchant permission names.`);
      } else if (NON_DELEGABLE_PREFIXES.some((prefix) => scope.startsWith(prefix))) {
        errors.push(`The '${scope}' scope can never be granted to an app.`);
      }
    }
  }
  const topics = manifest.webhook_topics;
  if (topics !== undefined) {
    if (!Array.isArray(topics)) {
      errors.push("webhook_topics must be an array.");
    } else {
      for (const topic of topics) {
        if (typeof topic !== "string" || !KNOWN_TOPICS.has(topic)) {
          errors.push(`Unknown webhook topic '${String(topic)}'.`);
        }
      }
      if (topics.length > 0 && manifest.webhook_url == null) {
        errors.push("webhook_topics needs webhook_url: topics without a receiver URL are refused.");
      }
    }
  }
  const settings = manifest.settings;
  if (settings !== undefined) {
    if (!Array.isArray(settings)) {
      errors.push("settings must be an array.");
    } else {
      settings.forEach((field: unknown, index: number) => {
        const where = `settings[${index}]`;
        const record = field as Record<string, unknown>;
        for (const key of Object.keys(record)) {
          if (!["key", "label", "type", "required", "options", "help"].includes(key)) {
            errors.push(`Unknown field '${key}' in ${where}.`);
          }
        }
        if (typeof record.key !== "string" || !/^[a-z0-9_]{1,64}$/.test(record.key)) {
          errors.push(`Bad key in ${where}.`);
        }
        if (typeof record.label !== "string" || record.label.length > 120) {
          errors.push(`Bad label in ${where}.`);
        }
        const type = record.type;
        if (!["string", "secret", "number", "boolean", "select"].includes(type as string)) {
          errors.push(`Bad type in ${where}.`);
        }
        if (type === "select" && (!Array.isArray(record.options) || record.options.length < 1)) {
          errors.push(`A select setting needs at least one option (${where}).`);
        }
      });
    }
  }
  const extensions = manifest.extensions;
  if (extensions !== undefined) {
    if (typeof extensions !== "object" || extensions === null || Array.isArray(extensions)) {
      errors.push("extensions must be a table.");
    } else {
      for (const key of Object.keys(extensions)) {
        if (!["proxy", "blocks", "merchant_page_url", "nav"].includes(key)) {
          errors.push(
            `Unknown extensions key '${key}': the backend allows only proxy/blocks/merchant_page_url/nav.`,
          );
        }
      }
      const record = extensions as Record<string, unknown>;
      if (record.merchant_page_url !== undefined && typeof record.merchant_page_url !== "string") {
        errors.push("extensions.merchant_page_url must be a string.");
      }
      const nav = record.nav;
      if (nav !== undefined) {
        if (!Array.isArray(nav)) {
          errors.push("extensions.nav must be an array.");
        } else {
          if (nav.length > NAV_MAX_ITEMS)
            errors.push(`extensions.nav must have at most ${NAV_MAX_ITEMS} entries.`);
          const pageUrl = record.merchant_page_url;
          if (typeof pageUrl !== "string" || pageUrl === "") {
            errors.push(
              "extensions.nav needs extensions.merchant_page_url: sidebar entries have no page to live under.",
            );
          }
          let prefix = "";
          if (typeof pageUrl === "string" && pageUrl !== "") {
            try {
              prefix = new URL(pageUrl).pathname.replace(/\/+$/, "");
            } catch {
              prefix = "";
            }
          }
          nav.forEach((item: unknown, index: number) => {
            const where = `extensions.nav[${index}]`;
            if (typeof item !== "object" || item === null || Array.isArray(item)) {
              errors.push(`${where} must be a table with label and path.`);
              return;
            }
            const entry = item as Record<string, unknown>;
            for (const key of Object.keys(entry)) {
              if (!["label", "path"].includes(key)) errors.push(`Unknown field '${key}' in ${where}.`);
            }
            const label = entry.label;
            if (
              typeof label !== "string" ||
              label.length === 0 ||
              label.length > NAV_LABEL_MAX ||
              hasControlChars(label)
            ) {
              errors.push(`${where}.label must be a string up to 40 chars without control characters.`);
            }
            const navPath = entry.path;
            if (typeof navPath !== "string" || navPath.length > NAV_PATH_MAX) {
              errors.push(`${where}.path must be a string up to 2048 chars.`);
            } else {
              const pathError = navPathError(navPath, prefix, index);
              if (pathError) errors.push(pathError);
            }
          });
        }
      }
      const proxy = record.proxy;
      if (proxy !== undefined) {
        if (typeof proxy !== "object" || proxy === null || Array.isArray(proxy)) {
          errors.push("extensions.proxy must be a table.");
        } else {
          for (const key of Object.keys(proxy)) {
            if (!["url", "subpath", "share_customer_id"].includes(key)) {
              errors.push(`Unknown field '${key}' in extensions.proxy.`);
            }
          }
        }
      }
    }
  }
  for (const field of ["install_url", "uninstall_url", "settings_url", "webhook_url"]) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.startsWith("https://")) {
      errors.push(`The ${field} must be an https URL.`);
    }
  }
  if (manifest.install_url === undefined) errors.push("The install_url field is required.");
  if (manifest.uninstall_url === undefined) errors.push("The uninstall_url field is required.");
  const ext = manifest.extensions as Record<string, unknown> | undefined;
  for (const value of [ext?.merchant_page_url, (ext?.proxy as Record<string, unknown> | undefined)?.url]) {
    if (value !== undefined && (typeof value !== "string" || !value.startsWith("https://"))) {
      errors.push("extensions URLs (merchant_page_url, proxy.url) must be https URLs.");
    }
  }
  return errors;
}

const TOML_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "queek.app.toml");

describe("queek.app.toml mirror", () => {
  it("parses and passes the backend-rule subset", () => {
    const doc = parseToml(readFileSync(TOML_PATH, "utf8")) as unknown as TomlDoc;
    expect(validateManifest(toManifest(doc))).toEqual([]);
  });

  it("carries no version (Shopify parity: backend auto-assigns, --version names)", () => {
    const doc = parseToml(readFileSync(TOML_PATH, "utf8")) as unknown as TomlDoc;
    expect(doc.version).toBeUndefined();
  });

  it("keeps extensions deployable: merchant page ships, nav entries allowed", () => {
    const doc = parseToml(readFileSync(TOML_PATH, "utf8")) as unknown as TomlDoc;
    const manifest = toManifest(doc);
    const extensions = manifest.extensions as Record<string, unknown>;
    expect(extensions.merchant_page_url).toBe(`${DEFAULT_BASE_URL}/admin`);
    // Nothing shipped under nav yet — but a live-style entry under the
    // merchant page prefix passes the mirror (sidebar entries are shippable).
    const withNav = {
      ...manifest,
      extensions: { ...extensions, nav: [{ label: "Settings", path: "/admin/settings" }] },
    };
    expect(validateManifest(withNav)).toEqual([]);
  });

  it("mirrors validateNav: nav needs the merchant page and prefix-bound safe paths", () => {
    const doc = parseToml(readFileSync(TOML_PATH, "utf8")) as unknown as TomlDoc;
    const manifest = toManifest(doc);
    const extensions = manifest.extensions as Record<string, unknown>;
    const check = (nav: unknown, pageUrl: unknown = `${DEFAULT_BASE_URL}/admin`): string[] =>
      validateManifest({
        ...manifest,
        extensions: { ...extensions, merchant_page_url: pageUrl, nav },
      });
    // The page itself and anything under its prefix pass.
    expect(check([{ label: "Home", path: "/admin" }])).toEqual([]);
    expect(check([{ label: "Settings", path: "/admin/settings" }])).toEqual([]);
    // Sidebar entries with no page to live under are refused.
    expect(check([{ label: "Home", path: "/admin" }], null).join(" ")).toContain("merchant_page_url");
    // Unknown nav keys are refused.
    expect(
      check([{ label: "Home", path: "/admin", icon: "wave" }]).some((error) => error.includes("icon")),
    ).toBe(true);
    // Paths must stay under the page prefix: shape violations are refused.
    for (const path of [
      "/other",
      "/admin/../other",
      "/admin/%252e%252e/other",
      "https://evil.test/admin",
      "//admin",
      "admin/settings",
      "/admin\\settings",
    ]) {
      expect(check([{ label: "Home", path }])).not.toEqual([]);
    }
    // Labels are short strings without control characters; at most 10 entries.
    expect(check([{ label: "x".repeat(41), path: "/admin" }])).not.toEqual([]);
    expect(check([{ label: "", path: "/admin" }])).not.toEqual([]);
    expect(
      check(Array.from({ length: 11 }, (_, index) => ({ label: `Item ${index}`, path: "/admin" }))),
    ).not.toEqual([]);
  });

  it("maps the groups onto flat manifest names", () => {
    const doc = parseToml(readFileSync(TOML_PATH, "utf8")) as unknown as TomlDoc;
    const manifest = toManifest(doc);
    // Slug-derived: `npm create` renames slug + base URL, and the scaffold
    // must stay green — so expect the rename, never the template value.
    expect(manifest.slug).toBe(APP_SLUG);
    expect(manifest.scopes).toEqual(["merchant-business_profile-read"]);
    expect(manifest.webhook_topics).toEqual(["orders/updated"]);
    expect(manifest.webhook_url).toBe(`${DEFAULT_BASE_URL}/webhooks`);
    expect(manifest.install_url).toBe(`${DEFAULT_BASE_URL}/install`);
  });
});
