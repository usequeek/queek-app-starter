import { useEffect } from "react";
import { Route, Routes, useLocation, useNavigate } from "react-router";
import { isFramed, isLocalPreview, onDashboardNavigate, reportNavigated } from "@/lib/api";
import { HomePage } from "./pages/Home";

const BASE = "/admin";

export function App() {
  const location = useLocation();
  const navigate = useNavigate();

  // Keep the dashboard's address + sidebar on the page showing here, and move
  // when the dashboard's sidebar menu or back/forward asks.
  useEffect(() => {
    reportNavigated(`${BASE}${location.pathname === "/" ? "" : location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
  useEffect(
    () =>
      onDashboardNavigate((path) => {
        const inApp = path === BASE ? "/" : path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : null;
        if (inApp !== null) navigate(inApp);
      }),
    [navigate],
  );

  return (
    <div className="min-h-dvh bg-background text-foreground antialiased">
      {isLocalPreview ? (
        <div className="border-b border-border bg-muted/60 px-4 py-1.5 text-center text-xs text-muted-foreground">
          Local preview — signed in as your dev store's install. Inside Queek this page sits under the app's
          title bar.
        </div>
      ) : null}
      <div className="mx-auto max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        {isFramed ? null : (
          <nav aria-label="My App" className="mb-6 flex gap-1 border-b border-border">
            <span
              aria-current="page"
              className="-mb-px border-b-2 border-queek-green px-3 py-2 text-sm font-medium"
            >
              Home
            </span>
          </nav>
        )}
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </div>
    </div>
  );
}
