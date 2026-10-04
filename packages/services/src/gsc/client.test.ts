// biome-ignore-all lint/style/noNonNullAssertion: as in the source, plus indexes it proves in range (this repo sets noUncheckedIndexedAccess, the source does not); type-only.
// biome-ignore-all lint/complexity/noVoid: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/performance/useTopLevelRegex: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/noIncrementDecrement: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useDestructuring: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/style/useNumericSeparators: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noDuplicateTestHooks: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/noEmptyBlockStatements: ported verbatim from the source test (kept diffable); test-only idiom.
// biome-ignore-all lint/suspicious/useAwait: ported verbatim from the source test (kept diffable); test-only idiom.
import { describe, expect, it } from "bun:test";

import {
  createGscClient,
  GscError,
  gscCredentials,
  MAX_RETRIES,
  MAX_RETRY_WAIT_MS,
  type SearchAnalyticsRow,
  type TokenCache,
} from "./client";

const credentials = {
  clientId: "client-id",
  clientSecret: "client-SECRET",
  refreshToken: "refresh-SECRET",
};
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROPERTY = "sc-domain:example.com";

type Call = { url: string; init: RequestInit };

/** A fetch that answers the token endpoint and then `api` responses in order. */
function mockFetch(
  api: (call: Call, n: number) => Response,
  token: () => Response = () =>
    json({ access_token: "access-SECRET", expires_in: 3599 })
) {
  const calls: Call[] = [];
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return url === TOKEN_URL ? token() : api({ url, init }, n++);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    apiCalls: () => calls.filter((c) => c.url !== TOKEN_URL),
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const row = (i: number): SearchAnalyticsRow => ({
  keys: ["2026-09-01", `https://x/${i}`],
  clicks: 1,
  impressions: 2,
  ctr: 0.5,
  position: 3,
});
const fresh = (): TokenCache => ({ current: null });
const noSleep = async () => {};

async function caught(p: Promise<unknown>): Promise<GscError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GscError) {
      return err;
    }
    throw err;
  }
  throw new Error("expected a GscError");
}

describe("gscCredentials", () => {
  it("needs all three secrets", () => {
    expect(
      gscCredentials({
        GSC_CLIENT_ID: "a",
        GSC_CLIENT_SECRET: "b",
        GSC_REFRESH_TOKEN: "c",
      })
    ).toEqual({ clientId: "a", clientSecret: "b", refreshToken: "c" });
    expect(
      gscCredentials({
        GSC_CLIENT_ID: "a",
        GSC_CLIENT_SECRET: "b",
        GSC_REFRESH_TOKEN: "",
      })
    ).toBeNull();
    expect(gscCredentials({})).toBeNull();
  });
});

