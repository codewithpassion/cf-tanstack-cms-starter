import { expect, test } from "bun:test";
import { Hono } from "hono";
import { withHandlerCookies } from "./handler-cookies";

/** As `@clerk/hono` after refreshing a session: cookies on the placeholder `c.res`, then next(). */
function appWithRefreshingMiddleware() {
  const app = new Hono();
  app.use(async (c, next) => {
    c.res.headers.append("Set-Cookie", "__session=fresh; Path=/");
    c.res.headers.append("Set-Cookie", "__session_x=fresh; Path=/");
    await next();
  });
  const handlerResponse = () =>
    new Response("page", {
      headers: [["Set-Cookie", "__Host-oauth-consent-ab=ab; Path=/; Secure"]],
    });
  app.get("/plain", handlerResponse);
  app.get("/kept", (c) => withHandlerCookies(c, handlerResponse()));
  return app;
}

test("Hono drops a handler's cookies when middleware set some on c.res", async () => {
  const res = await appWithRefreshingMiddleware().request("/plain");
  expect(res.headers.getSetCookie()).toEqual([
    "__session=fresh; Path=/",
    "__session_x=fresh; Path=/",
  ]);
});

test("withHandlerCookies keeps the handler's cookies and the middleware's", async () => {
  const res = await appWithRefreshingMiddleware().request("/kept");
  expect(res.headers.getSetCookie().sort()).toEqual(
    [
      "__session=fresh; Path=/",
      "__session_x=fresh; Path=/",
      "__Host-oauth-consent-ab=ab; Path=/; Secure",
    ].sort()
  );
  expect(await res.text()).toBe("page");
});

test("withHandlerCookies changes nothing when no middleware set cookies", async () => {
  const app = new Hono();
  app.get("/", (c) =>
    withHandlerCookies(
      c,
      new Response("x", { headers: [["Set-Cookie", "a=1; Path=/"]] })
    )
  );
  const res = await app.request("/");
  expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/"]);
});
