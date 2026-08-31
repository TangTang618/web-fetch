import { describe, it, expect, vi } from "vitest";
import { compressContent, chunkText, estimateTokens } from "../src/lib/compress.js";
import { resolveBackend } from "../src/lib/ai.js";
import { baseEnv, makeAiBinding } from "./helpers.js";

/** Roughly `tokens` worth of Latin filler. */
function longText(tokens: number): string {
  return "word ".repeat(tokens);
}

describe("estimateTokens", () => {
  it("counts Latin text at about four characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("counts CJK at about one character per token", () => {
    // A page of Chinese would otherwise be underestimated 4x and sail past the
    // compression threshold untouched.
    expect(estimateTokens("中文字符测试")).toBe(6);
  });
});

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("short", 100)).toEqual(["short"]);
  });

  it("splits on heading boundaries", () => {
    const text = `# A\n${longText(60)}\n# B\n${longText(60)}`;
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]?.startsWith("# B")).toBe(true);
  });

  it("hard-splits a single oversized block rather than emitting it whole", () => {
    const giant = Array.from({ length: 200 }, (_, i) => `row ${i} value`).join("\n");
    const chunks = chunkText(giant, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk)).toBeLessThanOrEqual(60);
    }
  });
});

describe("resolveBackend", () => {
  it("prefers AI Gateway when it is fully configured", () => {
    const backend = resolveBackend(
      baseEnv({
        AI_GATEWAY_ID: "my-gw",
        AI_GATEWAY_ACCOUNT_ID: "acct",
        AI_PROVIDER_KEY: "sk-test",
        AI_MODEL: "openai/gpt-5-mini",
        AI: makeAiBinding("x"),
      }),
    );
    expect(backend.kind).toBe("gateway");
    if (backend.kind === "gateway") {
      expect(backend.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct/my-gw/compat/chat/completions",
      );
      expect(backend.model).toBe("openai/gpt-5-mini");
    }
  });

  it("falls back to the Workers AI binding when no gateway is set", () => {
    const backend = resolveBackend(baseEnv({ AI: makeAiBinding("x") }));
    expect(backend.kind).toBe("binding");
  });

  it("explains a half-configured gateway instead of silently degrading", () => {
    const backend = resolveBackend(
      baseEnv({ AI_GATEWAY_ID: "my-gw", AI_GATEWAY_ACCOUNT_ID: "acct", AI_MODEL: "openai/x" }),
    );
    expect(backend.kind).toBe("none");
    if (backend.kind === "none") expect(backend.reason).toContain("AI_PROVIDER_KEY");
  });

  it("does NOT fall back to the binding when the gateway config is incomplete", () => {
    // The default wrangler.jsonc always binds AI, so a fallback here would be
    // available almost every time — and would answer with a small Workers AI
    // model while the operator believed they had configured a large one.
    const backend = resolveBackend(
      baseEnv({
        AI_GATEWAY_ID: "my-gw",
        AI_GATEWAY_ACCOUNT_ID: "acct",
        AI_MODEL: "openai/gpt-5-mini",
        AI: makeAiBinding("small model output"),
        // AI_PROVIDER_KEY deliberately absent
      }),
    );
    expect(backend.kind).toBe("none");
    if (backend.kind === "none") {
      expect(backend.reason).toContain("AI_PROVIDER_KEY");
      expect(backend.reason).toContain("Clear AI_GATEWAY_ID");
    }
  });

  it("names every missing gateway field at once", () => {
    const backend = resolveBackend(baseEnv({ AI_GATEWAY_ID: "my-gw", AI: makeAiBinding("x") }));
    expect(backend.kind).toBe("none");
    if (backend.kind === "none") {
      expect(backend.reason).toContain("AI_GATEWAY_ACCOUNT_ID");
      expect(backend.reason).toContain("AI_PROVIDER_KEY");
      expect(backend.reason).toContain("AI_MODEL");
    }
  });

  it("uses CF_ACCOUNT_ID as the gateway account when no explicit one is given", () => {
    const backend = resolveBackend(
      baseEnv({
        AI_GATEWAY_ID: "my-gw",
        CF_ACCOUNT_ID: "from-cf",
        AI_PROVIDER_KEY: "sk-test",
        AI_MODEL: "openai/gpt-5-mini",
      }),
    );
    expect(backend.kind).toBe("gateway");
    if (backend.kind === "gateway") expect(backend.url).toContain("/v1/from-cf/my-gw/");
  });
});