describe("access tokens", () => {
  it("exchanges the refresh token with the token endpoint and sends the access token as a bearer", async () => {
    const m = mockFetch(() => json({ rows: [] }));
    const client = createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    });
    await client.searchAnalytics({
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      dimensions: ["date"],
    });
    const tokenCall = m.tokenCalls()[0]!;
    expect(tokenCall.init.method).toBe("POST");
    expect(
      Object.fromEntries(new URLSearchParams(String(tokenCall.init.body)))
    ).toEqual({
      client_id: "client-id",
      client_secret: "client-SECRET",
      refresh_token: "refresh-SECRET",
      grant_type: "refresh_token",
    });
    expect(
      (m.apiCalls()[0]!.init.headers as Record<string, string>).Authorization
    ).toBe("Bearer access-SECRET");
  });

  it("reuses the token for up to 50 minutes, then refreshes", async () => {
    let now = 0;
    const cache = fresh();
    const m = mockFetch(() => json({ rows: [] }));
    const client = createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: cache,
      clock: () => new Date(now),
    });
    const q = {
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      dimensions: ["date" as const],
    };
    await client.searchAnalytics(q);
    now = 49 * 60_000;
    await client.searchAnalytics(q);
    // A second client in the same isolate shares the cache.
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: cache,
      clock: () => new Date(now),
    }).searchAnalytics(q);
    expect(m.tokenCalls()).toHaveLength(1);
    now = 51 * 60_000;
    await client.searchAnalytics(q);
    expect(m.tokenCalls()).toHaveLength(2);
  });

  it("doesn't reuse a token cached for other credentials", async () => {
    const cache = fresh();
    const m = mockFetch(() => json({ rows: [] }));
    const q = {
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      dimensions: ["date" as const],
    };
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: cache,
    }).searchAnalytics(q);
    await createGscClient({
      property: PROPERTY,
      credentials: { ...credentials, refreshToken: "other" },
      fetch: m.fetch,
      tokenCache: cache,
    }).searchAnalytics(q);
    expect(m.tokenCalls()).toHaveLength(2);
  });

  it("drops a token the API rejects with 401 and retries once with a new one", async () => {
    const m = mockFetch((_, n) =>
      n === 0
        ? json({ error: { message: "expired" } }, 401)
        : json({ rows: [row(1)] })
    );
    const rows = await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    }).searchAnalytics({ startDate: "a", endDate: "b", dimensions: ["page"] });
    expect(rows).toHaveLength(1);
    expect(m.tokenCalls()).toHaveLength(2);
  });

  it("maps a rejected refresh token to AUTH without leaking secrets", async () => {
    const m = mockFetch(
      () => json({}),
      () =>
        json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          400
        )
    );
    const err = await caught(
      createGscClient({
        property: PROPERTY,
        credentials,
        fetch: m.fetch,
        tokenCache: fresh(),
      }).inspectUrl("https://x/")
    );
    expect(err.code).toBe("AUTH");
    expect(err.message).toContain("invalid_grant");
    expect(err.message).not.toMatch(/SECRET/);
  });
});

describe("searchAnalytics", () => {
  it("pages through with startRow until a short page", async () => {
    const pages = [[row(1), row(2)], [row(3), row(4)], [row(5)]];
    const m = mockFetch((_, n) => json({ rows: pages[n] }));
    const rows = await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    }).searchAnalytics({
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      dimensions: ["date", "page"],
      rowLimit: 2,
    });
    expect(rows.map((r) => r.keys[1])).toEqual([
      "https://x/1",
      "https://x/2",
      "https://x/3",
      "https://x/4",
      "https://x/5",
    ]);
    const bodies = m.apiCalls().map((c) => JSON.parse(String(c.init.body)));
    expect(bodies.map((b) => b.startRow)).toEqual([0, 2, 4]);
    expect(bodies[0]).toMatchObject({
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      dimensions: ["date", "page"],
      rowLimit: 2,
      type: "web",
      dataState: "final",
    });
    expect(m.apiCalls()[0]!.url).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query"
    );
  });

  it("stops when a full page is followed by an empty one (no rows key)", async () => {
    const m = mockFetch((_, n) =>
      json(
        n === 0
          ? { rows: [row(1), row(2)] }
          : { responseAggregationType: "byPage" }
      )
    );
    const rows = await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    }).searchAnalytics({
      startDate: "a",
      endDate: "b",
      dimensions: ["page"],
      rowLimit: 2,
    });
    expect(rows).toHaveLength(2);
    expect(m.apiCalls()).toHaveLength(2);
  });

  it("uses the API's maximum page size by default", async () => {
    const m = mockFetch(() => json({}));
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    }).searchAnalytics({ startDate: "a", endDate: "b", dimensions: ["page"] });
    expect(JSON.parse(String(m.apiCalls()[0]!.init.body)).rowLimit).toBe(
      25_000
    );
  });
});

describe("inspectUrl", () => {
  it("posts the URL and site and returns indexStatusResult", async () => {
    const m = mockFetch(() =>
      json({
        inspectionResult: {
          indexStatusResult: {
            verdict: "PASS",
            coverageState: "Submitted and indexed",
          },
        },
      })
    );
    const result = await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    }).inspectUrl("https://example.com/about");
    expect(result).toEqual({
      verdict: "PASS",
      coverageState: "Submitted and indexed",
    });
    const call = m.apiCalls()[0]!;
    expect(call.url).toBe(
      "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
    );
    expect(JSON.parse(String(call.init.body))).toEqual({
      inspectionUrl: "https://example.com/about",
      siteUrl: "sc-domain:example.com",
    });
  });
});

