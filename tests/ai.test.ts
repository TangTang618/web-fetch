/**
 * Wire-level tests for the AI Gateway call: what headers actually go out.
 *
 * Which credential header is present decides whether a request authenticates
 * at all, and the two supported setups need different ones.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chat, resolveBackend } from "../src/lib/ai.js";
import { extractText } from "../src/lib/ai-styles.js";
import { resetAccountIdCache } from "../src/lib/account.js";
import { baseEnv, makeAiBinding } from "./helpers.js";

function bodyOf(mock: ReturnType<typeof vi.fn>): Record<string, any> {
  return JSON.parse((mock.mock.calls[0]?.[1] as RequestInit).body as string);
}

function urlOf(mock: ReturnType<typeof vi.fn>): string {
  return String(mock.mock.calls[0]?.[0]);
}

function stubJson(payload: unknown) {
  const mock = vi.fn(async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

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
  resetAccountIdCache();
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

  it("uses CF_API_TOKEN as the gateway token so a second AI key is not needed", async () => {
    const mock = stubCompletion();
    const result = await chat(
      baseEnv({ ...GATEWAY, CF_API_TOKEN: "one-cf-token" }),
      [{ role: "user", content: "hi" }],
    );

    expect(result.ok).toBe(true);
    const headers = headersOf(mock);
    expect(headers["cf-aig-authorization"]).toBe("Bearer one-cf-token");
    expect(headers.Authorization).toBeUndefined();
  });

  it("looks up the account ID from CF_API_TOKEN when none is configured", async () => {
    const mock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/accounts?") || url.endsWith("/accounts") || url.includes("/accounts?per_page")) {
        return new Response(JSON.stringify({ result: [{ id: "auto-acct", name: "Mine" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "compressed output" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", mock);

    const result = await chat(
      baseEnv({
        AI_GATEWAY_ID: "my-gateway",
        AI_MODEL: "openai/gpt-5-mini",
        CF_API_TOKEN: "one-cf-token",
      }),
      [{ role: "user", content: "hi" }],
    );

    expect(result.ok).toBe(true);
    const urls = mock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/client/v4/accounts"))).toBe(true);
    expect(urls.some((u) => u === "https://gateway.ai.cloudflare.com/v1/auto-acct/my-gateway/compat/chat/completions")).toBe(true);
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

describe("chat — API styles", () => {
  const SYSTEM = "You extract things.";
  const USER = "Question: price?\n\nPage content: …";

  it('posts Responses-API shape and reads `output` blocks for style "responses"', async () => {
    const mock = stubJson({
      output: [
        { type: "message", content: [{ type: "output_text", text: "The answer." }] },
      ],
    });

    const result = await chat(
      baseEnv({ ...GATEWAY, AI_API_STYLE: "responses", AI_GATEWAY_TOKEN: "cf-token" }),
      [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("The answer.");

    expect(urlOf(mock)).toBe(
      "https://gateway.ai.cloudflare.com/v1/d121aa7c/my-gateway/openai/responses",
    );
    const body = bodyOf(mock);
    // System prompt is a first-class field here, not a message.
    expect(body.instructions).toBe(SYSTEM);
    expect(body.input).toBe(USER);
    expect(body.max_output_tokens).toBeGreaterThan(0);
    expect(body.messages).toBeUndefined();
    // Reasoning models on this API reject sampling params.
    expect(body.temperature).toBeUndefined();
  });

  it('reads the flattened `output_text` when a gateway returns it', () => {
    expect(extractText("responses", { output_text: "flattened" })).toBe("flattened");
  });

  it('posts Messages-API shape and reads content blocks for style "messages"', async () => {
    const mock = stubJson({ content: [{ type: "text", text: "Anthropic says hi." }] });

    const result = await chat(
      baseEnv({
        ...GATEWAY,
        AI_API_STYLE: "messages",
        AI_MODEL: "claude-haiku-4-5",
        AI_PROVIDER_KEY: "sk-ant-test",
      }),
      [{ role: "system", content: SYSTEM }, { role: "user", content: USER }],
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("Anthropic says hi.");

    expect(urlOf(mock)).toBe(
      "https://gateway.ai.cloudflare.com/v1/d121aa7c/my-gateway/anthropic/v1/messages",
    );

    const headers = headersOf(mock);
    // Anthropic authenticates with x-api-key, never a Bearer token.
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = bodyOf(mock);
    expect(body.system).toBe(SYSTEM);
    expect(body.messages).toEqual([{ role: "user", content: USER }]);
    expect(body.max_tokens).toBeGreaterThan(0); // required by this API
  });

  it("still sends only the gateway token for messages style under BYOK", async () => {
    const mock = stubJson({ content: [{ type: "text", text: "ok" }] });
    await chat(
      baseEnv({
        ...GATEWAY,
        AI_API_STYLE: "messages",
        AI_MODEL: "claude-haiku-4-5",
        AI_GATEWAY_TOKEN: "cf-token",
      }),
      [{ role: "user", content: USER }],
    );

    const headers = headersOf(mock);
    expect(headers["cf-aig-authorization"]).toBe("Bearer cf-token");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("rejects an unknown style instead of guessing one", () => {
    const backend = resolveBackend(baseEnv({ ...GATEWAY, AI_API_STYLE: "grpc" }));
    expect(backend.kind).toBe("none");
    if (backend.kind === "none") expect(backend.reason).toContain("AI_API_STYLE");
  });

  it("names the style when the response shape does not match", async () => {
    // Chat-shaped reply while configured for `responses` — the usual symptom
    // of AI_API_STYLE not matching the model.
    stubJson({ choices: [{ message: { content: "chat shaped" } }] });
    const result = await chat(
      baseEnv({ ...GATEWAY, AI_API_STYLE: "responses", AI_GATEWAY_TOKEN: "cf-token" }),
      [{ role: "user", content: USER }],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('AI_API_STYLE="responses"');
      expect(result.error).toContain("matches the model's API");
    }
  });

  it("defaults to the chat style when AI_API_STYLE is unset", async () => {
    const mock = stubJson({ choices: [{ message: { content: "hi" } }] });
    await chat(baseEnv({ ...GATEWAY, AI_GATEWAY_TOKEN: "cf-token" }), [
      { role: "user", content: USER },
    ]);
    expect(urlOf(mock)).toContain("/compat/chat/completions");
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
