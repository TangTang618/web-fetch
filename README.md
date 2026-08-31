# web-fetch

A web-reading tool for AI agents, running as a Cloudflare Worker.

Deploy once. After that, any agent (Claude Code, Cursor, any MCP client) can
read the web with a URL and an API key. No Python, no npx, no local process.

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

Agents that don't speak MCP can `POST /fetch` instead.

[中文说明](README.zh-CN.md)

---

## Deploy (about 5 minutes)

You need Node 18+ and a Cloudflare account.

```bash
npm install
npx wrangler login          # click Allow in the browser
npm run setup
```

The script will:

1. Deploy the Worker (KV and R2 are created for you — no resource IDs to fill in)
2. Generate an API key and store it as a secret
3. **Optionally** ask for one Cloudflare API token
4. Print the MCP config above, ready to paste into your client

You never type an **Account ID**. Setup and the Worker read it from the token.

### What is the Cloudflare token for?

Skip it and the Worker still works: plain fetches, MCP, the fast path.

Add it and you also get screenshots, PDFs, multi-page crawl, AI extraction,
and compression with GPT / Claude / Gemini.

Create one here:

1. Open [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create Token → use the **Edit Cloudflare Workers** template
3. Paste it when setup asks

**Do not paste an OpenAI or Anthropic key.** One Cloudflare token is enough
(AI Gateway Unified Billing or BYOK).

To add the token later:

```bash
npx wrangler secret put CF_API_TOKEN
```

### Better compression (optional)

By default, long pages are compressed with a small Workers AI model. To use
GPT / Claude / Gemini instead:

1. In the dashboard go to **AI → AI Gateway**, create a gateway, and turn on
   Unified Billing or store provider keys on the gateway (BYOK)
2. When setup asks, enter the gateway name and a model such as `openai/gpt-5-mini`
3. Or edit these two fields in `wrangler.jsonc` and run `npx wrangler deploy`:

```jsonc
"AI_GATEWAY_ID": "my-gateway",
"AI_MODEL": "openai/gpt-5-mini"
```

Still the same `CF_API_TOKEN`. No second key.

### Check it

```bash
curl https://<your-worker>.workers.dev/health
```

`capabilities` lists what this deployment can do and what is missing.

---

## Use it

**Claude Code / Cursor** (and any Streamable HTTP MCP client): paste the JSON
setup printed.

Typical calls:

```jsonc
web_fetch({ url: "https://example.com/docs" })
web_fetch({ url: "https://example.com/pricing", query: "what does the team plan cost?" })
```

Passing `query` returns only the passages that answer the question.

Without MCP:

```bash
curl -X POST https://<your-worker>.workers.dev/fetch \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "query": "what does it cost?"}'
```

---

## Tools

| Tool | Does | Needs |
|---|---|---|
| `web_fetch` | Read a page as Markdown | nothing |
| `web_screenshot` | PNG screenshot | CF token or browser binding |
| `web_pdf` | Render to PDF | same |
| `web_extract` | Structured JSON from a page | CF token |
| `web_links` / `web_scrape` / `web_a11y` | Links, CSS extract, a11y tree | CF token |
| `web_crawl` | Multi-page crawl | CF token |
| `web_click` / `web_type` / `web_evaluate` / `web_submit_form` | Interact with the page | browser binding |

Tools this deployment cannot run are hidden from `tools/list`. Set
`MCP_TOOLSET=minimal` in `wrangler.jsonc` to advertise only the core reading
tools.

---

## Deploy by connecting GitHub

Fork this repo, then in Cloudflare: **Workers & Pages → Create → Import a
repository**. The first build creates KV and R2.

Then:

```bash
openssl rand -hex 32 | npx wrangler secret put API_KEYS
npx wrangler secret put CF_API_TOKEN    # optional, recommended
```

No Account ID to set. Pushes to `main` redeploy.

---

## Local development

```bash
npm install
npm run dev          # http://localhost:8787
npm test
npm run type-check
```

Local secrets go in `.dev.vars` (gitignored):

```
API_KEYS=local-dev-key
CF_API_TOKEN=...
```

---

## Security (short)

URLs are checked before every fetch. Hostnames that resolve to private
addresses are rejected. No secrets in the repo. `wrangler.jsonc` has no
account IDs and no tokens.

## License

MIT. Forked from [claude-world/cf-browser](https://github.com/claude-world/cf-browser)
and rebuilt around remote MCP and a plain-fetch fast path.
