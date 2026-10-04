import {
  AuthorizationError,
  type AuthRequest,
  CimdFetchError,
  type ConsentDescription,
} from "@cloudflare/workers-oauth-provider";
import {
  type ConnectionProps,
  connectionName,
  type createConnectionsService,
} from "@repo/services/mcp/connections";
import {
  API_SCOPES,
  type ApiScope,
  isApiScope,
  SCOPE_HELP,
  toOAuthScope,
} from "@repo/services/mcp/scopes";
import { nanoid } from "nanoid";

import type { AdminCheck } from "../cms/admin";
import { authorizationServerFor } from "./oauth";

/**
 * `/oauth/authorize` (src/routes/oauth.authorize.tsx): the
 * sign-in and consent page for MCP clients.
 *
 * GET: the library validates the request (client, redirect URI, PKCE, resource; a CIMD client's
 * metadata document is fetched here). Without a Clerk session the browser goes to /login and
 * comes back to this URL; a signed-in user who isn't on ADMIN_EMAILS gets a 403 page. Then the
 * consent page (the library's consent helpers: the form carries a single-use handle bound to this
 * browser by a `__Host-` cookie, and the page can't be framed).
 * POST: the admin check first, then the form. Deny → `access_denied` back to the client.
 * Approve → a grant with the chosen scope, a D1 connection row, and the redirect with the code.
 * A POST whose Clerk session token expired while the page was open (it lives 60 s, and Clerk only
 * refreshes it on a GET) goes back to the GET, which refreshes it, to be approved again; nothing is
 * read or granted on that POST.
 */

export type AuthorizeDeps = {
  env: Env;
  /** `cmsServices(env).connections`: records the approved grant. */
  connections: Pick<ReturnType<typeof createConnectionsService>, "create">;
  /** The site's name (`SITE_NAME`), in the page title and the consent question. */
  siteName: string;
  /** `checkAdmin` from src/server/cms/admin.ts (reads the Clerk session). */
  check: () => Promise<AdminCheck>;
  now?: () => number;
  genId?: () => string;
};

const DEFAULT_SCOPE: ApiScope = "write";
const NO_STORE = { "Cache-Control": "no-store" };
/** Added to the consent URL after a POST came back for a fresh session: the page says why. */
export const REAPPROVE_PARAM = "reapprove";
export const REAPPROVE_NOTICE =
  "Your session was refreshed. Please approve again.";
/** Clerk's `__client_uat` cookie (suffixed per instance in development). */
const CLIENT_UAT_COOKIE = /^__client_uat(?:_[\w-]+)?$/;

/**
 * Whether the browser's Clerk client is signed in: a `__client_uat` cookie with a time after 0.
 * Only decides between "refresh and approve again" and "session ended"; it grants nothing (the
 * GET that follows checks the session again).
 */
export function browserSignedIn(request: Request): boolean {
  const cookies = request.headers.get("Cookie") ?? "";
  return cookies.split(";").some((part) => {
    const [name = "", value = ""] = part.trim().split("=");
    return CLIENT_UAT_COOKIE.test(name) && Number(value) > 0;
  });
}

/**
 * Back to the consent GET for the same request, which refreshes the session (Clerk's server-side
 * refresh, or its handshake redirect) and asks to approve again. A meta refresh, not a 303: the
 * consent page's `form-action` also governs redirects that follow its form post, and Clerk's
 * handshake is on another origin. A meta refresh starts a new navigation, outside that rule.
 */
function backToConsent(request: Request, siteName: string): Response {
  const url = new URL(request.url);
  url.searchParams.set(REAPPROVE_PARAM, "1");
  const target = escapeHtml(url.pathname + url.search);
  const body = `<p class="kicker">&gt; MCP sign-in</p><h1>Refreshing your session</h1><p>One moment. If nothing happens, <a href="${target}">continue</a>.</p>`;
  const html = shell(siteName, "Refreshing your session", body).replace(
    "<title>",
    `<meta http-equiv="refresh" content="0;url=${target}"><title>`
  );
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      ...NO_STORE,
    },
  });
}

