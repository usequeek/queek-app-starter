import { useEffect } from "react";
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
 * The embedded admin shell (Shopify's `app/routes/app.tsx` equivalent):
 * dashboard origins + dev-preview flag for the bridge, app nav for direct
 * loads (inside the dashboard its sidebar carries the menu), then the page.
 * No data is served here; each page exchanges its session client-side.
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

  useEffect(() => {
    configureBridge({ origins, devPreview });
    startAutoHeight();
    // TODO(SDK bridge v1): mirror title/actions to the dashboard title bar
    // (`queek.setTitle(...)`) once `./react` ships; the in-page header below
    // still serves standalone / direct loads.
    return onDashboardNavigate((path) => {
      // Granted-prefix half: only /admin or under /admin/ enters the router.
      if (path === "/admin" || path.startsWith("/admin/")) navigate(path);
    });
  }, [origins, devPreview, navigate]);

  useEffect(() => {
    reportNavigated(location.pathname);
  }, [location.pathname]);

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
        {!getIsFramed() && devPreview ? (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            Local preview: signed in as the dev install.
          </p>
        ) : null}
        <Outlet />
      </main>
    </div>
  );
}