describe("compressContent — policy", () => {
  it('returns content untouched with compress "off"', async () => {
    const ai = makeAiBinding("compressed");
    const content = longText(20_000);
    const result = await compressContent(baseEnv({ AI: ai }), content, { mode: "off", query: "x" });
    expect(result.content).toBe(content);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("leaves a short page alone even when a query is given", async () => {
    // Below the query minimum the whole page is cheaper to hand over than a
    // model round-trip, and raw text cannot lose anything.
    const ai = makeAiBinding("compressed");
    const content = "A short page.";
    const result = await compressContent(baseEnv({ AI: ai }), content, { query: "what?" });
    expect(result.content).toBe(content);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("extracts when a query is given and the page is past the query minimum", async () => {
    const ai = makeAiBinding("The relevant bit.");
    const result = await compressContent(baseEnv({ AI: ai }), longText(1_000), {
      query: "what is the price?",
    });
    expect(ai.run).toHaveBeenCalled();
    expect(result.content).toBe("The relevant bit.");
    expect(result.compression?.query).toBe("what is the price?");
  });

  it("leaves a long page alone when no query is given and it is under the threshold", async () => {
    const ai = makeAiBinding("condensed");
    const content = longText(2_000); // over query minimum, under 8k threshold
    const result = await compressContent(baseEnv({ AI: ai }), content, {});
    expect(result.content).toBe(content);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("condenses a page past the threshold with no query", async () => {
    const ai = makeAiBinding("condensed");
    const original = longText(9_000);
    const result = await compressContent(baseEnv({ AI: ai }), original, {});
    expect(ai.run).toHaveBeenCalled();
    // 9k tokens exceeds one 6k chunk, so it is mapped in two and merged.
    expect(ai.run.mock.calls).toHaveLength(2);
    expect(result.content).toBe("condensed\n\ncondensed");
    expect(result.compression?.query).toBeUndefined();
    expect(result.compression?.original_chars).toBe(original.length);
  });

  it('always compresses with compress "on"', async () => {
    const ai = makeAiBinding("tiny");
    const result = await compressContent(baseEnv({ AI: ai }), "short", { mode: "on" });
    expect(ai.run).toHaveBeenCalled();
    expect(result.content).toBe("tiny");
  });

  it("honours a custom threshold from the environment", async () => {
    const ai = makeAiBinding("condensed");
    const env = baseEnv({ AI: ai, COMPRESS_THRESHOLD: "10" });
    await compressContent(env, longText(100), {});
    expect(ai.run).toHaveBeenCalled();
  });
});

describe("compressContent — failure handling", () => {
  it("returns the original content with a warning when no model is configured", async () => {
    const content = longText(9_000);
    const result = await compressContent(baseEnv(), content, {});
    expect(result.content).toBe(content);
    expect(result.warnings.join(" ")).toContain("Compression skipped");
  });

  it("falls back to the full content when every model call fails", async () => {
    // A model outage must degrade to "more tokens", never to "no answer".
    const ai = { run: vi.fn(async () => { throw new Error("upstream 503"); }) };
    const content = longText(9_000);
    const result = await compressContent(baseEnv({ AI: ai }), content, {});
    expect(result.content).toBe(content);
    expect(result.warnings.join(" ")).toContain("Compression failed");
  });

  it("says so plainly when the page holds nothing relevant to the query", async () => {
    const ai = makeAiBinding("NOTHING_RELEVANT");
    const result = await compressContent(baseEnv({ AI: ai }), longText(1_000), {
      query: "unrelated question",
    });
    expect(result.content).toContain("unrelated question");
    expect(result.warnings.join(" ")).toContain('compress:"off"');
  });

  it("caps the number of chunks and reports the truncation", async () => {
    const ai = makeAiBinding("part");
    const result = await compressContent(baseEnv({ AI: ai }), longText(80_000), {});
    expect(ai.run.mock.calls.length).toBeLessThanOrEqual(8);
    expect(result.compression?.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("compression budget");
  });
});