export async function handleAuthorize(
  request: Request,
  deps: AuthorizeDeps
): Promise<Response> {
  const server = authorizationServerFor(new URL(request.url).origin);
  if (!server) {
    return page(
      deps.siteName,
      404,
      "Not available here",
      "MCP sign-in needs https (or localhost in development)."
    );
  }
  const oauth = server.getOAuthApi(deps.env);
  try {
    if (request.method === "GET") {
      return await showConsent(request, oauth, deps);
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    }
    return await decide(request, oauth, deps);
  } catch (err) {
    if (err instanceof AuthorizationError && err.redirectTo) {
      return new Response(null, {
        status: 302,
        headers: { Location: err.redirectTo },
      });
    }
    if (err instanceof AuthorizationError) {
      return page(
        deps.siteName,
        400,
        "Can't connect",
        err.description ||
          "This sign-in link is invalid, expired or was already used. Start connecting again from your app."
      );
    }
    if (err instanceof CimdFetchError) {
      console.warn(
        JSON.stringify({
          oauth: "cimd_fetch_failed",
          reason: err.reason,
          url: err.metadataUrl,
        })
      );
      return page(
        deps.siteName,
        400,
        "Can't connect",
        "This app's identity could not be verified (its client metadata document didn't load)."
      );
    }
    throw err;
  }
}

type OAuthApi = ReturnType<
  NonNullable<ReturnType<typeof authorizationServerFor>>["getOAuthApi"]
>;

/**
 * PKCE (S256) for every client. The library only requires it of public clients
 * (`token_endpoint_auth_method: "none"`); a confidential DCR client could otherwise run the code
 * flow without it. The request's redirect URI is validated by now, so the error goes back to the
 * client as an OAuth redirect (`invalid_request`).
 */
function requirePkce(authRequest: AuthRequest): void {
  if (authRequest.codeChallenge && authRequest.codeChallengeMethod === "S256") {
    return;
  }
  throw new AuthorizationError("invalid_request", {
    description: "PKCE (S256) is required",
    redirectUri: authRequest.redirectUri,
    state: authRequest.state || undefined,
    issuer: authRequest.issuer,
  });
}

