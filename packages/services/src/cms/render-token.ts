/**
 * Signed render tokens (docs/cms-plan.md §3.9 share images, §3.6 previews, §9 H1/H4).
 *
 * A token lets a request without a Clerk session render one page for one purpose until it expires:
 * Browser Run loading `/og-render/<slug>?t=…` for a share image ("og") and shareable draft
 * previews ("preview").
 *
 * Format: `base64url(JSON claims) "." base64url(HMAC-SHA256(secret, first part))`. The signature is
 * checked with `crypto.subtle.verify` (a constant-time comparison) before any claim is read.
 * Pure WebCrypto with the key passed in as `{ signingKey }`, so it runs in Workers and in Node tests
 * alike; the web app reads `PREVIEW_SIGNING_KEY` and passes it.
 */

export const RENDER_PURPOSES = ["og", "preview"] as const;
export type RenderPurpose = (typeof RENDER_PURPOSES)[number];

/**
 * `exp` is in seconds since the epoch. `pageId` binds the token to one page as well as its slug: a
 * "preview" token without one is refused (load-page.ts), so a link still shows only that page's
 * draft after another page takes over the slug. `changesetId` (previews only): show that staged
 * agent proposal of the page instead of its draft, while it is still pending.
 */
export type RenderClaims = {
  slug: string;
  purpose: RenderPurpose;
  exp: number;
  pageId?: string;
  changesetId?: string;
};

/** Long enough for Browser Run to launch, load the page and its fonts, and screenshot it. */
export const OG_TOKEN_TTL_SECONDS = 5 * 60;

/** A draft preview link from the editor's Preview button stays usable for a day. */
export const PREVIEW_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** A preview link an agent asks for (`get_preview_url`) is meant to be opened right away. */
export const AGENT_PREVIEW_TTL_SECONDS = 60 * 60;

/**
 * The longest lifetime a token of each purpose may have. Signing refuses more, and verification
 * rejects a token whose `exp` lies further ahead than this (so a leaked signing key or a bug can't
 * mint long-lived tokens that the gate accepts).
 */
export const MAX_TTL_SECONDS: Record<RenderPurpose, number> = {
  og: 10 * 60,
  preview: 7 * 24 * 60 * 60,
};

/** A hex string from `openssl rand -hex 32` is 64 characters. Shorter secrets are refused. */
const MIN_SECRET_LENGTH = 32;
/** Real tokens are about 150 characters; anything far longer is rejected before any crypto runs. */
const MAX_TOKEN_LENGTH = 1024;

export type VerifyFailure =
  | "missing"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "ttl-too-long"
  | "wrong-purpose"
  | "wrong-slug";
export type VerifyResult =
  | { ok: true; claims: RenderClaims }
  | { ok: false; reason: VerifyFailure };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The signing key, as the web app reads it from its secrets (`PREVIEW_SIGNING_KEY`). */
export type RenderSigner = { signingKey: string | undefined };

export class RenderTokenConfigError extends Error {
  constructor() {
    super(
      `PREVIEW_SIGNING_KEY is missing or shorter than ${MIN_SECRET_LENGTH} characters.`
    );
    this.name = "RenderTokenConfigError";
  }
}

let missingKeyLogged = false;

/**
 * Logs a `RenderTokenConfigError` once per isolate: without a signing key every preview request
 * would log the same line. Other errors are logged every time. `label` says where it happened.
 */
export function logTokenError(label: string, err: unknown): void {
  if (err instanceof RenderTokenConfigError) {
    if (missingKeyLogged) {
      return;
    }
    missingKeyLogged = true;
  }
  console.error(label, err);
}

function hmacKey({ signingKey: secret }: RenderSigner): Promise<CryptoKey> {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new RenderTokenConfigError();
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

const PLUS_RE = /\+/g;
const SLASH_RE = /\//g;
const PADDING_RE = /[=]+$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]*$/;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin)
    .replace(PLUS_RE, "-")
    .replace(SLASH_RE, "_")
    .replace(PADDING_RE, "");
}