describe("submitSitemap", () => {
  it("PUTs the sitemap with no body and accepts an empty answer", async () => {
    const m = mockFetch(() => new Response(null, { status: 200 }));
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    }).submitSitemap("https://example.com/sitemap.xml");
    const call = m.apiCalls()[0]!;
    expect(call.url).toBe(
      "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml"
    );
    expect(call.init.method).toBe("PUT");
    expect(call.init.body).toBeUndefined();
  });

  it("a read-only token is FORBIDDEN", async () => {
    const m = mockFetch(() =>
      json(
        {
          error: {
            code: 403,
            message: "Request had insufficient authentication scopes.",
            status: "PERMISSION_DENIED",
          },
        },
        403
      )
    );
    const err = await caught(
      createGscClient({
        property: PROPERTY,
        credentials,
        fetch: m.fetch,
        tokenCache: fresh(),
      }).submitSitemap("https://x/sitemap.xml")
    );
    expect(err.code).toBe("FORBIDDEN");
  });
});

describe("error mapping", () => {
  it.each([
    [403, "FORBIDDEN"],
    [429, "RATE_LIMITED"],
    [400, "BAD_REQUEST"],
    [500, "UPSTREAM"],
    [503, "UPSTREAM"],
  ] as const)("HTTP %i → %s", async (status, code) => {
    const m = mockFetch(() =>
      json(
        { error: { code: status, message: "nope", status: "SOME_STATUS" } },
        status
      )
    );
    const err = await caught(
      createGscClient({
        property: PROPERTY,
        credentials,
        fetch: m.fetch,
        tokenCache: fresh(),
        sleep: noSleep,
      }).inspectUrl("https://x/")
    );
    expect(err).toMatchObject({ code, status });
    expect(err.message).toContain("SOME_STATUS: nope");
    expect(err.message).not.toMatch(/SECRET/);
  });

  it("a second 401 is AUTH", async () => {
    const m = mockFetch(() => json({ error: { message: "bad" } }, 401));
    const err = await caught(
      createGscClient({
        property: PROPERTY,
        credentials,
        fetch: m.fetch,
        tokenCache: fresh(),
      }).inspectUrl("https://x/")
    );
    expect(err.code).toBe("AUTH");
    expect(m.apiCalls()).toHaveLength(2);
  });

  it("a failed fetch is NETWORK; a non-JSON error is UPSTREAM", async () => {
    const down = (async () => {
      throw new TypeError("connection reset");
    }) as unknown as typeof fetch;
    expect(
      (
        await caught(
          createGscClient({
            property: PROPERTY,
            credentials,
            fetch: down,
            tokenCache: fresh(),
          }).inspectUrl("https://x/")
        )
      ).code
    ).toBe("NETWORK");
    const m = mockFetch(
      () => new Response("<html>Bad gateway</html>", { status: 502 })
    );
    expect(
      (
        await caught(
          createGscClient({
            property: PROPERTY,
            credentials,
            fetch: m.fetch,
            tokenCache: fresh(),
            sleep: noSleep,
          }).inspectUrl("https://x/")
        )
      ).code
    ).toBe("UPSTREAM");
  });
});

