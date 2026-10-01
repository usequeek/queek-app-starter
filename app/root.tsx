import { getThemeModeFromUrl, themeBootstrapScript } from "@usequeek/app-sdk/browser";
import type { LoaderFunctionArgs } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import "./app.css";

/**
 * The document shell (Shopify's `app/root.tsx` equivalent). `theme` is a
 * plain unsigned URL param (`?theme=light|dark`, the dashboard's resolved
 * theme), so the first paint already carries `<html class="dark">` — no
 * light flash on a cold dark load. Live switches arrive over the bridge
 * (`theme{mode}`) and override it client-side (see bridge.client.ts). A
 * stored mode covers direct loads without the param via the SDK pre-paint
 * inline script below.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  return { theme: getThemeModeFromUrl(request.url) };
}

export default function App() {
  const { theme } = useLoaderData<typeof loader>();
  return (
    <html lang="en" className={theme === "dark" ? "dark" : undefined} style={{ colorScheme: theme }}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <script
          // Pre-paint SDK bootstrap: ?theme= wins, else the last mode this
          // tab saw (the server already rendered ?theme=dark; this covers
          // direct loads).
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline theme boot, no interpolation.
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }}
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
