// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim; retry counters as in the source.
// biome-ignore-all lint/style/useErrorCause: a failed fetch is reduced to its message on purpose, so nothing from the request (tokens) travels with the error.
// biome-ignore-all lint/performance/noAwaitInLoops: retries and result pages are sequential by design (each depends on the previous response).
import { type Clock, systemClock } from "../clock";

/**
 * Google Search Console API client: a user OAuth refresh token (full `webmasters` scope, for the
 * sitemap resubmit) exchanged for access tokens, which are cached per isolate for up to 50
 * minutes; requests that hit a 429 or 5xx are retried with backoff. Runs in the Worker (cron,
 * admin calls) and in Bun scripts; it takes `fetch`, the credentials and the property
 * (`SiteConfig.gscProperty`) as arguments and never reads env.
 *
 * Tokens never appear in errors or logs: messages carry only Google's error codes and text.
 */

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://searchconsole.googleapis.com";
/** The API's maximum page size. */
export const GSC_ROW_LIMIT = 25_000;
const TOKEN_TTL_MS = 50 * 60_000;

export type GscCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * The three secrets, as the caller read them (a Worker's env, a script's .env.local); null when any
 * is missing or empty.
 */
export function gscCredentials(secrets: {
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REFRESH_TOKEN?: string;
}): GscCredentials | null {
  const {
    GSC_CLIENT_ID: clientId,
    GSC_CLIENT_SECRET: clientSecret,
    GSC_REFRESH_TOKEN: refreshToken,
  } = secrets;
  return clientId && clientSecret && refreshToken
    ? { clientId, clientSecret, refreshToken }
    : null;
}

/**
 * - `AUTH`: the refresh token was rejected (revoked, expired, wrong client): sign in again with
 *   `bun run gsc:auth`.
 * - `FORBIDDEN`: the account can't read the property, or the API isn't enabled.
 * - `RATE_LIMITED`: quota (URL Inspection allows 2,000 a day per property).
 * - `BAD_REQUEST`: a malformed query (a bug here).
 * - `UPSTREAM`: Google returned 5xx or something unreadable; `NETWORK`: fetch itself failed.
 */
export type GscErrorCode =
  | "AUTH"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "BAD_REQUEST"
  | "UPSTREAM"
  | "NETWORK";

export class GscError extends Error {
  readonly code: GscErrorCode;
  readonly status?: number;

  constructor(code: GscErrorCode, message: string, status?: number) {
    super(message);
    this.name = "GscError";
    this.code = code;
    this.status = status;
  }
}

export type SearchDimension =
  | "date"
  | "page"
  | "query"
  | "device"
  | "country"
  | "searchAppearance";

export type SearchAnalyticsRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type SearchAnalyticsQuery = {
  /** YYYY-MM-DD, inclusive (Pacific time, as in the GSC UI). */
  startDate: string;
  endDate: string;
  dimensions: SearchDimension[];
  /** Rows per request; pages through with `startRow` until a short page. */
  rowLimit?: number;
};

/** URL Inspection's `inspectionResult.indexStatusResult` (the fields we store; Google sends more). */
export type IndexStatusResult = {
  verdict?: string;
  coverageState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  userCanonical?: string;
  [key: string]: unknown;
};

export type GscClient = {
  searchAnalytics: (
    query: SearchAnalyticsQuery
  ) => Promise<SearchAnalyticsRow[]>;
  inspectUrl: (url: string) => Promise<IndexStatusResult>;
  /** Submits (or resubmits) a sitemap; needs the full `webmasters` scope, not `.readonly`. */
  submitSitemap: (feedUrl: string) => Promise<void>;
};

type CachedToken = {
  refreshToken: string;
  clientId: string;
  accessToken: string;
  expiresAt: number;
};

/**
 * One access token per isolate (per credentials); `createGscClient` takes another cache in tests.
 * `pending` is a refresh in flight: concurrent calls (the two Search Analytics pulls run in
 * parallel) share it instead of each exchanging the refresh token.
 */
export type TokenCache = {
  current: CachedToken | null;
  pending?: { key: string; promise: Promise<CachedToken> } | null;
};
const isolateCache: TokenCache = { current: null };

/** Retries after a 429 or 5xx, on top of the first attempt. */
export const MAX_RETRIES = 3;
/** Backoff without a Retry-After header: 1s, 2s, 4s. */
const RETRY_BASE_MS = 1000;
/** A Retry-After longer than this isn't waited for: the error is returned instead. */
export const MAX_RETRY_WAIT_MS = 30_000;

