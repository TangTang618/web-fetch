/**
 * Chat-completion access for the compression layer.
 *
 * Two backends, picked in this order:
 *
 *   1. **AI Gateway** (preferred) — by default the OpenAI-compatible unified
 *      endpoint, where any provider works by changing `AI_MODEL` to
 *      `{provider}/{model}`, e.g. `openai/gpt-5-mini` or
 *      `google-ai-studio/gemini-2.5-flash`. Models that only speak OpenAI's
 *      Responses API, or callers who want Anthropic's native Messages API,
 *      set `AI_API_STYLE` — see `ai-styles.ts`. Every style inherits the
 *      Gateway's caching, logging, rate limiting and guardrails.
 *      Docs: https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
 *
 *   2. **Workers AI binding** — `env.AI.run()`.  No extra configuration, but the
 *      models available there are small, so this is a fallback rather than the
 *      default.  When a Gateway ID is configured the binding call is routed
 *      through it too, so logs stay in one place.
 *
 * Callers get a typed failure rather than an exception: compression is an
 * enhancement, and a model outage must never take the fetch down with it.
 */

import type { Env } from "../types.js";
import {
  buildRequest,
  extractError,
  extractText,
  isApiStyle,
  type ApiStyle,
} from "./ai-styles.js";

export const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const GATEWAY_BASE = "https://gateway.ai.cloudflare.com/v1";
const REQUEST_TIMEOUT_MS = 30_000;

export type ChatMessage = { role: "system" | "user"; content: string };

export type ChatResult =
  | { ok: true; text: string; model: string }
  | { ok: false; error: string };

export type AiBackend =
  /**
   * At least one of `providerKey` / `gatewayToken` is always set. Which one
   * depends on how the gateway holds credentials — see `resolveBackend`.
   */
  | {
      kind: "gateway";
      model: string;
      style: ApiStyle;
      accountId: string;
      gatewayId: string;
      providerKey?: string;
      gatewayToken?: string;
    }
  | { kind: "binding"; model: string }
  | { kind: "none"; reason: string };

/**
 * Decide which backend to use from the environment alone.
 *
 * Exported so `/health` and `tools/list` can report compression availability
 * without having to make a model call.
 */
export function resolveBackend(env: Env): AiBackend {
  const gatewayId = env.AI_GATEWAY_ID?.trim();
  const accountId = (env.AI_GATEWAY_ACCOUNT_ID ?? env.CF_ACCOUNT_ID)?.trim();
  const providerKey = env.AI_PROVIDER_KEY?.trim();
  const model = env.AI_MODEL?.trim();

  // Setting AI_GATEWAY_ID is an explicit choice of backend, so an incomplete
  // gateway config is an error to report — never a quiet downgrade to the
  // Workers AI binding. The binding's models are small; silently answering
  // with one when the operator asked for gpt-5-mini would misrepresent every
  // compressed response, and the AI binding is present in the default
  // wrangler.jsonc, so the downgrade would almost always be available.
  if (gatewayId) {
    const gatewayToken = env.AI_GATEWAY_TOKEN?.trim();

    const rawStyle = env.AI_API_STYLE?.trim().toLowerCase() || "chat";
    if (!isApiStyle(rawStyle)) {
      return {
        kind: "none",
        reason: `AI_API_STYLE must be one of chat, responses, messages (got "${rawStyle}")`,
      };
    }

    const missing: string[] = [];
    if (!accountId) missing.push("AI_GATEWAY_ACCOUNT_ID (or CF_ACCOUNT_ID)");
    if (!model) {
      // The unified endpoint routes on a `{provider}/{model}` name; the
      // provider-specific paths take the provider's own bare model id.
      missing.push(
        rawStyle === "chat"
          ? "AI_MODEL (expected `{provider}/{model}`)"
          : "AI_MODEL (the provider's own model id)",
      );
    }
    // Either credential is sufficient on its own. A gateway holding the
    // provider's key itself — via BYOK or Unified Billing — is authenticated
    // with AI_GATEWAY_TOKEN alone, and requiring a provider key there would
    // lock out the setup Cloudflare recommends.
    if (!providerKey && !gatewayToken) {
      missing.push("AI_PROVIDER_KEY or AI_GATEWAY_TOKEN");
    }

    if (missing.length > 0) {
      return {
        kind: "none",
        reason:
          `AI_GATEWAY_ID is set but ${missing.join(", ")} ` +
          `${missing.length === 1 ? "is" : "are"} missing. Compression is disabled rather than ` +
          `falling back to the smaller Workers AI models, which would silently change the ` +
          `model behind your results. Clear AI_GATEWAY_ID to use the binding on purpose.`,
      };
    }

    return {
      kind: "gateway",
      model: model as string,
      style: rawStyle,
      accountId: accountId as string,
      gatewayId,
      ...(providerKey ? { providerKey } : {}),
      ...(gatewayToken ? { gatewayToken } : {}),
    };
  }

  if (env.AI) {
    return {
      kind: "binding",
      model: env.WORKERS_AI_MODEL?.trim() || DEFAULT_WORKERS_AI_MODEL,
    };
  }

  return { kind: "none", reason: "No AI Gateway configured and no AI binding available" };
}