async function showConsent(
  request: Request,
  oauth: OAuthApi,
  deps: AuthorizeDeps
): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  requirePkce(authRequest);
  const admin = await deps.check();
  if (!admin.ok && admin.status === 401) {
    // /login only takes a same-site path back (src/lib/sign-in-target.ts).
    const { pathname, search } = new URL(request.url);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/login?redirect_url=${encodeURIComponent(pathname + search)}`,
        ...NO_STORE,
      },
    });
  }
  if (!admin.ok) {
    return page(deps.siteName, admin.status, "No access", admin.message);
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set(
    "Content-Security-Policy",
    consentCsp(details.redirectUri)
  );
  const reapprove = new URL(request.url).searchParams.has(REAPPROVE_PARAM);
  return new Response(
    consentPage(
      details,
      consent.handle,
      admin.email,
      deps.siteName,
      reapprove ? REAPPROVE_NOTICE : undefined
    ),
    { headers: consent.headers }
  );
}

async function decide(
  request: Request,
  oauth: OAuthApi,
  deps: AuthorizeDeps
): Promise<Response> {
  const admin = await deps.check();
  if (!admin.ok && admin.status === 401 && browserSignedIn(request)) {
    // Signed in, but the session token expired while the page was open: Clerk refreshes it only on
    // a GET. Nothing is read or granted here.
    return backToConsent(request, deps.siteName);
  }
  if (!admin.ok) {
    return page(
      deps.siteName,
      admin.status,
      "No access",
      admin.status === 401
        ? "Your admin session ended. Start connecting again from your app."
        : admin.message
    );
  }
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const scope = form.get("scope");
  if (!isApiScope(scope)) {
    return page(
      deps.siteName,
      400,
      "Pick a scope",
      "Choose read, write or full access."
    );
  }
  const approved = await oauth.approveConsent(request, handle, {
    scope: [toOAuthScope(scope)],
  });
  // The GET refused such a request before a handle existed; checked again before the code is issued.
  requirePkce(approved.request);
  const details = await oauth.describeConsent(approved.request);
  const now = deps.now?.() ?? Date.now();
  const connectionId = deps.genId?.() ?? nanoid();
  const name = connectionName(
    details.clientName,
    approved.request.clientId,
    now
  );
  const props: ConnectionProps = {
    userId: admin.userId,
    email: admin.email,
    scope,
    connectionId,
    name,
  };
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: admin.userId,
    metadata: { connectionId },
    scope: approved.request.scope,
    props,
  });
  await deps.connections.create({
    id: connectionId,
    userId: admin.userId,
    email: admin.email,
    clientId: approved.request.clientId,
    clientName: details.clientName,
    redirectUri: approved.request.redirectUri,
    scope,
    now,
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

const SPECIAL_CHARS = /[&<>"']/g;
const escapeHtml = (value: string) =>
  value.replace(SPECIAL_CHARS, (char) => `&#${char.charCodeAt(0)};`);

/**
 * The page's own policy: the redirect to the client that follows the form post must be allowed
 * by `form-action` (Chromium applies it to that redirect), so the client's redirect origin is
 * allowed too, and nothing else is.
 */
export function consentCsp(redirectUri: string): string {
  let target = "";
  try {
    const { origin } = new URL(redirectUri);
    if (origin !== "null") {
      target = ` ${origin}`;
    }
  } catch {
    // Not a URL the library would have accepted; leave only 'self'.
  }
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'${target}; frame-ancestors 'none'; base-uri 'none'`;
}

/** The admin's dark palette: near black, an accent, a primary and a danger colour. */
const STYLE = `
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e5e5e5;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{width:100%;max-width:520px;background:#171717;border:1px solid #262626;border-radius:8px;padding:24px}
.kicker{color:#00d4ff;font-size:12px;letter-spacing:.15em;text-transform:uppercase;margin:0 0 6px}
h1{color:#ff7733;font-size:22px;margin:0 0 16px}
p{margin:0 0 12px}.muted{color:#a3a3a3;font-size:13px}
strong{color:#fff}
.note{border:1px solid #00d4ff;color:#cffafe;border-radius:6px;padding:8px 10px;font-size:13px}
.warn{border:1px solid #ff3859;color:#fecdd3;border-radius:6px;padding:8px 10px;font-size:13px}
fieldset{border:1px solid #262626;border-radius:6px;padding:8px 12px;margin:16px 0}
legend{color:#a3a3a3;font-size:13px;padding:0 4px}
label{display:block;padding:6px 0;cursor:pointer}label span{display:block;color:#a3a3a3;font-size:13px;margin-left:24px}
.actions{display:flex;gap:12px;margin-top:16px}
button{font:inherit;border-radius:6px;padding:8px 18px;cursor:pointer;border:1px solid #404040;background:#0a0a0a;color:#e5e5e5}
button.primary{background:#ff7733;border-color:#ff7733;color:#111;font-weight:600}
`;

function shell(siteName: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} | ${escapeHtml(siteName)} Admin</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function page(
  siteName: string,
  status: number,
  title: string,
  message: string
): Response {
  const body = `<p class="kicker">&gt; MCP sign-in</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`;
  return new Response(shell(siteName, title, body), {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}

export function consentPage(
  details: ConsentDescription,
  handle: string,
  email: string,
  siteName: string,
  notice?: string
): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `<p>Published by <strong>${escapeHtml(details.clientDomain)}</strong>.</p>`
    : `<p class="muted">This app registered itself, so its name isn't verified.</p>`;
  const loopback = details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>`
    : "";
  const scopes = API_SCOPES.map(
    (s) =>
      `<label><input type="radio" name="scope" value="${s}"${s === DEFAULT_SCOPE ? " checked" : ""}> <strong>${s}</strong><span>${escapeHtml(SCOPE_HELP[s])}</span></label>`
  ).join("");
  const note = notice ? `<p class="note">${escapeHtml(notice)}</p>` : "";
  const body = `<p class="kicker">&gt; MCP sign-in</p>
${note}
<h1>Connect ${name} to the ${escapeHtml(siteName)} CMS?</h1>
${origin}
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<fieldset><legend>Access</legend>${scopes}</fieldset>
<p class="muted">Signed in as ${escapeHtml(email)}. Changes it makes are recorded as MCP changes. Revoke it any time in /admin/api-keys.</p>
<div class="actions"><button class="primary" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form>`;
  return shell(siteName, `Connect ${details.clientName}`, body);
}