export type GscClientOptions = {
  credentials: GscCredentials;
  /** The Search Console property (`SiteConfig.gscProperty`), e.g. `sc-domain:example.com`. */
  property: string;
  fetch?: typeof fetch;
  clock?: Clock;
  tokenCache?: TokenCache;
  /** Waits between retries (tests pass a fake). */
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to wait before retry number `attempt` (0-based): Retry-After (seconds or an HTTP date) when given, else exponential. */
export function retryDelayMs(
  res: Response,
  attempt: number,
  now: number
): number {
  const header = res.headers.get("Retry-After");
  if (header !== null) {
    const seconds = Number(header);
    if (header.trim() !== "" && Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) {
      return Math.max(0, at - now);
    }
  }
  return RETRY_BASE_MS * 2 ** attempt;
}

const retryable = (status: number) => status === 429 || status >= 500;

export function createGscClient({
  credentials,
  property: siteUrl,
  fetch: fetchFn = fetch,
  clock = systemClock,
  tokenCache = isolateCache,
  sleep = realSleep,
}: GscClientOptions): GscClient {
  const now = () => clock().getTime();

  async function sendOnce(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchFn(url, init);
    } catch (err) {
      throw new GscError(
        "NETWORK",
        `Search Console request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** One request, retried up to MAX_RETRIES times on 429 and 5xx (honouring Retry-After). */
  async function send(url: string, init: RequestInit): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await sendOnce(url, init);
      if (!retryable(res.status) || attempt >= MAX_RETRIES) {
        return res;
      }
      const wait = retryDelayMs(res, attempt, now());
      if (wait > MAX_RETRY_WAIT_MS) {
        return res;
      }
      await res.body?.cancel();
      await sleep(wait);
    }
  }

  const tokenKey = `${credentials.clientId}\n${credentials.refreshToken}`;

  async function accessToken(): Promise<string> {
    const cached = tokenCache.current;
    if (
      cached &&
      cached.refreshToken === credentials.refreshToken &&
      cached.clientId === credentials.clientId &&
      cached.expiresAt > now()
    ) {
      return cached.accessToken;
    }
    let pending =
      tokenCache.pending?.key === tokenKey ? tokenCache.pending.promise : null;
    if (!pending) {
      // Cleared once settled, success or not: a failed refresh isn't reused by the next call.
      const promise: Promise<CachedToken> = refreshAccessToken().finally(() => {
        if (tokenCache.pending?.promise === promise) {
          tokenCache.pending = null;
        }
      });
      tokenCache.pending = { key: tokenKey, promise };
      pending = promise;
    }
    return (await pending).accessToken;
  }

  async function refreshAccessToken(): Promise<CachedToken> {
    const res = await send(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        refresh_token: credentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    } | null;
    if (!(res.ok && body?.access_token)) {
      const reason =
        [body?.error, body?.error_description].filter(Boolean).join(": ") ||
        `HTTP ${res.status}`;
      // invalid_grant / invalid_client / unauthorized_client: the stored credentials are no good.
      let code: GscErrorCode = "AUTH";
      if (res.status >= 500) {
        code = "UPSTREAM";
      } else if (res.status === 429) {
        code = "RATE_LIMITED";
      }
      throw new GscError(
        code,
        `Search Console sign-in failed (${reason})`,
        res.status
      );
    }
    const ttl = Math.min(
      TOKEN_TTL_MS,
      Math.max(0, ((body.expires_in ?? 3600) - 300) * 1000)
    );
    const token = {
      refreshToken: credentials.refreshToken,
      clientId: credentials.clientId,
      accessToken: body.access_token,
      expiresAt: now() + ttl,
    };
    tokenCache.current = token;
    return token;
  }

  /** POSTs JSON (or PUTs nothing) with a bearer token; a 401 drops the cached token and retries once. */
  async function api<T>(
    path: string,
    payload: unknown,
    method: "POST" | "PUT" = "POST"
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await accessToken();
      const res = await send(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload !== undefined && { "Content-Type": "application/json" }),
        },
        ...(payload !== undefined && { body: JSON.stringify(payload) }),
      });
      if (res.status === 401 && attempt === 0) {
        tokenCache.current = null;
        continue;
      }
      const body = (await res.json().catch(() => null)) as
        | (T & { error?: { message?: string; status?: string } })
        | null;
      // A sitemap submit answers with an empty body.
      if (res.ok && (body || payload === undefined)) {
        return (body ?? {}) as T;
      }
      throw apiError(res.status, body?.error);
    }
  }

  return {
    async searchAnalytics({
      startDate,
      endDate,
      dimensions,
      rowLimit = GSC_ROW_LIMIT,
    }) {
      const path = `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
      const rows: SearchAnalyticsRow[] = [];
      for (let startRow = 0; ; ) {
        const page = await api<{ rows?: SearchAnalyticsRow[] }>(path, {
          startDate,
          endDate,
          dimensions,
          rowLimit,
          startRow,
          type: "web",
          dataState: "final",
        });
        // An empty page has no `rows` key at all.
        const got = page.rows ?? [];
        rows.push(...got);
        if (got.length < rowLimit) {
          return rows;
        }
        startRow += got.length;
      }
    },
    async inspectUrl(url) {
      const body = await api<{
        inspectionResult?: { indexStatusResult?: IndexStatusResult };
      }>("/v1/urlInspection/index:inspect", {
        inspectionUrl: url,
        siteUrl,
      });
      return body.inspectionResult?.indexStatusResult ?? {};
    },
    async submitSitemap(feedUrl) {
      await api(
        `/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedUrl)}`,
        undefined,
        "PUT"
      );
    },
  };
}

function apiError(
  status: number,
  error: { message?: string; status?: string } | undefined
): GscError {
  const detail =
    [error?.status, error?.message].filter(Boolean).join(": ") ||
    `HTTP ${status}`;
  if (status === 401) {
    return new GscError(
      "AUTH",
      `Search Console rejected the access token (${detail})`,
      status
    );
  }
  if (status === 403) {
    return new GscError(
      "FORBIDDEN",
      `Search Console refused the request (${detail})`,
      status
    );
  }
  if (status === 429) {
    return new GscError(
      "RATE_LIMITED",
      `Search Console quota exceeded (${detail})`,
      status
    );
  }
  if (status >= 400 && status < 500) {
    return new GscError(
      "BAD_REQUEST",
      `Search Console rejected the query (${detail})`,
      status
    );
  }
  return new GscError("UPSTREAM", `Search Console error (${detail})`, status);
}
