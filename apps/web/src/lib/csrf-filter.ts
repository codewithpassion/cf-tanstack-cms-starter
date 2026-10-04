/**
 * Which requests TanStack Start's CSRF middleware checks (src/start.ts): every state-changing
 * request under /admin (e.g. POST /admin/api/media). A checked request passes when
 * `Sec-Fetch-Site` is `same-origin`, or, without that header, when `Origin` (then `Referer`)
 * matches the request's origin.
 *
 * tRPC mutations are not covered here: they go through Hono's `csrf()` on `/api/trpc/*`
 * (src/server.ts), which runs before this middleware could.
 */
export const isAdminPath = (pathname: string) =>
  pathname === "/admin" || pathname.startsWith("/admin/");

export function needsCsrfCheck({
  request,
  pathname,
}: {
  request: Request;
  pathname: string;
}): boolean {
  return (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    isAdminPath(pathname)
  );
}
