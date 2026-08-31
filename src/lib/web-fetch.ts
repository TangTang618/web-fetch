/**
 * `web_fetch` — retrieval + compression, shared by the MCP tool and the
 * `/fetch` REST route so both behave identically.
 *
 * Retrieval is cached (keyed on everything that affects the bytes, but *not*
 * on `query`), so asking three different questions about the same page costs
 * one fetch and three cheap model calls rather than three fetches.
 */

import { generateCacheKey } from "./cache-key.js";
import { compressContent } from "./compress.js";
import { retrievePage, type RetrievedPage } from "./fetch-page.js";
import type { Env, FetchRequestBody, FetchResult } from "../types.js";

const CACHE_TTL_SECONDS = 60 * 60; // 1 hour

export async function webFetch(env: Env, body: FetchRequestBody): Promise<FetchResult> {
  const useCache = body.no_cache !== true;
  const cacheKey = useCache ? await retrievalCacheKey(body) : null;

  let page: RetrievedPage | null = null;
  let cacheHit = false;

  if (cacheKey) {
    page = await readCache(env, cacheKey);
    cacheHit = page !== null;
  }

  if (!page) {
    page = await retrievePage(env, body);
    if (cacheKey) {
      await writeCache(env, cacheKey, page);
    }
  }

  const warnings = [...(page.warnings ?? [])];

  const compressed = await compressContent(env, page.content, {
    ...(body.compress ? { mode: body.compress } : {}),
    ...(body.query ? { query: body.query } : {}),
  });
  warnings.push(...compressed.warnings);

  let content = compressed.content;
  if (body.max_chars && body.max_chars > 0 && content.length > body.max_chars) {
    content = `${content.slice(0, body.max_chars)}\n\n[truncated at ${body.max_chars} characters]`;
    warnings.push(`Output truncated to max_chars=${body.max_chars}.`);
  }

  if (cacheHit) warnings.push("Retrieval served from cache.");

  return {
    url: page.url,
    ...(page.final_url ? { final_url: page.final_url } : {}),
    ...(page.title ? { title: page.title } : {}),
    content,
    retrieved_via: page.retrieved_via,
    ...(compressed.compression ? { compression: compressed.compression } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Cache key for the *retrieval*, deliberately excluding `query`, `compress`
 * and `max_chars` — those only shape post-processing.
 */
async function retrievalCacheKey(body: FetchRequestBody): Promise<string> {
  return generateCacheKey("fetch", body.url, {
    mode: body.mode ?? "auto",
    format: body.format ?? "markdown",
    ...(body.user_agent ? { user_agent: body.user_agent } : {}),
    ...(body.headers ? { headers: body.headers } : {}),
    ...(body.cookies ? { cookies: body.cookies } : {}),
    ...(body.wait_for ? { wait_for: body.wait_for } : {}),
    ...(body.wait_until ? { wait_until: body.wait_until } : {}),
  });
}

type CachedPage = Omit<RetrievedPage, "warnings">;

async function readCache(env: Env, key: string): Promise<RetrievedPage | null> {
  try {
    const raw = await env.CACHE.get(key, "text");
    if (!raw) return null;
    return JSON.parse(raw) as CachedPage;
  } catch {
    // A cache miss and a corrupt entry are the same thing to the caller.
    return null;
  }
}

async function writeCache(env: Env, key: string, page: RetrievedPage): Promise<void> {
  const { warnings: _drop, ...cacheable } = page;
  try {
    await env.CACHE.put(key, JSON.stringify(cacheable), { expirationTtl: CACHE_TTL_SECONDS });
  } catch {
    // Caching is best-effort; a KV write failure must not fail the fetch.
  }
}
