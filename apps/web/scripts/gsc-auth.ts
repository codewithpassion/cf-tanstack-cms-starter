#!/usr/bin/env bun
// biome-ignore-all lint/suspicious/noConsole: a terminal script; its output is the user interface.
/**
 * One-time Google Search Console sign-in for the CMS: gets the refresh token the daily cron, the
 * SEO tab, /admin/seo and /admin/setup use for the property in the GSC_PROPERTY var (e.g.
 * `sc-domain:example.com`, set in wrangler.jsonc `vars` or in .env.local).
 *
 *   cd apps/web && bun run gsc:auth      (or: bun scripts/gsc-auth.ts)
 *
 * Before you run it:
 * - GSC_CLIENT_ID and GSC_CLIENT_SECRET must be in apps/web/.env.local: a Google OAuth client in a
 *   Google Cloud project with the Google Search Console API enabled.
 * - The OAuth client must accept the redirect `http://localhost:8765`. A "Desktop app" client
 *   accepts any localhost port on its own; a "Web application" client needs exactly
 *   `http://localhost:8765` under "Authorized redirect URIs" (Google Cloud console → APIs &
 *   Services → Credentials).
 * - If the client's OAuth consent screen is still in "Testing", the Google account you sign in with
 *   must be listed as a test user, and Google expires the refresh token after 7 days. Publish the
 *   consent screen ("In production") for a token that lasts.
 * - Sign in with a Google account that is an Owner (or Full user) of the Search Console property.
 *   Read access is enough for the numbers; URL Inspection and "Resubmit sitemap" need Owner or Full.
 *
 * What it does: prints a consent URL (full `webmasters` scope, so the CMS can resubmit the
 * sitemap; PKCE and a state value), takes the localhost URL Google redirects to (caught directly
 * on port 8765, or pasted back here when the browser is on another machine), exchanges the code,
 * checks the account can see the property, and writes GSC_REFRESH_TOKEN to apps/web/.env.local.
 * The token is never printed.
 *
 * Deployed Worker: set the same value as a secret, e.g.
 *   bunx wrangler secret put GSC_REFRESH_TOKEN
 * (and GSC_CLIENT_ID / GSC_CLIENT_SECRET if they aren't set there yet).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { getPlatformProxy } from "wrangler";

const ENV_FILE = join(import.meta.dir, "../.env.local");
// Full (not .readonly) scope: the CMS resubmits the sitemap.
const SCOPE = "https://www.googleapis.com/auth/webmasters";
const PORT = 8765;
/** How long to wait for the sign-in before giving up. */
const TIMEOUT_MS = 10 * 60_000;
const REDIRECT_URI = `http://localhost:${PORT}`;

const ENV_LINE_RE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/;
const QUOTES_RE = /^["']|["']$/g;

function readEnv(): Map<string, string> {
  const vars = new Map<string, string>();
  if (!existsSync(ENV_FILE)) {
    return vars;
  }
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = ENV_LINE_RE.exec(line);
    if (match?.[1] && match[2] !== undefined) {
      vars.set(match[1], match[2].replace(QUOTES_RE, ""));
    }
  }
  return vars;
}

function writeEnvVar(name: string, value: string) {
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  let next: string;
  if (pattern.test(text)) {
    next = text.replace(pattern, line);
  } else {
    const separator = text === "" || text.endsWith("\n") ? "" : "\n";
    next = `${text}${separator}${line}\n`;
  }
  writeFileSync(ENV_FILE, next);
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** GSC_PROPERTY as the Worker sees it: wrangler.jsonc `vars`, overridden by .env.local. */
async function readProperty(): Promise<string> {
  const { env: worker, dispose } = await getPlatformProxy<Env>({
    configPath: join(import.meta.dir, "../wrangler.jsonc"),
    persist: false,
    remoteBindings: false,
  });
  try {
    return String(worker.GSC_PROPERTY ?? "").trim();
  } finally {
    await dispose();
  }
}

const env = readEnv();
const clientId = env.get("GSC_CLIENT_ID");
const clientSecret = env.get("GSC_CLIENT_SECRET");
if (!(clientId && clientSecret)) {
  fail(`Add GSC_CLIENT_ID and GSC_CLIENT_SECRET to ${ENV_FILE} first.`);
}
const SITE = await readProperty();
if (!SITE) {
  fail(
    "Set GSC_PROPERTY first (e.g. sc-domain:example.com or https://example.com/), in wrangler.jsonc vars or in .env.local."
  );
}

// PKCE + state, so a pasted URL from another sign-in can't be used by mistake.
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64url(
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  )
);
const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  access_type: "offline",
  client_id: clientId,
  code_challenge: challenge,
  code_challenge_method: "S256",
  prompt: "consent",
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPE,
  state,
}).toString();

