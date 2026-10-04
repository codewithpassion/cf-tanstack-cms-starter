import { TanStackDevtools } from "@tanstack/react-devtools";
import {
  createRootRoute,
  HeadContent,
  Outlet,
  Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TooltipProvider } from "#/components/ui/tooltip";
import { getTrpc } from "#/integrations/trpc/client";
import {
  SiteConfigProvider,
  SiteContext,
} from "#/modules/cms/site/site-context";
import ThemedToaster from "../components/themed-toaster";

import ClerkProvider from "../integrations/clerk/provider";

import appCss from "../styles.css?url";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

export const Route = createRootRoute({
  head: ({ loaderData }) => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      // Pages set their own; this is the fallback (the SiteConfig name).
      { title: loaderData?.config.name ?? "" },
    ],
    links: [
      // data-cms-canvas: the editor canvas (modules/cms/editor/mirror-styles.ts) mirrors only these.
      {
        rel: "stylesheet",
        href: appCss,
        "data-cms-canvas": "",
      },
    ],
  }),
  /**
   * The published site doc (nav, footer, SEO defaults), one KV read per request, or null for the
   * defaults (nothing published, KV down), and the deployment's SiteConfig. Route `head`s read both
   * from this loader's data (site-context.ts `siteSeoFromMatches`, `siteConfigFromMatches`).
   * A failed call is not swallowed: the defaults need the SiteConfig this call returns.
   */
  loader: () => getTrpc().cms.public.getRootSite.query(),
  shellComponent: RootDocument,
  component: RootComponent,
});

/**
 * Provides the site doc and SiteConfig (modules/cms/site/site-context.ts) to every route. No site
 * chrome here: CMS pages and the blog render Navigation and Footer themselves, and the admin,
 * og-render and auth routes have none.
 */
function RootComponent() {
  const { site, config } = Route.useLoaderData();
  return (
    <SiteConfigProvider value={config}>
      <SiteContext.Provider value={site}>
        <Outlet />
      </SiteContext.Provider>
    </SiteConfigProvider>
  );
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html className="light" lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static theme-init script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="font-sans antialiased [overflow-wrap:anywhere] selection:bg-primary/30">
        <ClerkProvider>
          <TooltipProvider>
            {children}
            <ThemedToaster />
            <TanStackDevtools
              config={{
                // Bottom-left and fixed: bottom-right covers the editor's AI tab Send and Stop buttons.
                position: "bottom-left",
                triggerMode: "fixed",
              }}
              plugins={[
                {
                  name: "Tanstack Router",
                  render: <TanStackRouterDevtoolsPanel />,
                },
              ]}
            />
          </TooltipProvider>
        </ClerkProvider>
        <Scripts />
      </body>
    </html>
  );
}
