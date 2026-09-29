import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { APP_SLUG, DEFAULT_BASE_URL } from "../src/config.js";

/**
 * PARTIAL MIRROR — NOT the backend validator. This starter's queek.app.toml,
 * mapped onto the flat manifest shape and checked against a hand-copied
 * SUBSET of the backend's `App\Services\Apps\AppManifestValidator` rules
 * (queek_backend).
 *
 * What this mirror deliberately does NOT cover: the full Laratrust scope
 * catalogue (KNOWN_SCOPES below is 5 entries; the backend checks
 * `PermissionConstants::ALL_PERMISSIONS`), the URL guard's DNS/SSRF rules
 * (`WebhookUrlGuard::reject`), extensions/dashboard rules, and any future
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
  return manifest;
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
  for (const field of ["install_url", "uninstall_url", "settings_url", "webhook_url"]) {
    const value = manifest[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.startsWith("https://")) {
      errors.push(`The ${field} must be an https URL.`);
    }
  }
  if (manifest.install_url === undefined) errors.push("The install_url field is required.");
  if (manifest.uninstall_url === undefined) errors.push("The uninstall_url field is required.");
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
