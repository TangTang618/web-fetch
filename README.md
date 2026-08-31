# web-fetch

A web reading tool for AI agents, served straight from a Cloudflare Worker.

Deploy it once, and any agent on any platform can read the web with nothing but
a URL and an API key. No Python, no npx, no local runtime — the tool *is* the
Worker.

[中文快速上手](README.zh-CN.md)

## Why

Most "give your agent web access" tools ship as a package you install next to
the agent. That works until you have a second agent, or a phone, or a teammate,
or a CI job. Then you install it again, and again.

This one is a URL.

```jsonc
{
  "mcpServers": {
    "web-fetch": {
      "type": "http",
      "url": "https://web-fetch.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <your-api-key>" }
    }
  }
}
```

That config works in Claude Code, Cursor, and any other MCP client that speaks
Streamable HTTP. Agents that don't speak MCP can `POST /fetch` or import
`/openapi.json` instead.

## What it does

`web_fetch` is the tool that matters. It reads a page and returns Markdown,
rendering JavaScript only when the page actually needs it.

```jsonc
// The whole page, as Markdown
web_fetch({ url: "https://example.com/docs" })

// Only the parts that answer a question — usually 10-50x fewer tokens
web_fetch({ url: "https://example.com/pricing", query: "what does the team plan cost?" })
```

Two things make it cheap:

**A fast path.** Most pages an agent reads — docs, READMEs, blog posts — are
server-rendered, so spending 2-4 seconds of headless Chrome on them is waste.
`mode: "auto"` (the default) does a plain HTTP fetch first and escalates to a
real browser only when the result comes back empty, blocked, or obviously
client-rendered.

**Model-backed compression.** A 200KB documentation page will blow an agent's
context window and bury the answer. Passing `query` returns only the relevant
passages, quoted from the page. Without a query, pages past a size threshold are
condensed. Prompts are written to keep code blocks, numbers, versions and links
verbatim, because those are what agents get wrong when a summary paraphrases.

| content size | with `query` | without `query` |
|---|---|---|
| under ~800 tokens | returned raw | returned raw |
| under ~8k tokens | extracted | returned raw |
| over ~8k tokens | extracted | condensed |

Set `compress: "off"` for the page verbatim, `"on"` to always compress.

### The rest of the tools

| Tool | What it does | Needs |
|---|---|---|
| `web_fetch` | Read a page as Markdown, with optional query-directed extraction | nothing |
| `web_screenshot` | PNG screenshot, returned as an image | REST token or browser binding |
| `web_extract` | AI-extracted structured JSON from a page | REST token |
| `web_links` | Every link on a page, with anchor text | REST token |
| `web_scrape` | Specific elements by CSS selector | REST token |
| `web_a11y` | The page's accessibility tree | REST token |
| `web_pdf` | Render a page to PDF | REST token or browser binding |
| `web_crawl` / `web_crawl_status` | Multi-page crawl, async | REST token |
| `web_click`, `web_type`, `web_evaluate`, `web_submit_form` | Browser interaction | browser binding |

Tools this deployment can't run are hidden from `tools/list` rather than
advertised and then failing — an agent shown a broken tool will keep calling it.
Set `MCP_TOOLSET=minimal` in `wrangler.jsonc` to advertise only the core reading
tools, which keeps the tool list small for lightweight agents.

## Deploy

### Option A — one command

```bash
git clone https://github.com/sakisakisa-design/web-fetch.git
cd web-fetch
npm install
npm run setup
```

The script deploys the Worker, provisions KV and R2, generates an API key,
stores it as a secret, and prints your client config. It runs the same on
Windows, macOS and Linux.

### Option B — connect the repo to Cloudflare

Fork this repo, then in the Cloudflare dashboard go to **Workers & Pages →
Create → Import a repository** and pick your fork. `wrangler.jsonc` is committed
with no resource IDs in it, which is what lets Cloudflare create the KV
namespaces and R2 bucket for you on the first build.

Then set one secret, and you're live:

```bash
openssl rand -hex 32 | npx wrangler secret put API_KEYS
```

Every push to `main` redeploys.

