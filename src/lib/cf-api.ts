/**
 * Cloudflare Browser Rendering REST API client.
 *
 * Uses the high-level REST endpoints which provide AI extraction,
 * async crawl, and server-side rendering without Worker CPU cost.
 *
 * Docs: https://developers.cloudflare.com/browser-rendering/rest-api/
 *
 * Account ID is optional: if it is not set, the first request looks it up
 * from CF_API_TOKEN via GET /accounts (see `account.ts`).
 */

import { lookupAccountId, type AccountLookup } from "./account.js";
import { validateUrlWithDns } from "./validate-url.js";
import type { Env } from "../types.js";

/** Shown when a route needs the REST API but the deployment has no token. */
export const REST_UNAVAILABLE_MESSAGE =
  "This endpoint needs a Cloudflare API token. Set the CF_API_TOKEN secret " +
  "(`npx wrangler secret put CF_API_TOKEN`) and redeploy. Account ID is " +
  "detected from the token automatically. POST /fetch and the web_fetch MCP " +
  "tool work without it.";

/**
 * Build a REST client, or `null` when this deployment has no token.
 *
 * The Worker is deliberately usable with nothing but an API key — plain
 * fetching needs no Cloudflare token — so every REST-backed route has to cope
 * with the credentials being absent rather than assuming them.
 */
export function cfApiFromEnv(env: Env): CfBrowserApi | null {
  const token = env.CF_API_TOKEN?.trim();
  if (!token) return null;
  return new CfBrowserApi(token, env.CF_ACCOUNT_ID);
}

export type CfApiResponse<T> =
  | { ok: true; data: T; contentType: string }
  | { ok: false; status: number; message: string };

export class CfBrowserApi {
  private accountId: string | undefined;
  private accountLookup: Promise<AccountLookup> | null = null;
  private readonly apiToken: string;

  constructor(apiToken: string, accountId?: string) {
    this.apiToken = apiToken;
    const trimmed = accountId?.trim();
    this.accountId = trimmed || undefined;
  }

  private async resolveAccountId(): Promise<AccountLookup> {
    if (this.accountId) return { ok: true, id: this.accountId };
    if (!this.accountLookup) {
      this.accountLookup = lookupAccountId(this.apiToken).then((result) => {
        if (result.ok) this.accountId = result.id;
        return result;
      });
    }
    return this.accountLookup;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: Record<string, unknown>
  ): Promise<CfApiResponse<T>> {
    try {
      if (body && typeof body.url === "string") {
        const urlCheck = await validateUrlWithDns(body.url);
        if (!urlCheck.valid) {
          return { ok: false, status: 400, message: urlCheck.error };
        }
      }

      const account = await this.resolveAccountId();
      if (!account.ok) {
        return { ok: false, status: 501, message: account.error };
      }

      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account.id}/browser-rendering${endpoint}`,
        {
          method,
          headers: this.headers(),
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(55_000),
        },
      );

      if (!res.ok) {
        const rawText = await res.text().catch(() => res.statusText);
        // Try to extract nested error from CF API response
        let message = rawText;
        try {
          const parsed = JSON.parse(rawText);
          message = parsed.errors?.[0]?.message ?? parsed.error ?? rawText;
        } catch { /* keep raw text */ }
        return { ok: false, status: res.status, message };
      }

      const contentType = res.headers.get("content-type") ?? "application/octet-stream";

      // Binary responses: screenshot (PNG), PDF
      if (contentType.includes("image/") || contentType.includes("application/pdf")) {
        const data = await res.arrayBuffer();
        return { ok: true, data: data as T, contentType };
      }

      // JSON responses — CF API often wraps results in { success, result }
      if (contentType.includes("application/json")) {
        const json = (await res.json()) as Record<string, unknown>;
        // Unwrap CF API envelope if present
        const data = (json.success !== undefined && json.result !== undefined)
          ? json.result as T
          : json as T;
        return { ok: true, data, contentType };
      }

      // Plain text / HTML / Markdown
      const data = (await res.text()) as T;
      return { ok: true, data, contentType };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown fetch error";
      return { ok: false, status: 502, message };
    }
  }

  async content(body: Record<string, unknown>): Promise<CfApiResponse<string>> {
    return this.request<string>("POST", "/content", body);
  }

  async screenshot(body: Record<string, unknown>): Promise<CfApiResponse<ArrayBuffer>> {
    return this.request<ArrayBuffer>("POST", "/screenshot", body);
  }

  async pdf(body: Record<string, unknown>): Promise<CfApiResponse<ArrayBuffer>> {
    return this.request<ArrayBuffer>("POST", "/pdf", body);
  }

  async markdown(body: Record<string, unknown>): Promise<CfApiResponse<string>> {
    return this.request<string>("POST", "/markdown", body);
  }

  async snapshot(body: Record<string, unknown>): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("POST", "/snapshot", body);
  }

  /**
   * Real accessibility tree, as opposed to reconstructing one from /snapshot.
   * Docs: https://developers.cloudflare.com/browser-rendering/rest-api/accessibility-tree-endpoint/
   */
  async accessibilityTree(body: Record<string, unknown>): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("POST", "/accessibilityTree", body);
  }

  async scrape(body: Record<string, unknown>): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("POST", "/scrape", body);
  }

  async json(body: Record<string, unknown>): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("POST", "/json", body);
  }

  async links(body: Record<string, unknown>): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("POST", "/links", body);
  }

  async crawl(body: Record<string, unknown>): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("POST", "/crawl", body);
  }

  async getCrawlStatus(jobId: string): Promise<CfApiResponse<unknown>> {
    return this.request<unknown>("GET", `/crawl/${jobId}`);
  }
}
