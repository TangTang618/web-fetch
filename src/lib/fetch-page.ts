/**
 * Page retrieval with a fast path.
 *
 * Most of what an agent fetches — docs, READMEs, blog posts, RFCs — is server
 * rendered.  Spending 2-4 seconds of browser time on those is pure waste, so
 * `mode: "auto"` (the default) tries a plain HTTP fetch first and only
 * escalates to real browser rendering when the cheap path comes back empty,
 * blocked, or obviously client-rendered.
 *
 * Browser rendering itself has two backends, tried in order:
 *   1. the Browser Rendering REST API (`/markdown`, `/content`) — best quality,
 *      needs CF_API_TOKEN (account ID is detected from the token);
 *   2. the `BROWSER` binding via puppeteer, converted locally — needs no token.
 */

import type { Env, FetchRequestBody, FetchResult } from "../types.js";
import { CfBrowserApi } from "./cf-api.js";
import { htmlToMarkdown } from "./html-to-markdown.js";
import { mapToCfParams } from "./param-map.js";
import { withBrowser, BrowserBindingUnavailable } from "./puppeteer.js";
import { validateUrlWithDns } from "./validate-url.js";

/** Below this much visible text, `auto` assumes the cheap fetch failed. */
const THIN_CONTENT_CHARS = 500;

const FETCH_TIMEOUT_MS = 15_000;

/**
 * A browser-ish UA. Many sites serve a degraded or empty page to obvious bots,
 * which would send every `auto` request down the expensive path for no reason.
 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class FetchPageError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FetchPageError";
  }
}

export type RetrievedPage = Omit<FetchResult, "compression">;

export async function retrievePage(env: Env, body: FetchRequestBody): Promise<RetrievedPage> {
  const urlCheck = await validateUrlWithDns(body.url);
  if (!urlCheck.valid) {
    throw new FetchPageError(urlCheck.error, 400);
  }

  const mode = body.mode ?? "auto";
  const warnings: string[] = [];

  if (mode === "browser") {
    return await renderInBrowser(env, body, warnings);
  }

  const attempt = await plainFetch(body);

  if (mode === "fetch") {
    if (!attempt.ok) throw new FetchPageError(attempt.error, attempt.status);
    return { ...attempt.page, warnings: warnings.length ? warnings : undefined };
  }

  // mode === "auto"
  if (attempt.ok && !attempt.thin) {
    return { ...attempt.page, warnings: warnings.length ? warnings : undefined };
  }

  // A URL rejected on security grounds is not a candidate for retrying through
  // the browser: the target is the same, and escalating would replace the real
  // reason with a confusing "browser unavailable".
  if (!attempt.ok && attempt.blocked) {
    throw new FetchPageError(attempt.error, attempt.status);
  }

  const reason = attempt.ok
    ? "the plain fetch returned very little text (likely client-rendered)"
    : attempt.error;

  try {
    const rendered = await renderInBrowser(env, body, warnings);
    return rendered;
  } catch (err) {
    // The cheap path may still hold something usable — better to hand back a
    // thin page with an explanation than nothing at all.
    if (attempt.ok) {
      warnings.push(
        `Escalated to browser rendering because ${reason}, but that failed too: ` +
          `${err instanceof Error ? err.message : "unknown error"}. Returning the plain-fetch result.`,
      );
      return { ...attempt.page, warnings };
    }
    throw err instanceof FetchPageError
      ? err
      : new FetchPageError(err instanceof Error ? err.message : "Browser rendering failed", 502);
  }
}

// ---------------------------------------------------------------------------
// Plain fetch
// ---------------------------------------------------------------------------

type PlainFetchOutcome =
  | { ok: true; page: RetrievedPage; thin: boolean }
  /** `blocked` marks a security rejection, which must not be retried elsewhere. */
  | { ok: false; error: string; status: number; blocked?: boolean };