### Check it

```bash
curl https://<your-worker>.workers.dev/health
```

`/health` reports exactly which capabilities this deployment has and what's
missing — the fastest way to diagnose a half-configured Worker.

## Configuration

Nothing beyond `API_KEYS` is required. Plain-HTTP fetching, the fast path, and
the whole MCP surface work with just that. The rest unlocks more.

### Secrets

```bash
npx wrangler secret put <NAME>
```

| Secret | Unlocks |
|---|---|
| `API_KEYS` | **Required.** Comma-separated list of accepted keys. |
| `CF_ACCOUNT_ID` + `CF_API_TOKEN` | Browser Rendering REST API: crawl, AI extract, links, a11y, screenshots. Create the token with the "Edit Cloudflare Workers" template. |
| `AI_PROVIDER_KEY` | The **model provider's** key (e.g. an OpenAI `sk-…`). Needed only if the gateway does not already hold provider credentials. |
| `AI_GATEWAY_TOKEN` | Cloudflare AI Gateway's **own** token, sent as `cf-aig-authorization`. Needed for an authenticated gateway, and it is the only credential required when the gateway holds the provider key itself. |

### Compression backend

Compression runs through [AI Gateway's OpenAI-compatible
endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/),
so you can point it at any provider by changing one string — and you get the
Gateway's caching, logging, rate limiting and guardrails for free.

In `wrangler.jsonc`:

```jsonc
"vars": {
  "AI_GATEWAY_ID": "my-gateway",
  "AI_GATEWAY_ACCOUNT_ID": "<account id>",  // omit if CF_ACCOUNT_ID is set
  "AI_MODEL": "openai/gpt-5-mini"           // or google-ai-studio/gemini-2.5-flash, anthropic/claude-haiku-4-5, …
}
```

plus **one** credential, depending on how your gateway is set up:

