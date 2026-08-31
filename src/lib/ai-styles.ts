/**
 * The three request/response shapes the compression layer can speak.
 *
 * AI Gateway's unified `/compat/chat/completions` endpoint covers most models,
 * but not all: models exposed only through OpenAI's Responses API, or callers
 * who want Anthropic's native Messages API, need a different path, a different
 * body, and a different place to read the answer out of.
 *
 * Rather than scatter that across the call site, each style is described once
 * here: where it posts, how it authenticates, how a system+user pair becomes a
 * request body, and how to find the text in the reply. `ai.ts` stays shape-
 * agnostic.
 *
 * Docs:
 *   chat      https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
 *   responses https://platform.openai.com/docs/api-reference/responses
 *   messages  https://docs.anthropic.com/en/api/messages
 */

export type ApiStyle = "chat" | "responses" | "messages";

export const API_STYLES: ApiStyle[] = ["chat", "responses", "messages"];

export function isApiStyle(value: string): value is ApiStyle {
  return (API_STYLES as string[]).includes(value);
}

export type StyleRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export type BuildArgs = {
  gatewayBase: string;
  accountId: string;
  gatewayId: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  providerKey?: string;
  gatewayToken?: string;
};

/**
 * Build the outgoing request for a style.
 *
 * The provider credential is omitted entirely when absent — with BYOK or
 * Unified Billing the gateway supplies it, and an empty header would be
 * forwarded upstream as a bad key.
 */
export function buildRequest(style: ApiStyle, args: BuildArgs): StyleRequest {
  const base = `${args.gatewayBase}/${args.accountId}/${args.gatewayId}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (args.gatewayToken) {
    headers["cf-aig-authorization"] = `Bearer ${args.gatewayToken}`;
  }

  if (style === "messages") {
    // Anthropic authenticates with x-api-key, not a Bearer token, and requires
    // an explicit version header. `max_tokens` is mandatory here.
    if (args.providerKey) headers["x-api-key"] = args.providerKey;
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: `${base}/anthropic/v1/messages`,
      headers,
      body: {
        model: args.model,
        system: args.system,
        messages: [{ role: "user", content: args.user }],
        max_tokens: args.maxTokens,
        temperature: args.temperature,
      },
    };
  }

  if (args.providerKey) headers.Authorization = `Bearer ${args.providerKey}`;

  if (style === "responses") {
    return {
      url: `${base}/openai/responses`,
      headers,
      body: {
        model: args.model,
        // The system prompt is a first-class field here rather than a message.
        instructions: args.system,
        input: args.user,
        max_output_tokens: args.maxTokens,
        // `temperature` is deliberately omitted: the models that are Responses-
        // only tend to be reasoning models, which reject sampling parameters
        // outright. Compression prompts are explicit enough not to need it.
      },
    };
  }

  return {
    url: `${base}/compat/chat/completions`,
    headers,
    body: {
      model: args.model,
      messages: [
        { role: "system", content: args.system },
        { role: "user", content: args.user },
      ],
      max_tokens: args.maxTokens,
      temperature: args.temperature,
    },
  };
}

/**
 * Pull the completion text out of a response body.
 *
 * Returns `null` when the body parses but carries no usable text, which the
 * caller reports as an empty completion rather than treating as success.
 */
export function extractText(style: ApiStyle, body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;

  if (style === "chat") {
    const choices = root.choices;
    if (!Array.isArray(choices)) return null;
    const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
    return typeof content === "string" && content.trim() ? content : null;
  }

  if (style === "messages") {
    // { content: [ { type: "text", text: "…" }, … ] }
    return joinTextBlocks(root.content, "text");
  }

  // Responses API. SDKs expose a flattened `output_text`; the raw API returns
  // an `output` array of items, each with its own content blocks. Handle both,
  // since a gateway may pass either through.
  if (typeof root.output_text === "string" && root.output_text.trim()) {
    return root.output_text;
  }

  const output = root.output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const text = joinTextBlocks((item as Record<string, unknown>).content, "output_text");
    if (text) parts.push(text);
  }

  return parts.length > 0 ? parts.join("") : null;
}

/** Concatenate the `.text` of every block whose `type` matches. */
function joinTextBlocks(blocks: unknown, wantedType: string): string | null {
  if (!Array.isArray(blocks)) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const { type, text } = block as { type?: unknown; text?: unknown };
    if (type === wantedType && typeof text === "string") parts.push(text);
  }
  const joined = parts.join("");
  return joined.trim() ? joined : null;
}

/** Best-effort error message from a failed response body. */
export function extractError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return raw;
}
