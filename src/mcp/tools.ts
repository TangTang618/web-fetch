/**
 * MCP tool registry.
 *
 * Each tool declares a JSON Schema (what the agent sees) and a handler.  Tools
 * also declare what they need from the environment, so `tools/list` can hide
 * anything this deployment can't actually run: an agent shown a tool that
 * always errors will keep calling it.
 *
 * `MCP_TOOLSET=minimal` advertises only the core reading tools — useful for
 * lightweight agents where a 15-tool list is most of the system prompt.
 */

import { CfBrowserApi } from "../lib/cf-api.js";
import { hasRestCredentials } from "../lib/fetch-page.js";
import { mapToCfParams } from "../lib/param-map.js";
import { normalizeLinksResponse, normalizeScrapeResponse } from "../lib/response-normalizers.js";
import { validateUrlWithDns } from "../lib/validate-url.js";
import { webFetch } from "../lib/web-fetch.js";
import { withBrowser, BrowserBindingUnavailable, toBaseBody } from "../lib/puppeteer.js";
import type { Page } from "@cloudflare/puppeteer";
import type { CompressMode, Env, FetchMode, FetchRequestBody } from "../types.js";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolResponse = { content: ContentBlock[]; isError?: boolean };

/** What a tool needs in order to work at all. */
type Requirement = "none" | "rest" | "browser" | "rest-or-browser";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requires: Requirement;
  /** Included in the `minimal` toolset. */
  core: boolean;
  handler: (env: Env, args: Record<string, unknown>) => Promise<ToolResponse>;
};

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const URL_PROP = {
  url: { type: "string", description: "Absolute http(s) URL of the page." },
} as const;

const BROWSER_PROPS = {
  wait_for: { type: "string", description: "CSS selector to wait for before reading the page." },
  wait_until: {
    type: "string",
    enum: ["load", "domcontentloaded", "networkidle0", "networkidle2"],
    description: "Navigation completion strategy.",
  },
  user_agent: { type: "string", description: "Override the User-Agent header." },
  cookies: {
    type: "array",
    description: "Cookies to send, for pages behind a login.",
    items: {
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "string" },
        domain: { type: "string" },
        path: { type: "string" },
      },
      required: ["name", "value"],
    },
  },
  headers: {
    type: "object",
    description: "Extra HTTP headers, as a flat string→string object.",
    additionalProperties: { type: "string" },
  },
  no_cache: { type: "boolean", description: "Bypass the cache and re-fetch." },
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(body: string): ToolResponse {
  return { content: [{ type: "text", text: body }] };
}

function json(value: unknown): ToolResponse {
  return text(JSON.stringify(value, null, 2));
}