- **The gateway holds the provider key** — via [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
  or [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).
  One Cloudflare token covers every provider, and you switch models by editing
  `AI_MODEL` alone:

  ```bash
  npx wrangler secret put AI_GATEWAY_TOKEN
  ```

- **You pass the provider key yourself** — the classic setup:

  ```bash
  npx wrangler secret put AI_PROVIDER_KEY
  ```

Setting both is fine; each is sent as its own header. When no provider key is
configured, no `Authorization` header is sent at all, which is what lets the
gateway supply the upstream credential.

#### Models that don't speak chat completions

The unified endpoint takes the Chat Completions shape. Some models are only
available through OpenAI's **Responses API**, and some callers would rather use
Anthropic's native **Messages API**. `AI_API_STYLE` selects the shape:

| `AI_API_STYLE` | Endpoint | `AI_MODEL` | Credential header |
|---|---|---|---|
| `chat` (default) | `/compat/chat/completions` | `{provider}/{model}` | `Authorization: Bearer` |
| `responses` | `/openai/responses` | bare OpenAI model id | `Authorization: Bearer` |
| `messages` | `/anthropic/v1/messages` | bare Anthropic model id | `x-api-key` |

```jsonc
"AI_API_STYLE": "responses",
"AI_MODEL": "<the model id>"      // no provider prefix on this style
```

`cf-aig-authorization` works the same in all three, so a BYOK gateway still
needs only `AI_GATEWAY_TOKEN`.

Two details worth knowing: the `responses` style does not send `temperature`,
because the models that are Responses-only tend to be reasoning models that
reject sampling parameters; and if the style does not match the model, the
error names the configured style rather than reporting a mysteriously empty
answer.

If you leave `AI_GATEWAY_ID` **empty**, compression uses the Workers AI binding
(`WORKERS_AI_MODEL`, default `@cf/meta/llama-3.1-8b-instruct-fast`). That needs
no configuration at all, but the models available there are small — prefer the
Gateway for anything where extraction fidelity matters.

Setting `AI_GATEWAY_ID` is treated as an explicit choice. If it is set but
`AI_MODEL`, `AI_PROVIDER_KEY` or the account ID is missing, compression is
**disabled and the reason reported** — it does not quietly fall back to the
binding, because that would answer with a much smaller model than you asked
for while looking like it worked.

If no model is configured at all, compression is skipped and full content is
returned with a warning. It never fails a request.

Check which backend is live:

```bash
curl https://<your-worker>.workers.dev/health
# → "compression": { "enabled": true, "backend": "gateway", "model": "openai/gpt-5-mini" }
```

### Tuning

| Var | Default | Meaning |
|---|---|---|
| `AI_API_STYLE` | `chat` | API shape: `chat`, `responses`, or `messages`. |
| `COMPRESS_THRESHOLD` | `8000` | Tokens above which content is auto-condensed. |
| `COMPRESS_QUERY_MIN` | `800` | Tokens above which a `query` triggers extraction. |
| `MCP_TOOLSET` | `full` | `minimal` advertises only the core reading tools. |

## HTTP API

Every MCP tool has a REST equivalent. All routes take `Authorization: Bearer
<api-key>`.

```bash
curl -X POST https://<your-worker>.workers.dev/fetch \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/pricing", "query": "what does the team plan cost?"}'
```

```jsonc
{
  "url": "https://example.com/pricing",
  "title": "Pricing",
  "content": "## Team\n\n$20 per user per month, billed annually…",
  "retrieved_via": "fetch",
  "compression": {
    "model": "openai/gpt-5-mini",
    "query": "what does the team plan cost?",
    "original_chars": 48210,
    "output_chars": 612
  }
}
```

Other endpoints: `/content`, `/markdown`, `/screenshot`, `/pdf`, `/snapshot`,
`/scrape`, `/json`, `/links`, `/crawl`, `/a11y`, `/click`, `/type`, `/evaluate`,
`/interact`, `/submit-form`. Unauthenticated: `/`, `/health`, `/openapi.json`.

## Authentication

`Authorization: Bearer <key>` is the norm. `X-API-Key` is accepted too, and so
is `?key=` for clients that can't set headers at all — though a key in a query
string can end up in proxy and browser logs, so use it only when you must.

Keys are compared in constant time, and rate limiting is per key (60 req/min).

## Security

- **SSRF protection.** URLs are validated before every fetch, with DNS
  resolution checked against private ranges (RFC 1918, loopback, link-local,
  CGNAT, IPv6 ULA, NAT64). Redirects are re-validated at their destination, and
  a URL rejected on security grounds is never retried through the browser path.
  Puppeteer sessions additionally intercept every sub-request.
- **No secrets in the repo.** `wrangler.jsonc` carries bindings but no IDs, no
  tokens, and no account identifiers.
- **CORS is wildcard by design** — every endpoint requires a bearer token, so
  an unauthenticated cross-origin request gets nothing. Tighten
  `origin` in `src/index.ts` if your threat model differs.

## Development

```bash
npm install
npm run dev          # local Worker at http://localhost:8787
npm test             # vitest
npm run type-check   # tsc --noEmit
```

The HTML→Markdown converter and the compression policy are plain functions with
no runtime globals, so they're unit-testable outside workerd — see
`tests/html-to-markdown.test.ts` and `tests/compress.test.ts`.

```
src/
├── index.ts              Hono app: routes, health, OpenAPI
├── mcp/
│   ├── server.ts         JSON-RPC dispatch (Streamable HTTP)
│   └── tools.ts          Tool schemas, handlers, capability gating
├── lib/
│   ├── web-fetch.ts      retrieve + compress, shared by MCP and REST
│   ├── fetch-page.ts     fast path, escalation, browser backends
│   ├── html-to-markdown.ts   portable tokenizer + converter
│   ├── compress.ts       chunking and compression policy
│   ├── ai.ts             AI Gateway / Workers AI backends
│   ├── cf-api.ts         Browser Rendering REST client
│   └── validate-url.ts   SSRF checks with a shared DNS cache
├── middleware/           auth, rate limiting, caching
└── routes/               one file per REST endpoint
```

## Credits

Forked from [claude-world/cf-browser](https://github.com/claude-world/cf-browser)
and substantially rebuilt around remote MCP, a plain-fetch fast path, and
model-backed compression.

## License

MIT
