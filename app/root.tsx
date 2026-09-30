import type { LoaderFunctionArgs } from "react-router";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useLoaderData } from "react-router";
import "./app.css";

/**
 * The document shell (Shopify's `app/root.tsx` equivalent). The dashboard
 * adds `?theme=light|dark` to the frame URL (its resolved theme), so the
 * first paint already carries `<html class="dark">` — no light flash on a
 * cold dark load. Live switches arrive over the bridge (`theme{mode}`) and
 * toggle the class client-side (see bridge.client.ts). A stored mode covers
 * direct loads without the param via the pre-paint inline script below.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const theme = new URL(request.url).searchParams.get("theme");
  return { theme: theme === "dark" ? "dark" : "light" };
}

export default function App() {
  const { theme } = useLoaderData<typeof loader>();
  return (
    <html lang="en" className={theme === "dark" ? "dark" : undefined} style={{ colorScheme: theme }}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <script
          // Pre-paint: ?theme= wins, else the last mode this tab saw (the
          // server already rendered ?theme=dark; this covers direct loads).
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static inline theme boot, no interpolation.
          dangerouslySetInnerHTML={{
            __html: `(function(){var m=null;try{m=new URLSearchParams(location.search).get("theme")}catch(e){}if(m!=="dark"&&m!=="light"){try{m=sessionStorage.getItem("queek-theme")}catch(e){}}if(m==="dark")document.documentElement.classList.add("dark");try{if(m==="dark"||m==="light")sessionStorage.setItem("queek-theme",m)}catch(e){}})();`,
          }}
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