describe("retries", () => {
  const ok = () =>
    json({ inspectionResult: { indexStatusResult: { verdict: "PASS" } } });

  it("retries a 429 or 5xx up to 3 times with 1s, 2s, 4s backoff, then reports the error", async () => {
    const waits: number[] = [];
    const m = mockFetch(() => json({ error: { message: "busy" } }, 503));
    const client = createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
      sleep: async (ms) => void waits.push(ms),
    });
    expect((await caught(client.inspectUrl("https://x/"))).code).toBe(
      "UPSTREAM"
    );
    expect(m.apiCalls()).toHaveLength(1 + MAX_RETRIES);
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it("succeeds when a retry does", async () => {
    const m = mockFetch((_c, n) =>
      n < 2 ? json({ error: { message: "slow down" } }, 429) : ok()
    );
    const result = await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
      sleep: noSleep,
    }).inspectUrl("https://x/");
    expect(result.verdict).toBe("PASS");
    expect(m.apiCalls()).toHaveLength(3);
  });

  it("waits as long as Retry-After says (seconds or a date); doesn't wait past the cap", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => void waits.push(ms);
    const after = (value: string) =>
      new Response("{}", { status: 429, headers: { "Retry-After": value } });
    let m = mockFetch((_c, n) => (n === 0 ? after("7") : ok()));
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
      sleep,
    }).inspectUrl("https://x/");
    m = mockFetch((_c, n) =>
      n === 0 ? after(new Date(10_000).toUTCString()) : ok()
    );
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
      sleep,
      clock: () => new Date(4000),
    }).inspectUrl("https://x/");
    expect(waits).toEqual([7000, 6000]);

    m = mockFetch(() => after(String(MAX_RETRY_WAIT_MS / 1000 + 1)));
    expect(
      (
        await caught(
          createGscClient({
            property: PROPERTY,
            credentials,
            fetch: m.fetch,
            tokenCache: fresh(),
            sleep,
          }).inspectUrl("https://x/")
        )
      ).code
    ).toBe("RATE_LIMITED");
    expect(m.apiCalls()).toHaveLength(1);
  });

  it("doesn't retry other 4xx", async () => {
    const m = mockFetch(() => json({ error: { message: "bad" } }, 400));
    await caught(
      createGscClient({
        property: PROPERTY,
        credentials,
        fetch: m.fetch,
        tokenCache: fresh(),
        sleep: noSleep,
      }).inspectUrl("https://x/")
    );
    expect(m.apiCalls()).toHaveLength(1);
  });

  it("retries the token endpoint's 5xx too", async () => {
    let n = 0;
    const m = mockFetch(ok, () =>
      n++ === 0
        ? new Response("{}", { status: 500 })
        : json({ access_token: "access-SECRET", expires_in: 3599 })
    );
    await createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
      sleep: noSleep,
    }).inspectUrl("https://x/");
    expect(m.tokenCalls()).toHaveLength(2);
  });
});

describe("parallel calls", () => {
  it("share one token refresh", async () => {
    const m = mockFetch(() => json({ rows: [] }));
    const client = createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: fresh(),
    });
    const q = {
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      dimensions: ["date" as const],
    };
    await Promise.all([
      client.searchAnalytics(q),
      client.searchAnalytics(q),
      client.inspectUrl("https://x/"),
    ]);
    expect(m.tokenCalls()).toHaveLength(1);
    expect(m.apiCalls()).toHaveLength(3);
  });

  it("a failed refresh isn't reused: the next call tries again", async () => {
    let n = 0;
    const m = mockFetch(
      () => json({ rows: [] }),
      () =>
        n++ === 0
          ? json({ error: "invalid_grant" }, 400)
          : json({ access_token: "access-SECRET", expires_in: 3599 })
    );
    const cache = fresh();
    const client = createGscClient({
      property: PROPERTY,
      credentials,
      fetch: m.fetch,
      tokenCache: cache,
    });
    const q = {
      startDate: "2026-09-01",
      endDate: "2026-09-01",
      dimensions: ["date" as const],
    };
    const [a, b] = await Promise.allSettled([
      client.searchAnalytics(q),
      client.searchAnalytics(q),
    ]);
    expect([a.status, b.status]).toEqual(["rejected", "rejected"]);
    expect(m.tokenCalls()).toHaveLength(1);
    expect(cache.pending).toBeNull();
    await client.searchAnalytics(q);
    expect(m.tokenCalls()).toHaveLength(2);
  });
});