export function errorResponse(message: string): ToolResponse {
  return { content: [{ type: "text", text: message }], isError: true };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function requireUrl(args: Record<string, unknown>): string {
  const url = str(args, "url");
  if (!url) throw new Error("Missing required argument: url");
  return url;
}

/** Pull the shared browser-ish options out of a tool call's arguments. */
function baseArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { url: requireUrl(args) };
  for (const key of ["wait_for", "wait_until", "user_agent", "cookies", "headers", "no_cache"]) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

function api(env: Env): CfBrowserApi {
  return new CfBrowserApi(env.CF_ACCOUNT_ID as string, env.CF_API_TOKEN as string);
}

/** Run a CF REST call and turn a failure into an MCP error response. */
async function restCall<T>(
  call: Promise<{ ok: true; data: T; contentType: string } | { ok: false; status: number; message: string }>,
  onSuccess: (data: T) => ToolResponse,
): Promise<ToolResponse> {
  const result = await call;
  if (!result.ok) {
    return errorResponse(`Browser Rendering API error ${result.status}: ${result.message}`);
  }
  return onSuccess(result.data);
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked to stay well clear of the argument-count limit on spread.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Read a web page as Markdown. Handles JavaScript-rendered pages. Pass `query` to get back " +
    "only the parts of the page relevant to a question — this is much cheaper than reading a " +
    "whole page and is the recommended way to use this tool on long documents.",
  requires: "none",
  core: true,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      query: {
        type: "string",
        description:
          "What you want to know from this page. When set, the response contains only the " +
          "relevant passages, quoted from the page, instead of the full text.",
      },
      mode: {
        type: "string",
        enum: ["auto", "fetch", "browser"],
        description:
          "auto (default): plain HTTP first, escalating to a headless browser if the page looks " +
          "client-rendered. fetch: never use a browser. browser: always render.",
      },
      compress: {
        type: "string",
        enum: ["auto", "off", "on"],
        description:
          "auto (default): compress only long pages, or any page when `query` is set. " +
          "off: always return the full text. on: always compress.",
      },
      format: {
        type: "string",
        enum: ["markdown", "text", "html"],
        description: "Output format. Defaults to markdown.",
      },
      max_chars: { type: "number", description: "Hard cap on returned characters." },
      ...BROWSER_PROPS,
    },
    required: ["url"],
  },
  async handler(env, args) {
    const body: FetchRequestBody = {
      ...(baseArgs(args) as unknown as FetchRequestBody),
      ...(str(args, "query") ? { query: str(args, "query") } : {}),
      ...(str(args, "mode") ? { mode: str(args, "mode") as FetchMode } : {}),
      ...(str(args, "compress") ? { compress: str(args, "compress") as CompressMode } : {}),
      ...(str(args, "format") ? { format: str(args, "format") as "markdown" | "text" | "html" } : {}),
      ...(typeof args.max_chars === "number" ? { max_chars: args.max_chars } : {}),
    };

    const result = await webFetch(env, body);

    // The content leads; metadata follows as a short footer so it can't be
    // mistaken for page text.
    const footer: string[] = [];
    if (result.title) footer.push(`title: ${result.title}`);
    if (result.final_url) footer.push(`final_url: ${result.final_url}`);
    footer.push(`retrieved_via: ${result.retrieved_via}`);
    if (result.compression) {
      footer.push(
        `compressed: ${result.compression.original_chars} → ${result.compression.output_chars} chars ` +
          `via ${result.compression.model}`,
      );
    }
    for (const warning of result.warnings ?? []) footer.push(`warning: ${warning}`);

    return text(`${result.content}\n\n---\n${footer.join("\n")}`);
  },
};

const screenshotTool: ToolDefinition = {
  name: "web_screenshot",
  description: "Capture a PNG screenshot of a web page and return it as an image.",
  requires: "rest-or-browser",
  core: true,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      width: { type: "number", description: "Viewport width in pixels. Default 1280." },
      height: { type: "number", description: "Viewport height in pixels. Default 720." },
      full_page: { type: "boolean", description: "Capture the full scrollable page." },
      ...BROWSER_PROPS,
    },
    required: ["url"],
  },
  async handler(env, args) {
    const base = baseArgs(args);
    const width = typeof args.width === "number" ? args.width : 1280;
    const height = typeof args.height === "number" ? args.height : 720;
    const fullPage = args.full_page === true;

    if (hasRestCredentials(env)) {
      const payload = mapToCfParams({
        ...base,
        viewport: { width, height },
        ...(fullPage ? { screenshotOptions: { fullPage: true } } : {}),
      });
      delete payload.no_cache;
      return restCall(api(env).screenshot(payload), (data) => ({
        content: [{ type: "image", data: toBase64(data), mimeType: "image/png" }],
      }));
    }

    try {
      const buffer = await withBrowser(env, toBaseBody(base), async ({ page }) => {
        await page.setViewport({ width, height });
        return (await page.screenshot({ fullPage })) as unknown as ArrayBuffer;
      });
      return {
        content: [{ type: "image", data: toBase64(buffer), mimeType: "image/png" }],
      };
    } catch (err) {
      if (err instanceof BrowserBindingUnavailable) return errorResponse(err.message);
      throw err;
    }
  },
};

