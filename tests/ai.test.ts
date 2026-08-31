/**
 * Wire-level tests for the AI Gateway call: what headers actually go out.
 *
 * Which credential header is present decides whether a request authenticates
 * at all, and the two supported setups need different ones.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chat } from "../src/lib/ai.js";
import { baseEnv, makeAiBinding } from "./helpers.js";

function stubCompletion(body = "compressed output") {
  const mock = vi.fn(async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: body } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function headersOf(mock: ReturnType<typeof vi.fn>): Record<string, string> {
  return (mock.mock.calls[0]?.[1] as RequestInit)?.headers as Record<string, string>;
}

const GATEWAY = {
  AI_GATEWAY_ID: "my-gateway",
  AI_GATEWAY_ACCOUNT_ID: "d121aa7c",
  AI_MODEL: "openai/gpt-5-mini",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chat — AI Gateway", () => {
  it("sends only cf-aig-authorization when the gateway holds the provider key", async () => {
    const mock = stubCompletion();
    const result = await chat(
      baseEnv({ ...GATEWAY, AI_GATEWAY_TOKEN: "cf-token" }),
      [{ role: "user", content: "hi" }],
    );

    expect(result.ok).toBe(true);
    const headers = headersOf(mock);
    expect(headers["cf-aig-authorization"]).toBe("Bearer cf-token");
    // Must be absent, not empty: a placeholder Bearer would be forwarded
    // upstream as a bad provider key.
    expect(headers.Authorization).toBeUndefined();
  });

  it("sends a provider Authorization header when a provider key is configured", async () => {
    const mock = stubCompletion();
    await chat(baseEnv({ ...GATEWAY, AI_PROVIDER_KEY: "sk-test" }), [
      { role: "user", content: "hi" },
    ]);

    const headers = headersOf(mock);
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["cf-aig-authorization"]).toBeUndefined();
  });

  it("sends both when both are configured", async () => {
    const mock = stubCompletion();
    await chat(
      baseEnv({ ...GATEWAY, AI_PROVIDER_KEY: "sk-test", AI_GATEWAY_TOKEN: "cf-token" }),
      [{ role: "user", content: "hi" }],
    );

    const headers = headersOf(mock);
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(headers["cf-aig-authorization"]).toBe("Bearer cf-token");
  });

  it("posts to the compat endpoint with the configured model", async () => {
    const mock = stubCompletion();
    await chat(baseEnv({ ...GATEWAY, AI_GATEWAY_TOKEN: "cf-token" }), [
      { role: "user", content: "hi" },
    ]);

    expect(String(mock.mock.calls[0]?.[0])).toBe(
      "https://gateway.ai.cloudflare.com/v1/d121aa7c/my-gateway/compat/chat/completions",
    );
    const body = JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.model).toBe("openai/gpt-5-mini");
    expect(body.temperature).toBe(0);
  });

  it("reports an upstream error instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 }),
      ),
    );

    const result = await chat(baseEnv({ ...GATEWAY, AI_GATEWAY_TOKEN: "bad" }), [
      { role: "user", content: "hi" },
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("invalid api key");
  });

  it("treats an empty completion as a failure", async () => {
    stubCompletion("   ");
    const result = await chat(baseEnv({ ...GATEWAY, AI_GATEWAY_TOKEN: "cf-token" }), [
      { role: "user", content: "hi" },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("chat — Workers AI binding", () => {
  it("calls the binding when no gateway is configured", async () => {
    const ai = makeAiBinding("binding output");
    const result = await chat(baseEnv({ AI: ai }), [{ role: "user", content: "hi" }]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe("binding output");
      expect(result.model).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
    }
  });

  it("honours WORKERS_AI_MODEL", async () => {
    const ai = makeAiBinding("out");
    await chat(baseEnv({ AI: ai, WORKERS_AI_MODEL: "@cf/other/model" }), [
      { role: "user", content: "hi" },
    ]);
    expect(ai.run.mock.calls[0]?.[0]).toBe("@cf/other/model");
  });

  it("fails with the configuration reason when nothing is set up", async () => {
    const result = await chat(baseEnv(), [{ role: "user", content: "hi" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("No AI Gateway configured");
  });
});
