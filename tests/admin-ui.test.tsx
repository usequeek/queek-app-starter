import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Client bridge tests (admin-ui has no DOM runner — no jsdom in this
 * starter): a stub window/document carries the exact surfaces
 * `admin-ui/src/lib/api.ts` touches, so every assertion runs against the
 * real module: ready/token/ack handshake, theme follow, resize-free
 * navigated/navigate, exact-origin + parent checks, and the backend-mirror
 * path rule (`..`, `\`, scheme, encoded, `//` refused).
 */

const ORIGINS = ["https://dashboard.usequeek.com"];
const HERE = dirname(fileURLToPath(import.meta.url));

interface PostedMessage {
  message: Record<string, unknown>;
  origin: string;
}

interface FakeEvent {
  source: unknown;
  origin: string;
  data: unknown;
}

type Listener = (event: FakeEvent) => void;

interface ClassList {
  add: (name: string) => void;
  remove: (name: string) => void;
  toggle: (name: string, force?: boolean) => void;
  contains: (name: string) => boolean;
}

function makeClassList(): { list: ClassList; names: Set<string> } {
  const names = new Set<string>();
  return {
    names,
    list: {
      add: (name: string) => void names.add(name),
      remove: (name: string) => void names.delete(name),
      toggle: (name: string, force?: boolean) => {
        if (force === undefined) {
          if (names.has(name)) names.delete(name);
          else names.add(name);
        } else if (force) names.add(name);
        else names.delete(name);
      },
      contains: (name: string) => names.has(name),
    },
  };
}

interface Harness {
  parent: { posted: PostedMessage[]; postMessage: (message: unknown, origin: string) => void };
  listeners: Set<Listener>;
  classes: Set<string>;
  stored: Map<string, string>;
  dispatch: (event: FakeEvent) => void;
}

const installedGlobals: string[] = [];

function installStubs(options: {
  framed: boolean;
  origins?: string;
  devPreview?: boolean;
  autoReply?: boolean;
}): Harness {
  const origins = options.origins ?? ORIGINS;
  const listeners = new Set<Listener>();
  const { list, names } = makeClassList();
  const stored = new Map<string, string>();
  const posted: PostedMessage[] = [];
  const harness: Harness = {
    parent: {
      posted,
      postMessage: (message: unknown, origin: string) => {
        posted.push({ message: message as Record<string, unknown>, origin });
        if (options.autoReply && (message as Record<string, unknown>).type === "ready") {
          harness.dispatch({
            source: harness.parent,
            origin: origins[0] ?? "",
            data: { source: "queek-merchant", type: "theme", mode: "dark" },
          });
          harness.dispatch({
            source: harness.parent,
            origin: origins[0] ?? "",
            data: { source: "queek-merchant", type: "token", token: "DASH" },
          });
        }
      },
    },
    listeners,
    classes: names,
    stored,
    dispatch: (event: FakeEvent) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
  const fakeWindow: Record<string, unknown> = {
    addEventListener: (_type: string, listener: Listener) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => void listeners.delete(listener),
    setTimeout: (fn: (...args: unknown[]) => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  fakeWindow.parent = options.framed ? harness.parent : fakeWindow;
  const fakeDocument: Record<string, unknown> = {
    getElementById: (id: string) =>
      id === "queek-admin-config"
        ? { textContent: JSON.stringify({ origins, devPreview: options.devPreview ?? false }) }
        : null,
    documentElement: { classList: list, scrollHeight: 120 },
    body: {},
  };
  const fakeStorage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  };
  const globals: Record<string, unknown> = {
    window: fakeWindow,
    document: fakeDocument,
    sessionStorage: fakeStorage,
  };
  for (const [key, value] of Object.entries(globals)) {
    (globalThis as Record<string, unknown>)[key] = value;
    installedGlobals.push(key);
  }
  return harness;
}

async function loadApi() {
  vi.resetModules();
  return import("../admin-ui/src/lib/api");
}

afterEach(() => {
  for (const key of installedGlobals.splice(0)) delete (globalThis as Record<string, unknown>)[key];
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("bridge flags", () => {
  it("framed dashboard context reports framed, never local preview", async () => {
    installStubs({ framed: true });
    const api = await loadApi();
    expect(api.isFramed).toBe(true);
    expect(api.isLocalPreview).toBe(false);
  });

  it("direct dev load reports local preview, never framed", async () => {
    installStubs({ framed: false, devPreview: true });
    const api = await loadApi();
    expect(api.isFramed).toBe(false);
    expect(api.isLocalPreview).toBe(true);
  });
});

describe("reportNavigated", () => {
  it("posts source + path to every origin when framed, silently otherwise", async () => {
    const framed = installStubs({ framed: true });
    const api = await loadApi();
    api.reportNavigated("/admin/services");
    expect(framed.parent.posted).toEqual(
      ORIGINS.map((origin) => ({
        message: { source: "queek-app", type: "navigated", path: "/admin/services" },
        origin,
      })),
    );
    installStubs({ framed: false });
    const direct = await loadApi();
    direct.reportNavigated("/admin/services");
  });
});

describe("onDashboardNavigate", () => {
  async function navigated(path: string, from?: Partial<FakeEvent>): Promise<string[]> {
    const harness = installStubs({ framed: true });
    const api = await loadApi();
    const seen: string[] = [];
    api.onDashboardNavigate((next: string) => void seen.push(next));
    harness.dispatch({
      source: harness.parent,
      origin: ORIGINS[0],
      data: { source: "queek-merchant", type: "navigate", path },
      ...from,
    });
    return seen;
  }

  it("routes safe app paths", async () => {
    for (const path of ["/admin", "/admin/services", "/admin/hours", "/", "/admin/%2F%2Fevil"]) {
      // The last decodes to `/admin///evil`: no `..`, single leading `/` —
      // accepted exactly like the backend rule, and still under `/admin/`.
      expect(await navigated(path), path).toEqual([path]);
    }
  });

  it("refuses traversal, backslashes, schemes, encoded and protocol-relative paths", async () => {
    for (const path of [
      "//evil.test/admin",
      "/admin/../x",
      "/admin/%2e%2e/x",
      "/%252e%252e/x",
      "/a\\b",
      "https://evil.test/admin",
      "javascript:alert(1)",
      "/admin/%5c",
      "/admin/%00",
      "/admin/\x01",
    ]) {
      expect(await navigated(path), path).toEqual([]);
    }
  });

  it("routes fully-encoded safe paths (decode-then-check, like the backend)", async () => {
    // `%2fadmin` decodes to `/admin`: safe after full decoding. The App maps
    // only `/admin` exactly or under `/admin/`, so the raw form goes nowhere.
    expect(await navigated("%2fadmin")).toEqual(["%2fadmin"]);
  });

  it("ignores wrong origin, wrong source, wrong sender and wrong type", async () => {
    const harness = installStubs({ framed: true });
    const api = await loadApi();
    const seen: string[] = [];
    api.onDashboardNavigate((next: string) => void seen.push(next));
    const good = {
      source: harness.parent,
      origin: ORIGINS[0],
      data: { source: "queek-merchant", type: "navigate", path: "/admin" },
    };
    harness.dispatch({ ...good, origin: "https://evil.test" });
    harness.dispatch({ ...good, source: {} });
    harness.dispatch({
      source: harness.parent,
      origin: ORIGINS[0],
      data: { source: "queek-app", type: "navigate", path: "/admin" },
    });
    harness.dispatch({
      source: harness.parent,
      origin: ORIGINS[0],
      data: { source: "queek-merchant", type: "token", path: "/admin" },
    });
    expect(seen).toEqual([]);
    harness.dispatch(good);
    expect(seen).toEqual(["/admin"]);
  });

  it("is a noop outside the frame", async () => {
    installStubs({ framed: false });
    const api = await loadApi();
    const seen: string[] = [];
    const stop = api.onDashboardNavigate((next: string) => void seen.push(next));
    stop();
    expect(seen).toEqual([]);
  });
});

describe("applyTheme", () => {
  it("toggles the dark class and remembers the mode", async () => {
    const harness = installStubs({ framed: true });
    const api = await loadApi();
    api.applyTheme("dark");
    expect(harness.classes.has("dark")).toBe(true);
    expect(harness.stored.get("queek-theme")).toBe("dark");
    api.applyTheme("light");
    expect(harness.classes.has("dark")).toBe(false);
    expect(harness.stored.get("queek-theme")).toBe("light");
  });
});

describe("theme over the bridge", () => {
  it("applies the dashboard theme during the handshake, then calls the API", async () => {
    const harness = installStubs({ framed: true, autoReply: true });
    const fetched: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal("fetch", (async (url: unknown, init?: { headers?: Record<string, string> }) => {
      const href = String(url);
      fetched.push({ url: href, auth: init?.headers?.Authorization ?? null });
      if (href.endsWith("/admin/session")) {
        return new Response(JSON.stringify({ token: "APP", expires_in: 600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ store: { data: { p_id: "s", name: "N" } } }), {
        status: 200,
      });
    }) as typeof fetch);
    const api = await loadApi();
    const data = await api.api<{ store: unknown }>("GET", "/store");
    expect(data).toEqual({ store: { data: { p_id: "s", name: "N" } } });
    expect(harness.classes.has("dark")).toBe(true);
    expect(fetched.map((call) => call.auth)).toEqual(["Bearer DASH", "Bearer APP"]);
  });
});

describe("App nav", () => {
  async function renderApp(framed: boolean): Promise<string> {
    installStubs({ framed });
    vi.resetModules();
    const [{ App }, router, server] = await Promise.all([
      import("../admin-ui/src/App"),
      import("react-router"),
      import("react-dom/server"),
    ]);
    const React = await import("react");
    return server.renderToString(
      React.createElement(router.StaticRouter, { location: "/" }, React.createElement(App)),
    );
  }

  it("hides the local nav when framed, shows it on a direct load", async () => {
    expect(await renderApp(true)).not.toContain("<nav");
    const direct = await renderApp(false);
    expect(direct).toContain("<nav");
    expect(direct).toContain("Home");
  });
});

describe("theme-boot.js", () => {
  const code = () => readFileSync(join(HERE, "..", "admin-ui", "public", "theme-boot.js"), "utf8");

  function runBoot(search: string, stored: string | null): Set<string> {
    const names = new Set<string>();
    const runner = new Function("location", "document", "sessionStorage", code()) as (
      location: unknown,
      document: unknown,
      storage: unknown,
    ) => void;
    runner(
      { search },
      { documentElement: { classList: { add: (name: string) => void names.add(name) } } },
      {
        getItem: () => stored,
        setItem: (_key: string, _value: string) => undefined,
      },
    );
    return names;
  }

  it("paints the launch theme before React loads, else the remembered mode", () => {
    expect(runBoot("?theme=dark", null).has("dark")).toBe(true);
    expect(runBoot("?theme=light", "dark").has("dark")).toBe(false);
    expect(runBoot("", "dark").has("dark")).toBe(true);
    expect(runBoot("?theme=evil", "light").has("dark")).toBe(false);
  });
});