const pdfTool: ToolDefinition = {
  name: "web_pdf",
  description:
    "Render a web page to PDF. Returns the PDF as base64. `format` and `landscape` require the " +
    "BROWSER binding; without it the page is rendered at the API's default size.",
  requires: "rest-or-browser",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      format: {
        type: "string",
        enum: ["A4", "Letter", "A3", "A5", "Legal", "Tabloid"],
        description: "Paper size. Requires the BROWSER binding.",
      },
      landscape: { type: "boolean", description: "Landscape orientation. Requires the BROWSER binding." },
      ...BROWSER_PROPS,
    },
    required: ["url"],
  },
  async handler(env, args) {
    const base = baseArgs(args);
    const format = str(args, "format");
    const landscape = args.landscape === true;
    const wantsPaperOptions = Boolean(format) || landscape;

    // The REST /pdf endpoint ignores paper options. Prefer the binding when
    // the caller actually asked for them, rather than silently dropping them.
    if (wantsPaperOptions && env.BROWSER) {
      try {
        const buffer = await withBrowser(env, toBaseBody(base), async ({ page }) =>
          (await page.pdf({
            ...(format ? { format: format as "A4" } : {}),
            landscape,
            printBackground: true,
          })) as unknown as ArrayBuffer,
        );
        return json({ format: format ?? "default", landscape, pdf_base64: toBase64(buffer) });
      } catch (err) {
        if (!(err instanceof BrowserBindingUnavailable)) throw err;
      }
    }

    if (!hasRestCredentials(env)) {
      return errorResponse(
        "PDF rendering needs either CF_ACCOUNT_ID + CF_API_TOKEN or the BROWSER binding.",
      );
    }

    const payload = mapToCfParams(base);
    delete payload.no_cache;
    const warning = wantsPaperOptions
      ? "format/landscape were ignored: they need the BROWSER binding, which is not configured."
      : undefined;

    return restCall(api(env).pdf(payload), (data) =>
      json({ ...(warning ? { warning } : {}), pdf_base64: toBase64(data) }),
    );
  },
};

const extractTool: ToolDefinition = {
  name: "web_extract",
  description:
    "Extract structured JSON from a page using AI. Give a prompt describing the fields you want, " +
    "and optionally a JSON Schema to constrain the shape.",
  requires: "rest",
  core: true,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      prompt: { type: "string", description: "What to extract, in plain language." },
      schema: { type: "object", description: "Optional JSON Schema for the result." },
      ...BROWSER_PROPS,
    },
    required: ["url", "prompt"],
  },
  async handler(env, args) {
    const prompt = str(args, "prompt");
    if (!prompt) return errorResponse("Missing required argument: prompt");
    const payload = mapToCfParams({
      ...baseArgs(args),
      prompt,
      ...(args.schema ? { response_format: { type: "json_schema", json_schema: args.schema } } : {}),
    });
    delete payload.no_cache;
    return restCall(api(env).json(payload), (data) => json(data));
  },
};

const linksTool: ToolDefinition = {
  name: "web_links",
  description: "List every link on a page, with its anchor text.",
  requires: "rest",
  core: true,
  inputSchema: {
    type: "object",
    properties: { ...URL_PROP, ...BROWSER_PROPS },
    required: ["url"],
  },
  async handler(env, args) {
    const payload = mapToCfParams(baseArgs(args));
    delete payload.no_cache;
    return restCall(api(env).links(payload), (data) => json(normalizeLinksResponse(data)));
  },
};

const scrapeTool: ToolDefinition = {
  name: "web_scrape",
  description: "Extract specific elements from a page using CSS selectors.",
  requires: "rest",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      selectors: {
        type: "array",
        items: { type: "string" },
        description: 'CSS selectors, e.g. ["h1", ".price", "#main p"].',
      },
      ...BROWSER_PROPS,
    },
    required: ["url", "selectors"],
  },
  async handler(env, args) {
    const selectors = Array.isArray(args.selectors) ? args.selectors : [];
    if (selectors.length === 0) return errorResponse("Missing required argument: selectors");
    const payload = mapToCfParams({
      ...baseArgs(args),
      elements: selectors.map((s) => (typeof s === "string" ? { selector: s } : s)),
    });
    delete payload.no_cache;
    return restCall(api(env).scrape(payload), (data) => json(normalizeScrapeResponse(data)));
  },
};

