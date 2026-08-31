import type { Context, Next } from "hono";
import type { AppEnv, Env } from "../types.js";

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Uses Web Crypto API (available in Workers) to hash both values and compare.
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  // Always hash both inputs so the comparison is constant-time
  // regardless of input length (both digests are 32 bytes).
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  let result = 0;
  for (let i = 0; i < viewA.length; i++) {
    result |= (viewA[i] ?? 0) ^ (viewB[i] ?? 0);
  }
  return result === 0;
}

export type AuthOutcome =
  | { ok: true; apiKey: string }
  | { ok: false; status: 401 | 503; error: string };

/**
 * Extract the presented credential.
 *
 * `Authorization: Bearer` is the norm, but not every MCP client lets you set
 * arbitrary headers, so `X-API-Key` and a `?key=` query parameter are accepted
 * too. The query form is the weakest — it can end up in proxy and browser logs
 * — and is documented as a last resort.
 */
export function extractToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) return token;
  }

  const apiKeyHeader = request.headers.get("X-API-Key")?.trim();
  if (apiKeyHeader) return apiKeyHeader;

  const queryKey = new URL(request.url).searchParams.get("key")?.trim();
  if (queryKey) return queryKey;

  return null;
}

/**
 * Validate a presented token against the configured key list.
 *
 * A deployment with no `API_KEYS` secret is unconfigured, not unauthorized —
 * it reports 503 with the command that fixes it, rather than leaving the
 * operator guessing at a 401.
 */
export async function authenticate(env: Env, request: Request): Promise<AuthOutcome> {
  const configured = (env.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    return {
      ok: false,
      status: 503,
      error:
        "This Worker has no API keys configured. Run: " +
        'openssl rand -hex 32 | npx wrangler secret put API_KEYS',
    };
  }

  const token = extractToken(request);
  if (!token) {
    return {
      ok: false,
      status: 401,
      error: "Missing credentials. Send `Authorization: Bearer <api-key>`.",
    };
  }

  let isValid = false;
  for (const key of configured) {
    if (await safeEqual(key, token)) {
      isValid = true;
      // do NOT break — must compare all keys to avoid positional timing leak
    }
  }

  return isValid ? { ok: true, apiKey: token } : { ok: false, status: 401, error: "Invalid API key" };
}

/**
 * Auth middleware for `/mcp`.
 *
 * Separate from the REST one for two reasons: MCP clients key off
 * `WWW-Authenticate` to tell "wrong key" apart from "transport broken", and
 * authentication has to happen *before* rate limiting so each key gets its own
 * bucket instead of everyone sharing the anonymous one.
 */
export async function mcpAuthMiddleware(
  c: Context<AppEnv>,
  next: Next
): Promise<Response | void> {
  if (c.req.method === "OPTIONS") {
    await next();
    return;
  }

  const outcome = await authenticate(c.env, c.req.raw);

  if (!outcome.ok) {
    return c.json(
      { error: outcome.error, status: outcome.status },
      outcome.status,
      outcome.status === 401 ? { "WWW-Authenticate": 'Bearer realm="web-fetch"' } : {},
    );
  }

  c.set("apiKey", outcome.apiKey);
  await next();
}

/**
 * Auth middleware for the REST routes.
 */
export async function authMiddleware(
  c: Context<AppEnv>,
  next: Next
): Promise<Response | void> {
  const outcome = await authenticate(c.env, c.req.raw);

  if (!outcome.ok) {
    return c.json({ error: outcome.error, status: outcome.status }, outcome.status);
  }

  // Store full API key in context for rate-limiting (hashed there)
  c.set("apiKey", outcome.apiKey);

  await next();
}
