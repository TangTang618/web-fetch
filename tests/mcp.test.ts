/**
 * MCP transport tests.
 *
 * These exercise the endpoint the way a real client does: an `initialize`
 * handshake, then `tools/list`, then `tools/call`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import app from "../src/index.js";
import { handleMessage } from "../src/mcp/server.js";
import { baseEnv, restEnv, dnsResponse } from "./helpers.js";
import type { Env } from "../src/types.js";

async function rpc(env: Env, body: unknown, headers: Record<string, string> = {}) {
  return app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer valid-key",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    env,
  );
}

describe("POST /mcp — authentication", () => {
  it("rejects a request with no credentials and points at Bearer auth", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      baseEnv(),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("rejects a wrong key", async () => {
    const res = await rpc(baseEnv(), { jsonrpc: "2.0", id: 1, method: "ping" }, {
      Authorization: "Bearer nope",
    });
    expect(res.status).toBe(401);
  });

  it("accepts X-API-Key for clients that cannot set Authorization", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": "valid-key" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      baseEnv(),
    );
    expect(res.status).toBe(200);
  });

  it("reports 503 with setup instructions when no keys are configured", async () => {
    const res = await rpc(baseEnv({ API_KEYS: "" }), { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(res.status).toBe(503);
    const body = await res.json<{ error: string }>();
    expect(body.error).toContain("wrangler secret put API_KEYS");
  });
});

describe("POST /mcp — protocol", () => {
  it("completes an initialize handshake and echoes a supported version", async () => {
    const res = await rpc(baseEnv(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ result: Record<string, any> }>();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("web-fetch");
  });

  it("falls back to its latest version when the client asks for an unknown one", async () => {
    const result = await handleMessage(baseEnv(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const body = result.body as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("answers notifications with 202 and no body", async () => {
    const res = await rpc(baseEnv(), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("returns method-not-found for an unknown method", async () => {
    const res = await rpc(baseEnv(), { jsonrpc: "2.0", id: 7, method: "does/not/exist" });
    const body = await res.json<{ error: { code: number } }>();
    expect(body.error.code).toBe(-32601);
  });

  it("handles a legacy batch request", async () => {
    const res = await rpc(baseEnv(), [
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]);
    const body = await res.json<unknown[]>();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it("rejects a GET with 405, since there is no server-initiated stream", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", { headers: { Authorization: "Bearer valid-key" } }),
      baseEnv(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toContain("POST");
  });

  it("frames the reply as SSE for a client that only accepts event-stream", async () => {
    const res = await rpc(baseEnv(), { jsonrpc: "2.0", id: 1, method: "ping" }, {
      Accept: "text/event-stream",
    });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(await res.text()).toContain("event: message");
  });
});

describe("POST /mcp — tools/list gating", () => {
  async function listTools(env: Env): Promise<string[]> {
    const res = await rpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = await res.json<{ result: { tools: Array<{ name: string }> } }>();
    return body.result.tools.map((t) => t.name);
  }

  it("advertises only web_fetch when nothing but an API key is configured", async () => {
    const names = await listTools(baseEnv());
    // Plain fetching needs no credentials, so this must always be present —
    // it is what makes a bare deployment useful.
    expect(names).toContain("web_fetch");
    // Anything needing a Cloudflare token or the browser binding must be hidden
    // rather than advertised and then failing on every call.
    expect(names).not.toContain("web_extract");
    expect(names).not.toContain("web_click");
  });

  it("adds the REST-backed tools once credentials exist", async () => {
    const names = await listTools(restEnv());
    expect(names).toContain("web_extract");
    expect(names).toContain("web_links");
    expect(names).toContain("web_crawl");
    // Still no interaction tools without the BROWSER binding.
    expect(names).not.toContain("web_click");
  });

  it("adds interaction tools once the BROWSER binding exists", async () => {
    const names = await listTools(restEnv({ BROWSER: {} as Fetcher }));
    expect(names).toContain("web_click");
    expect(names).toContain("web_submit_form");
  });

  it("honours MCP_TOOLSET=minimal", async () => {
    const full = await listTools(restEnv());
    const minimal = await listTools(restEnv({ MCP_TOOLSET: "minimal" }));
    expect(minimal.length).toBeLessThan(full.length);
    expect(minimal).toContain("web_fetch");
    expect(minimal).not.toContain("web_crawl");
  });
});

describe("POST /mcp — tools/call", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith("https://cloudflare-dns.com")) return dnsResponse();
        return new Response("<html><body><h1>Hello</h1><p>World</p></body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs web_fetch and returns page text", async () => {
    const res = await rpc(baseEnv(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_fetch", arguments: { url: "https://example.com" } },
    });
    const body = await res.json<{ result: { content: Array<{ text: string }>; isError?: boolean } }>();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain("Hello");
    expect(body.result.content[0]?.text).toContain("retrieved_via: fetch");
  });

  it("returns an actionable error for a tool this deployment cannot run", async () => {
    const res = await rpc(baseEnv(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_extract", arguments: { url: "https://example.com", prompt: "x" } },
    });
    const body = await res.json<{ result: { content: Array<{ text: string }>; isError: boolean } }>();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain("CF_API_TOKEN");
  });

  it("refuses a URL that resolves to a private address", async () => {
    const res = await rpc(baseEnv(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "web_fetch", arguments: { url: "http://127.0.0.1/admin" } },
    });
    const body = await res.json<{ result: { isError: boolean; content: Array<{ text: string }> } }>();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/private|blocked/i);
  });

  it("reports an unknown tool without throwing", async () => {
    const res = await rpc(baseEnv(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    });
    const body = await res.json<{ result: { isError: boolean } }>();
    expect(body.result.isError).toBe(true);
  });
});