/** Human-readable model label for a backend, used in responses and /health. */
export function backendModel(backend: AiBackend): string | undefined {
  return backend.kind === "none" ? undefined : backend.model;
}

export async function chat(
  env: Env,
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<ChatResult> {
  const backend = resolveBackend(env);
  if (backend.kind === "none") {
    return { ok: false, error: backend.reason };
  }

  const maxTokens = opts.maxTokens ?? 2048;
  const temperature = opts.temperature ?? 0;

  try {
    if (backend.kind === "gateway") {
      return await callGateway(backend, messages, maxTokens, temperature);
    }
    return await callBinding(env, backend, messages, maxTokens, temperature);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown AI error" };
  }
}

async function callGateway(
  backend: Extract<AiBackend, { kind: "gateway" }>,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<ChatResult> {
  // The style owns the URL, the auth header, the body shape and where the
  // answer lives; everything below is shape-agnostic.
  const request = buildRequest(backend.style, {
    gatewayBase: GATEWAY_BASE,
    accountId: backend.accountId,
    gatewayId: backend.gatewayId,
    model: backend.model,
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n\n"),
    maxTokens,
    temperature,
    ...(backend.providerKey ? { providerKey: backend.providerKey } : {}),
    ...(backend.gatewayToken ? { gatewayToken: backend.gatewayToken } : {}),
  });

  const res = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText);
    return {
      ok: false,
      error: `AI Gateway ${res.status} (${backend.style}): ${extractError(raw)}`.slice(0, 500),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: `AI Gateway returned a non-JSON body (${backend.style})` };
  }

  const text = extractText(backend.style, body);
  if (text === null) {
    // A shape mismatch looks exactly like an empty answer from here, so name
    // the style: it is almost always the wrong AI_API_STYLE for the model.
    return {
      ok: false,
      error:
        `AI Gateway returned no usable text for AI_API_STYLE="${backend.style}". ` +
        `Check that the style matches the model's API.`,
    };
  }

  return { ok: true, text, model: backend.model };
}

async function callBinding(
  env: Env,
  backend: Extract<AiBackend, { kind: "binding" }>,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<ChatResult> {
  if (!env.AI) {
    return { ok: false, error: "AI binding is not available" };
  }

  // Reached only when no gateway is configured, so there is no gateway option
  // to pass through here.
  const raw = await env.AI.run(backend.model, {
    messages,
    max_tokens: maxTokens,
    temperature,
  });

  // Workers AI text models return { response: string }; some return a bare string.
  const text =
    typeof raw === "string"
      ? raw
      : typeof (raw as { response?: unknown })?.response === "string"
        ? (raw as { response: string }).response
        : undefined;

  if (!text || !text.trim()) {
    return { ok: false, error: "Workers AI returned an empty completion" };
  }
  return { ok: true, text, model: backend.model };
}
