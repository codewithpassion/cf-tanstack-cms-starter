import { createFileRoute, redirect } from "@tanstack/react-router";

/** The admin home is the pages list; its layout (admin._shell.tsx) does the auth check. */
export const Route = createFileRoute("/admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/pages" });
  },
});