function fromBase64Url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_RE.test(s)) {
    return null;
  }
  try {
    const bin = atob(
      s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)
    );
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export async function signRenderToken(
  signer: RenderSigner,
  claims: {
    slug: string;
    purpose: RenderPurpose;
    pageId?: string;
    changesetId?: string;
  },
  opts: { ttlSeconds: number; now?: number }
): Promise<string> {
  const key = await hmacKey(signer);
  if (
    !(opts.ttlSeconds > 0 && opts.ttlSeconds <= MAX_TTL_SECONDS[claims.purpose])
  ) {
    throw new RangeError(
      `A "${claims.purpose}" token lives at most ${MAX_TTL_SECONDS[claims.purpose]} seconds.`
    );
  }
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + opts.ttlSeconds;
  const body: RenderClaims = {
    slug: claims.slug,
    purpose: claims.purpose,
    exp,
    ...(claims.pageId !== undefined && { pageId: claims.pageId }),
    ...(claims.changesetId !== undefined && {
      changesetId: claims.changesetId,
    }),
  };
  const payload = toBase64Url(encoder.encode(JSON.stringify(body)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  );
  return `${payload}.${toBase64Url(sig)}`;
}

/**
 * Checks the signature first, then that the token is for `expected.slug` and `expected.purpose`,
 * hasn't expired and doesn't outlive its purpose's MAX_TTL_SECONDS. Throws `RenderTokenConfigError`
 * (fail closed) when the signing key is unusable.
 *
 * `slug: null` skips only the slug check, for a caller that verifies the token before it knows the
 * slug and must then compare `claims.slug` with the page it loads (agent/server/render-auth.ts).
 */
export async function verifyRenderToken(
  signer: RenderSigner,
  token: string | null | undefined,
  expected: { slug: string | null; purpose: RenderPurpose },
  now: number = Date.now()
): Promise<VerifyResult> {
  const key = await hmacKey(signer);
  if (!token) {
    return { ok: false, reason: "missing" };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  const [payload, sigPart = ""] = parts;
  const sig = fromBase64Url(sigPart);
  if (!(payload && sig) || sig.byteLength !== 32) {
    return { ok: false, reason: "malformed" };
  }
  // One signature, one spelling: base64url's last character carries 2 unused bits, which atob
  // ignores, so 4 strings decode to the same MAC. Only the canonical one is accepted.
  if (toBase64Url(sig) !== sigPart) {
    return { ok: false, reason: "malformed" };
  }

  if (
    !(await crypto.subtle.verify("HMAC", key, sig, encoder.encode(payload)))
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  const claims = parseClaims(payload);
  if (!claims) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.purpose !== expected.purpose) {
    return { ok: false, reason: "wrong-purpose" };
  }
  if (expected.slug !== null && claims.slug !== expected.slug) {
    return { ok: false, reason: "wrong-slug" };
  }
  if (claims.exp * 1000 <= now) {
    return { ok: false, reason: "expired" };
  }
  if (claims.exp * 1000 - now > MAX_TTL_SECONDS[claims.purpose] * 1000) {
    return { ok: false, reason: "ttl-too-long" };
  }
  return { ok: true, claims };
}

function parseClaims(payload: string): RenderClaims | null {
  const bytes = fromBase64Url(payload);
  if (!bytes) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const { slug, purpose, exp, pageId, changesetId } = raw as Record<
    string,
    unknown
  >;
  if (
    typeof slug !== "string" ||
    typeof exp !== "number" ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  if (!(RENDER_PURPOSES as readonly unknown[]).includes(purpose)) {
    return null;
  }
  if (pageId !== undefined && typeof pageId !== "string") {
    return null;
  }
  if (changesetId !== undefined && typeof changesetId !== "string") {
    return null;
  }
  return {
    slug,
    purpose: purpose as RenderPurpose,
    exp,
    ...(pageId !== undefined && { pageId }),
    ...(changesetId !== undefined && { changesetId }),
  };
}
