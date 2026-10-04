import { SignOutButton, UserButton } from "@clerk/tanstack-react-start";
import {
  createFileRoute,
  type ErrorComponentProps,
  Link,
  Outlet,
} from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  FileText,
  ImageIcon,
  KeyRound,
  Menu,
  Newspaper,
  PanelsTopLeft,
  Search,
  Wrench,
} from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet";
import { redirectOnUnauthorized } from "#/integrations/trpc/auth-redirect";
import { getTrpc } from "#/integrations/trpc/client";

/**
 * Pathless layout for the signed-in admin pages: sidebar + content (below `md`, a top bar whose menu
 * button opens the same navigation in a sheet). The sign-in route sits outside
 * it, so it stays reachable when signed out. The guard is in `beforeLoad` so it runs before any
 * child loader (loaders run in parallel); every admin procedure checks again on its own. A
 * signed-out visitor is sent to sign in; a signed-in non-admin (FORBIDDEN) sees `AdminError`.
 */
export const Route = createFileRoute("/admin/_shell")({
  beforeLoad: async ({ location }) => {
    await redirectOnUnauthorized(
      getTrpc().cms.pages.requireAdmin.query(),
      location.href
    );
  },
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: AdminShell,
  errorComponent: AdminError,
});

/** True for a tRPC FORBIDDEN: signed in, but not on the ADMIN_EMAILS allowlist. */
const isForbidden = (error: unknown): boolean => {
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? (error.data as { code?: unknown } | null | undefined)
      : undefined;
  return data?.code === "FORBIDDEN";
};

/**
 * What a signed-in user who isn't on ADMIN_EMAILS (or an admin when the admin area can't load)
 * sees, instead of the router's default error screen.
 */
function AdminError({ error }: ErrorComponentProps) {
  const forbidden = isForbidden(error);
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 font-sans text-neutral-100">
      <div className="w-full max-w-md rounded border border-neutral-800 bg-neutral-900 p-8">
        <h1 className="mb-4 font-bold font-heading text-2xl">
          {forbidden ? "No admin access" : "Admin unavailable"}
        </h1>
        <p className="mb-6 text-neutral-300 text-sm" data-testid="admin-error">
          {forbidden
            ? "This account is not allowed to use the admin area. Sign in with an admin account, or ask an admin to add your email address."
            : "The admin area could not be loaded."}
        </p>
        <div className="flex flex-wrap gap-3">
          <SignOutButton redirectUrl="/login">
            <Button type="button">Sign in as someone else</Button>
          </SignOutButton>
          <Button asChild variant="ghost">
            <a href="/">Back to site</a>
          </Button>
        </div>
      </div>
    </main>
  );
}

const navItem =
  "flex items-center gap-2 rounded px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-white";

/** The admin navigation: the desktop sidebar and the mobile sheet both render it. */
function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <div className="mb-6 px-3 pt-2">
        <div className="text-[10px] text-accent uppercase tracking-widest">
          Admin
        </div>
        <div className="font-bold font-heading text-lg text-primary">CMS</div>
      </div>
      <nav className="flex flex-col gap-1">
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          onClick={onNavigate}
          to="/admin/pages"
        >
          <FileText className="h-4 w-4" /> Pages
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-posts"
          onClick={onNavigate}
          to="/admin/posts"
        >
          <Newspaper className="h-4 w-4" /> Posts
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-media"
          onClick={onNavigate}
          to="/admin/media"
        >
          <ImageIcon className="h-4 w-4" /> Media
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-seo"
          onClick={onNavigate}
          to="/admin/seo"
        >
          <Search className="h-4 w-4" /> SEO
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-agent"
          onClick={onNavigate}
          to="/admin/agent"
        >
          <Bot className="h-4 w-4" /> Agent runs
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-site"
          onClick={onNavigate}
          to="/admin/site"
        >
          <PanelsTopLeft className="h-4 w-4" /> Site
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-setup"
          onClick={onNavigate}
          to="/admin/setup"
        >
          <Wrench className="h-4 w-4" /> Setup
        </Link>
        <Link
          activeProps={{ className: "bg-neutral-800 text-white" }}
          className={navItem}
          data-testid="nav-api-keys"
          onClick={onNavigate}
          to="/admin/api-keys"
        >
          <KeyRound className="h-4 w-4" /> API keys
        </Link>
      </nav>
      <div className="mt-auto flex flex-col gap-3 border-neutral-800 border-t pt-3">
        <a className={navItem} href="/">
          <ArrowLeft className="h-4 w-4" /> Back to site
        </a>
        <div className="px-3">
          <UserButton />
        </div>
      </div>
    </>
  );
}

function AdminShell() {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  return (
    <div className="flex min-h-screen flex-col bg-neutral-950 font-sans text-neutral-100 md:flex-row">
      {/* Below md: a top bar; the navigation opens in a sheet. */}
      <header className="sticky top-0 z-40 flex items-center gap-3 border-neutral-800 border-b bg-neutral-900 px-3 py-2 md:hidden">
        <Sheet onOpenChange={setMenuOpen} open={menuOpen}>
          <SheetTrigger asChild>
            <Button
              aria-label="Open admin menu"
              data-testid="admin-menu-button"
              size="icon"
              variant="ghost"
            >
              <Menu className="h-5 w-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            className="gap-0 border-neutral-800 bg-neutral-900 p-3 text-neutral-100 data-[side=left]:w-64"
            data-testid="admin-menu"
            side="left"
          >
            <SheetTitle className="sr-only">Admin menu</SheetTitle>
            <AdminNav onNavigate={closeMenu} />
          </SheetContent>
        </Sheet>
        <span className="text-[10px] text-accent uppercase tracking-widest">
          Admin
        </span>
      </header>
      <aside className="hidden w-56 shrink-0 flex-col border-neutral-800 border-r bg-neutral-900 p-3 md:flex">
        <AdminNav />
      </aside>
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
