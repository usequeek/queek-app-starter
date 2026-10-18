import { useEffect, useState } from "react";
import { NavLink, Outlet, useLoaderData, useLocation, useNavigate } from "react-router";
import {
  configureBridge,
  getIsFramed,
  onDashboardNavigate,
  reportNavigated,
  startAutoHeight,
} from "../bridge.client.js";
import { getRuntime } from "../queek.server.js";

/**
 * The embedded admin shell: dashboard origins + dev-preview flag for the
 * bridge, app nav for direct loads (inside the dashboard its sidebar carries
 * the menu), then the page. No data is served here; each page exchanges its
 * session client-side.
 */
export async function loader() {
  const runtime = getRuntime();
  return {
    origins: runtime.config.dashboardOrigins,
    devPreview: process.env.NODE_ENV === "development",
  };
}

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-1.5 text-sm font-medium ${
    isActive ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
  }`;

export default function Admin() {
  const { origins, devPreview } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  // `bridge.client` is empty during server rendering, so whether the page is
  // framed is read after mount, never while rendering.
  const [framed, setFramed] = useState(true);
  // A child page calls the API from its own effects, and React runs those
  // BEFORE this shell's effects. The pages mount only once the bridge is
  // configured, or their first call would fail.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    configureBridge({ origins, devPreview });
    setFramed(getIsFramed());
    setReady(true);
    startAutoHeight();
    // The in-page header below serves standalone and direct loads; this shell
    // does not set the dashboard title bar.
    return onDashboardNavigate((path) => {
      // Granted-prefix half: only /admin or under /admin/ enters the router.
      if (path === "/admin" || path.startsWith("/admin/")) navigate(path);
    });
  }, [origins, devPreview, navigate]);

  useEffect(() => {
    // Path and query: a reload or a shared link must land on the same view.
    reportNavigated(location.pathname + location.search);
  }, [location.pathname, location.search]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <nav className="mx-auto flex max-w-3xl items-center gap-1 px-4 py-3" aria-label="App">
          <span className="mr-3 text-sm font-semibold">My App</span>
          <NavLink to="/admin" end className={linkClass}>
            Home
          </NavLink>
          <NavLink to="/admin/settings" className={linkClass}>
            Settings
          </NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {!framed && devPreview ? (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            Local preview: signed in as the dev install.
          </p>
        ) : null}
        {ready ? <Outlet /> : null}
      </main>
    </div>
  );
}
