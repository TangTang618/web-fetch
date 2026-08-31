/**
 * Cloudflare account ID resolution.
 *
 * Browser Rendering and AI Gateway URLs need an account ID, but operators
 * should not have to paste one. A Cloudflare API token is almost always
 * scoped to a single account, so `GET /accounts` with that token is enough.
 *
 * Resolution order:
 *   1. `CF_ACCOUNT_ID` / `AI_GATEWAY_ACCOUNT_ID` if already set (override).
 *   2. Cached result for this token (isolate-local, so cold starts re-fetch).
 *   3. `GET /accounts` — one account → use it; several → ask the operator
 *      to set `CF_ACCOUNT_ID` rather than guessing.
 */

import type { Env } from "../types.js";

const ACCOUNTS_URL = "https://api.cloudflare.com/client/v4/accounts?per_page=50";
const LOOKUP_TIMEOUT_MS = 10_000;

export type AccountLookup =
  | { ok: true; id: string }
  | { ok: false; error: string };

const cache = new Map<string, AccountLookup>();

/** Test-only: drop the isolate cache so lookups can be re-stubbed. */
export function resetAccountIdCache(): void {
  cache.clear();
}

export function cfApiToken(env: Env): string | undefined {
  return env.CF_API_TOKEN?.trim() || undefined;
}

/** Any Cloudflare token we can use both to call APIs and to look up the account. */
export function cfToken(env: Env): string | undefined {
  return env.CF_API_TOKEN?.trim() || env.AI_GATEWAY_TOKEN?.trim() || undefined;
}

export function explicitAccountId(env: Env): string | undefined {
  return env.CF_ACCOUNT_ID?.trim() || env.AI_GATEWAY_ACCOUNT_ID?.trim() || undefined;
}

/**
 * Resolve the account ID for this deployment.
 *
 * Sync-friendly callers that only need "is a token present?" should use
 * `cfApiToken` / `cfToken` instead of waiting on this.
 */
export async function resolveAccountId(env: Env): Promise<AccountLookup> {
  const explicit = explicitAccountId(env);
  if (explicit) return { ok: true, id: explicit };

  const token = cfToken(env);
  if (!token) {
    return {
      ok: false,
      error:
        "No Cloudflare API token is set. Put CF_API_TOKEN (`npx wrangler secret put CF_API_TOKEN`). " +
        "Account ID is detected from the token; you do not type it.",
    };
  }

  return lookupAccountId(token);
}

export async function lookupAccountId(token: string): Promise<AccountLookup> {
  const cached = cache.get(token);
  if (cached) return cached;

  const result = await fetchAccountId(token);
  if (result.ok) cache.set(token, result);
  return result;
}

async function fetchAccountId(token: string): Promise<AccountLookup> {
  let res: Response;
  try {
    res = await fetch(ACCOUNTS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    return { ok: false, error: `Could not look up Cloudflare account ID (${message}).` };
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => res.statusText);
    return {
      ok: false,
      error:
        `Cloudflare API ${res.status} while looking up the account ID. ` +
        `Check CF_API_TOKEN. ${extractError(raw)}`.slice(0, 400),
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "Cloudflare /accounts returned a non-JSON body." };
  }

  const accounts = parseAccounts(body);
  if (accounts.length === 0) {
    return {
      ok: false,
      error:
        "This API token cannot see any Cloudflare account. Recreate it from the " +
        "'Edit Cloudflare Workers' template, scoped to the account you deploy to.",
    };
  }
  if (accounts.length > 1) {
    const names = accounts
      .slice(0, 5)
      .map((a) => a.name || a.id)
      .join(", ");
    return {
      ok: false,
      error:
        `This token can access ${accounts.length} accounts (${names}). ` +
        "Create an account-scoped token, or set the CF_ACCOUNT_ID secret to pick one.",
    };
  }

  const id = accounts[0]?.id;
  if (!id) {
    return { ok: false, error: "Cloudflare /accounts returned an account with no id." };
  }
  return { ok: true, id };
}

function parseAccounts(body: unknown): Array<{ id: string; name?: string }> {
  if (!body || typeof body !== "object") return [];
  const result = (body as { result?: unknown }).result;
  if (!Array.isArray(result)) return [];
  const out: Array<{ id: string; name?: string }> = [];
  for (const row of result) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { id?: unknown }).id;
    if (typeof id !== "string" || !id) continue;
    const name = (row as { name?: unknown }).name;
    out.push({ id, ...(typeof name === "string" && name ? { name } : {}) });
  }
  return out;
}

function extractError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { errors?: Array<{ message?: string }>; error?: string };
    return parsed.errors?.[0]?.message ?? parsed.error ?? raw;
  } catch {
    return raw;
  }
}