// Two ways back: Google redirects to localhost:8765, which reaches this script directly when the
// browser is on this machine or the port is forwarded (VS Code remote does this). Otherwise the
// browser shows an error page and you paste its address. The listener is on 127.0.0.1 only, and a
// request without this run's `state` gets a 400 and is otherwise ignored, so nothing else on the
// machine or network can end the sign-in.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const server = createServer();
const fromRedirect = new Promise<string>((resolve) => {
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", REDIRECT_URI);
    if (!(url.searchParams.has("code") || url.searchParams.has("error"))) {
      res.end("Waiting for Google…");
      return;
    }
    if (url.searchParams.get("state") !== state) {
      res.statusCode = 400;
      res.end(
        "This sign-in link is from another run. Use the link printed in the terminal."
      );
      return;
    }
    res.end("Signed in. You can close this tab and go back to the terminal.");
    resolve(url.toString());
  });
  // Port busy: fall back to pasting.
  server.on("error", () => undefined);
  server.listen(PORT, "127.0.0.1");
});
let timer: ReturnType<typeof setTimeout> | undefined;
const timedOut = new Promise<null>((resolve) => {
  timer = setTimeout(() => resolve(null), TIMEOUT_MS);
});

console.log(
  `\n1. Open this link in any browser and sign in with a Google account that owns ${SITE}:\n`
);
console.log(authUrl.toString());
console.log(
  '\n2. Click Allow. If the page then says "Signed in", you\'re done here.'
);
console.log(
  "   If it shows an error page instead, copy the whole address from the address bar."
);
const fromPaste = rl
  .question("3. (Only if needed) paste the address here: ")
  .then((s) => s.trim());
const pasted = await Promise.race([fromRedirect, fromPaste, timedOut]);
clearTimeout(timer);
rl.close();
server.close();
process.stdin.pause();
console.log("");
if (pasted === null) {
  fail(
    `No sign-in after ${TIMEOUT_MS / 60_000} minutes. Run the script again when you're ready.`
  );
}

let redirected: URL;
try {
  redirected = new URL(pasted);
} catch {
  fail("That isn't a URL. Run the script again and paste the whole address.");
}
const googleError = redirected.searchParams.get("error");
if (googleError) {
  fail(`Google returned an error: ${googleError}`);
}
if (redirected.searchParams.get("state") !== state) {
  fail(
    "That address is from a different sign-in. Run the script again and use the new link."
  );
}
const code = redirected.searchParams.get("code");
if (!code) {
  fail("No code in that address. Run the script again.");
}

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  }),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  method: "POST",
});
const tokens = (await tokenRes.json()) as {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};
if (!(tokenRes.ok && tokens.access_token)) {
  fail(
    `Token exchange failed: ${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ""}`
  );
}
if (!tokens.refresh_token) {
  fail(
    "Google didn't return a refresh token. Remove the app's access at https://myaccount.google.com/permissions and run the script again."
  );
}

// Prove the token works against the real property before saving it.
const sitesRes = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
  headers: { Authorization: `Bearer ${tokens.access_token}` },
});
const sites = (await sitesRes.json()) as {
  siteEntry?: { siteUrl: string; permissionLevel: string }[];
};
const entry = sites.siteEntry?.find((s) => s.siteUrl === SITE);
if (!entry) {
  fail(
    `Signed in, but this account can't see ${SITE}. Sign in with an account that owns the property (or add this one as an Owner or Full user in Search Console → Settings → Users and permissions).`
  );
}

writeEnvVar("GSC_REFRESH_TOKEN", tokens.refresh_token);
console.log(
  `\nDone. ${SITE} is visible (${entry.permissionLevel}). GSC_REFRESH_TOKEN saved to ${ENV_FILE}.`
);
console.log(
  "Restart the dev server to pick it up. For the deployed Worker: bunx wrangler secret put GSC_REFRESH_TOKEN"
);