async function plainFetch(body: FetchRequestBody): Promise<PlainFetchOutcome> {
  const headers: Record<string, string> = {
    "User-Agent": body.user_agent ?? DEFAULT_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "Accept-Language": "en,*;q=0.5",
    ...(body.headers ?? {}),
  };

  if (body.cookies?.length) {
    headers.Cookie = body.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  if (body.authenticate) {
    const { username, password } = body.authenticate;
    headers.Authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }

  let res: Response;
  try {
    res = await fetch(body.url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(body.timeout ?? FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `plain fetch failed: ${err instanceof Error ? err.message : "unknown error"}`,
    };
  }

  if (!res.ok) {
    return { ok: false, status: res.status, error: `the origin returned HTTP ${res.status}` };
  }

  // A redirect chain can land somewhere the original SSRF check never saw.
  if (res.url && res.url !== body.url) {
    const finalCheck = await validateUrlWithDns(res.url);
    if (!finalCheck.valid) {
      return {
        ok: false,
        status: 400,
        error: `redirect target rejected: ${finalCheck.error}`,
        blocked: true,
      };
    }
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const finalUrl = res.url && res.url !== body.url ? res.url : undefined;
  const base: Pick<RetrievedPage, "url" | "final_url" | "retrieved_via"> = {
    url: body.url,
    ...(finalUrl ? { final_url: finalUrl } : {}),
    retrieved_via: "fetch",
  };

  if (contentType.includes("application/json")) {
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not valid JSON despite the header — hand back what we got */
    }
    return { ok: true, thin: false, page: { ...base, content: "```json\n" + pretty + "\n```" } };
  }

  if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
    const text = await res.text();
    return { ok: true, thin: text.trim().length < THIN_CONTENT_CHARS, page: { ...base, content: text } };
  }

  if (!contentType.includes("html") && !contentType.includes("xml") && contentType) {
    // Binary or an unsupported type — the browser path won't help either.
    return {
      ok: false,
      status: 415,
      error:
        `the URL returned ${contentType.split(";")[0]}, which is not text. ` +
        `Use web_screenshot or web_pdf for binary documents.`,
    };
  }

  const html = await res.text();
  if (body.format === "html") {
    return { ok: true, thin: false, page: { ...base, content: html } };
  }

  const converted = htmlToMarkdown(html, finalUrl ?? body.url);
  const content =
    body.format === "text" ? stripMarkdown(converted.markdown) : converted.markdown;

  return {
    ok: true,
    thin: converted.textLength < THIN_CONTENT_CHARS,
    page: {
      ...base,
      ...(converted.title ? { title: converted.title } : {}),
      content,
    },
  };
}

/** Crude markdown → plain text, for `format: "text"`. */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/^>\s?/gm, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Browser rendering
// ---------------------------------------------------------------------------

export function hasRestCredentials(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN?.trim());
}

async function renderInBrowser(
  env: Env,
  body: FetchRequestBody,
  warnings: string[],
): Promise<RetrievedPage> {
  const wantsHtml = body.format === "html";

  if (hasRestCredentials(env)) {
    const api = new CfBrowserApi(env.CF_API_TOKEN as string, env.CF_ACCOUNT_ID);
    const { mode: _m, compress: _c, query: _q, format: _f, max_chars: _mc, no_cache: _nc, ...rest } =
      body;
    const payload = mapToCfParams(rest as Record<string, unknown>);
    const result = wantsHtml ? await api.content(payload) : await api.markdown(payload);

    if (result.ok) {
      const content = wantsHtml
        ? result.data
        : body.format === "text"
          ? stripMarkdown(result.data)
          : result.data;
      return {
        url: body.url,
        content,
        retrieved_via: "browser",
        ...(warnings.length ? { warnings } : {}),
      };
    }

    // Fall through to the binding if one is available; otherwise surface the
    // REST error, which carries the actionable message (quota, bad token, …).
    if (!env.BROWSER) {
      throw new FetchPageError(result.message, result.status);
    }
    warnings.push(`Browser Rendering REST API failed (${result.status}); used the BROWSER binding instead.`);
  }

  if (!env.BROWSER) {
    throw new FetchPageError(
      "Browser rendering is unavailable: set CF_API_TOKEN, or add the BROWSER binding.",
      501,
    );
  }

  try {
    const html = await withBrowser(env, body, async ({ page }) => page.content());
    if (wantsHtml) {
      return {
        url: body.url,
        content: html,
        retrieved_via: "browser",
        ...(warnings.length ? { warnings } : {}),
      };
    }
    const converted = htmlToMarkdown(html, body.url);
    return {
      url: body.url,
      ...(converted.title ? { title: converted.title } : {}),
      content: body.format === "text" ? stripMarkdown(converted.markdown) : converted.markdown,
      retrieved_via: "browser",
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (err) {
    if (err instanceof BrowserBindingUnavailable) {
      throw new FetchPageError(err.message, 501);
    }
    throw new FetchPageError(
      err instanceof Error ? err.message : "Browser rendering failed",
      502,
    );
  }
}