const a11yTool: ToolDefinition = {
  name: "web_a11y",
  description:
    "Capture a page's accessibility tree — the semantic structure screen readers see. Useful for " +
    "auditing, and for locating interactive elements before clicking them.",
  requires: "rest",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      root: { type: "string", description: "CSS selector to scope the tree to a subtree." },
      ...BROWSER_PROPS,
    },
    required: ["url"],
  },
  async handler(env, args) {
    const payload = mapToCfParams({
      ...baseArgs(args),
      ...(str(args, "root") ? { root: str(args, "root") } : {}),
    });
    delete payload.no_cache;
    return restCall(api(env).accessibilityTree(payload), (data) => json(data));
  },
};

const crawlTool: ToolDefinition = {
  name: "web_crawl",
  description:
    "Start an asynchronous crawl from a URL, following links across the site. Returns a job ID; " +
    "poll it with web_crawl_status.",
  requires: "rest",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      limit: { type: "number", description: "Maximum pages to crawl." },
      ...BROWSER_PROPS,
    },
    required: ["url"],
  },
  async handler(env, args) {
    const payload = mapToCfParams({
      ...baseArgs(args),
      ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    });
    delete payload.no_cache;
    return restCall(api(env).crawl(payload), (data) => {
      const jobId =
        typeof data === "string"
          ? data
          : ((data as Record<string, unknown>)?.id ?? (data as Record<string, unknown>)?.job_id);
      return json({ job_id: jobId, status: "queued" });
    });
  },
};

const crawlStatusTool: ToolDefinition = {
  name: "web_crawl_status",
  description: "Check a crawl job and retrieve its results once complete.",
  requires: "rest",
  core: false,
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string", description: "Job ID from web_crawl." } },
    required: ["job_id"],
  },
  async handler(env, args) {
    const jobId = str(args, "job_id");
    if (!jobId) return errorResponse("Missing required argument: job_id");
    return restCall(api(env).getCrawlStatus(jobId), (data) => json(data));
  },
};

// --- Interaction tools (BROWSER binding only) --------------------------------

async function interactionResult(
  env: Env,
  args: Record<string, unknown>,
  action: (page: Page) => Promise<unknown>,
): Promise<ToolResponse> {
  try {
    const result = await withBrowser(env, toBaseBody(baseArgs(args)), async ({ page }) => {
      const value = await action(page);
      return { value, title: await page.title(), url: page.url() };
    });
    return json(result);
  } catch (err) {
    if (err instanceof BrowserBindingUnavailable) return errorResponse(err.message);
    return errorResponse(err instanceof Error ? err.message : "Interaction failed");
  }
}

const clickTool: ToolDefinition = {
  name: "web_click",
  description: "Click an element on a page and report the resulting page state.",
  requires: "browser",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      selector: { type: "string", description: "CSS selector of the element to click." },
      ...BROWSER_PROPS,
    },
    required: ["url", "selector"],
  },
  async handler(env, args) {
    const selector = str(args, "selector");
    if (!selector) return errorResponse("Missing required argument: selector");
    return interactionResult(env, args, async (page) => {
      await page.click(selector);
      return `clicked ${selector}`;
    });
  },
};

const typeTool: ToolDefinition = {
  name: "web_type",
  description: "Type text into an input field.",
  requires: "browser",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      selector: { type: "string", description: "CSS selector of the input." },
      text: { type: "string", description: "Text to type." },
      clear: { type: "boolean", description: "Clear the field first." },
      ...BROWSER_PROPS,
    },
    required: ["url", "selector", "text"],
  },
  async handler(env, args) {
    const selector = str(args, "selector");
    const value = typeof args.text === "string" ? args.text : undefined;
    if (!selector || value === undefined) {
      return errorResponse("web_type requires both `selector` and `text`");
    }
    return interactionResult(env, args, async (page) => {
      if (args.clear === true) {
        // Runs in page context, where the Workers type environment has no DOM
        // lib — hence the structural cast rather than HTMLInputElement.
        await page.$eval(selector, (el) => {
          (el as unknown as { value: string }).value = "";
        });
      }
      await page.type(selector, value);
      return `typed into ${selector}`;
    });
  },
};

