/**
 * Retrieval-strategy tests: which path `mode` takes, and what happens when it
 * fails. These are the decisions that determine both cost and whether a page
 * comes back at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { retrievePage, FetchPageError } from "../src/lib/fetch-page.js";
import { webFetch } from "../src/lib/web-fetch.js";
import { baseEnv, restEnv, dnsResponse } from "./helpers.js";

const RICH_HTML = `<html><head><title>Doc</title></head><body><main><h1>Guide</h1><p>${"content ".repeat(
  120,
)}</p></main></body></html>`;

const SPA_HTML = `<html><head><title>App</title></head><body><div id="root"></div><script>boot()</script></body></html>`;

type FetchCall = { url: string; init?: RequestInit };

let calls: FetchCall[];

/** Route requests by URL: DNS, the Cloudflare API, and the origin under test. */
function stubFetch(handlers: {
  origin?: () => Response;
  cfApi?: () => Response;
}) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ...(init ? { init } : {}) });

    if (url.startsWith("https://cloudflare-dns.com")) return dnsResponse();
    if (url.startsWith("https://api.cloudflare.com")) {
      if (!handlers.cfApi) throw new Error("unexpected CF API call");
      return handlers.cfApi();
    }
    if (!handlers.origin) throw new Error("unexpected origin call");
    return handlers.origin();
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function originCalls(): FetchCall[] {
  return calls.filter(
    (c) => !c.url.startsWith("https://cloudflare-dns.com") && !c.url.startsWith("https://api.cloudflare.com"),
  );
}

function cfApiCalls(): FetchCall[] {
  return calls.filter((c) => c.url.startsWith("https://api.cloudflare.com"));
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("retrievePage — mode selection", () => {
  it("uses the plain fetch and never touches the browser for a server-rendered page", async () => {
    stubFetch({ origin: () => html(RICH_HTML) });
    const page = await retrievePage(restEnv(), { url: "https://example.com/doc" });

    expect(page.retrieved_via).toBe("fetch");
    expect(page.title).toBe("Doc");
    expect(page.content).toContain("# Guide");
    // The whole point of the fast path: no browser time consumed.
    expect(cfApiCalls()).toHaveLength(0);
  });

  it("escalates to browser rendering when the page looks client-rendered", async () => {
    stubFetch({
      origin: () => html(SPA_HTML),
      cfApi: () => new Response("# Rendered by browser", { headers: { "Content-Type": "text/plain" } }),
    });

    const page = await retrievePage(restEnv(), { url: "https://example.com/app" });
    expect(page.retrieved_via).toBe("browser");
    expect(page.content).toContain("Rendered by browser");
    expect(cfApiCalls()[0]?.url).toContain("/browser-rendering/markdown");
  });

  it("escalates when the origin blocks the plain fetch", async () => {
    stubFetch({
      origin: () => html("<html><body>Forbidden</body></html>", 403),
      cfApi: () => new Response("# Got through", { headers: { "Content-Type": "text/plain" } }),
    });

    const page = await retrievePage(restEnv(), { url: "https://example.com/blocked" });
    expect(page.retrieved_via).toBe("browser");
  });

  it('never escalates with mode "fetch", even for a thin page', async () => {
    stubFetch({ origin: () => html(SPA_HTML) });
    const page = await retrievePage(restEnv(), { url: "https://example.com/app", mode: "fetch" });
    expect(page.retrieved_via).toBe("fetch");
    expect(cfApiCalls()).toHaveLength(0);
  });

  it('skips the plain fetch entirely with mode "browser"', async () => {
    stubFetch({
      cfApi: () => new Response("# Direct render", { headers: { "Content-Type": "text/plain" } }),
    });
    const page = await retrievePage(restEnv(), { url: "https://example.com", mode: "browser" });
    expect(page.retrieved_via).toBe("browser");
    expect(originCalls()).toHaveLength(0);
  });
});

describe("retrievePage — degradation", () => {
  it("returns the thin plain-fetch result when escalation is impossible", async () => {
    // A deployment with only an API key has no browser at all. Returning the
    // thin page with a warning beats failing the request outright.
    stubFetch({ origin: () => html(SPA_HTML) });
    const page = await retrievePage(baseEnv(), { url: "https://example.com/app" });

    expect(page.retrieved_via).toBe("fetch");
    expect(page.warnings?.join(" ")).toContain("Browser rendering is unavailable");
  });

  it("surfaces the origin error when the plain fetch fails and no browser exists", async () => {
    stubFetch({ origin: () => html("nope", 500) });
    await expect(retrievePage(baseEnv(), { url: "https://example.com" })).rejects.toBeInstanceOf(
      FetchPageError,
    );
  });

  it("rejects a URL that resolves to a private address before fetching anything", async () => {
    stubFetch({ origin: () => html(RICH_HTML) });
    await expect(
      retrievePage(baseEnv(), { url: "http://169.254.169.254/latest/meta-data" }),
    ).rejects.toThrow(/private/i);
    expect(originCalls()).toHaveLength(0);
  });

  it("refuses a redirect that lands on a private address", async () => {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://cloudflare-dns.com")) {
        // The original host is public; the redirect target is not.
        return url.includes("internal") ? dnsResponse("10.0.0.5") : dnsResponse();
      }
      const res = html(RICH_HTML);
      Object.defineProperty(res, "url", { value: "https://internal.example.com/secret" });
      return res;
    });
    vi.stubGlobal("fetch", mock);

    await expect(retrievePage(baseEnv(), { url: "https://example.com" })).rejects.toThrow(
      /redirect target rejected/i,
    );
  });
});

describe("retrievePage — content types", () => {
  it("pretty-prints a JSON response inside a fence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://cloudflare-dns.com")) return dnsResponse();
        return new Response('{"a":1,"b":[2,3]}', {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const page = await retrievePage(baseEnv(), { url: "https://api.example.com/data" });
    expect(page.content).toContain("```json");
    expect(page.content).toContain('"a": 1');
  });

  it("refuses binary content rather than returning garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://cloudflare-dns.com")) return dnsResponse();
        return new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
      }),
    );

    await expect(
      retrievePage(baseEnv(), { url: "https://example.com/f.pdf", mode: "fetch" }),
    ).rejects.toThrow(/not text/i);
  });
});

describe("webFetch — caching", () => {
  it("serves a repeat request from cache without re-fetching the origin", async () => {
    stubFetch({ origin: () => html(RICH_HTML) });
    const env = baseEnv();

    const first = await webFetch(env, { url: "https://example.com/doc" });
    const before = originCalls().length;
    const second = await webFetch(env, { url: "https://example.com/doc" });

    expect(originCalls()).toHaveLength(before);
    expect(second.content).toBe(first.content);
    expect(second.warnings?.join(" ")).toContain("cache");
  });

  it("re-fetches when no_cache is set", async () => {
    stubFetch({ origin: () => html(RICH_HTML) });
    const env = baseEnv();

    await webFetch(env, { url: "https://example.com/doc" });
    const before = originCalls().length;
    await webFetch(env, { url: "https://example.com/doc", no_cache: true });

    expect(originCalls().length).toBeGreaterThan(before);
  });

  it("applies max_chars after retrieval", async () => {
    stubFetch({ origin: () => html(RICH_HTML) });
    const result = await webFetch(baseEnv(), { url: "https://example.com/doc", max_chars: 50 });
    expect(result.content.length).toBeLessThan(150);
    expect(result.warnings?.join(" ")).toContain("max_chars");
  });
});