const evaluateTool: ToolDefinition = {
  name: "web_evaluate",
  description: "Run JavaScript in the page context and return the result.",
  requires: "browser",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      script: { type: "string", description: "JavaScript expression or function body to evaluate." },
      ...BROWSER_PROPS,
    },
    required: ["url", "script"],
  },
  async handler(env, args) {
    const script = str(args, "script");
    if (!script) return errorResponse("Missing required argument: script");
    return interactionResult(env, args, async (page) => page.evaluate(script));
  },
};

const submitFormTool: ToolDefinition = {
  name: "web_submit_form",
  description: "Fill a form's fields and submit it.",
  requires: "browser",
  core: false,
  inputSchema: {
    type: "object",
    properties: {
      ...URL_PROP,
      fields: {
        type: "object",
        description: 'CSS selector → value, e.g. {"#email": "a@b.com"}.',
        additionalProperties: { type: "string" },
      },
      submit_selector: {
        type: "string",
        description: "Selector of the submit button. Defaults to submitting the first form.",
      },
      ...BROWSER_PROPS,
    },
    required: ["url", "fields"],
  },
  async handler(env, args) {
    const fields = args.fields;
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
      return errorResponse("`fields` must be an object of selector → value");
    }
    const submitSelector = str(args, "submit_selector");
    return interactionResult(env, args, async (page) => {
      for (const [selector, value] of Object.entries(fields as Record<string, unknown>)) {
        await page.type(selector, String(value));
      }
      if (submitSelector) {
        await page.click(submitSelector);
      } else {
        await page.$eval("form", (form) =>
          (form as unknown as { submit: () => void }).submit(),
        );
      }
      await page.waitForNavigation({ timeout: 15_000 }).catch(() => null);
      return "form submitted";
    });
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const ALL_TOOLS: ToolDefinition[] = [
  webFetchTool,
  screenshotTool,
  extractTool,
  linksTool,
  scrapeTool,
  a11yTool,
  pdfTool,
  crawlTool,
  crawlStatusTool,
  clickTool,
  typeTool,
  evaluateTool,
  submitFormTool,
];

export function isToolAvailable(tool: ToolDefinition, env: Env): boolean {
  const rest = hasRestCredentials(env);
  const browser = Boolean(env.BROWSER);
  switch (tool.requires) {
    case "none":
      return true;
    case "rest":
      return rest;
    case "browser":
      return browser;
    case "rest-or-browser":
      return rest || browser;
  }
}

/** Tools this deployment can actually run, honouring MCP_TOOLSET. */
export function availableTools(env: Env): ToolDefinition[] {
  const minimal = env.MCP_TOOLSET?.trim().toLowerCase() === "minimal";
  return ALL_TOOLS.filter(
    (tool) => isToolAvailable(tool, env) && (!minimal || tool.core),
  );
}

export function findTool(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find((tool) => tool.name === name);
}

/** Explain why a configured-away tool isn't usable, so the agent stops retrying. */
export function unavailableReason(tool: ToolDefinition): string {
  switch (tool.requires) {
    case "rest":
      return `${tool.name} needs the Browser Rendering REST API. Set the CF_ACCOUNT_ID and CF_API_TOKEN secrets.`;
    case "browser":
      return `${tool.name} needs the BROWSER binding (Workers Paid). Add it to wrangler.jsonc and redeploy.`;
    case "rest-or-browser":
      return `${tool.name} needs either CF_ACCOUNT_ID + CF_API_TOKEN or the BROWSER binding.`;
    default:
      return `${tool.name} is unavailable.`;
  }
}

/** Guard against a tool call for a URL that resolves somewhere private. */
export async function assertUrlAllowed(args: Record<string, unknown>): Promise<string | null> {
  const url = typeof args.url === "string" ? args.url : null;
  if (!url) return null;
  const check = await validateUrlWithDns(url);
  return check.valid ? null : check.error;
}
