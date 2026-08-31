# web-fetch

给 AI 用的网页阅读工具，跑在 Cloudflare Worker 上。

部署一次，之后任何 agent（Claude Code、Cursor、别的 MCP 客户端）只要一个 URL 加一把 key 就能读网页。不装 Python，不装 npx，没有本地进程。

```jsonc
{
  "mcpServers": {
    "web-fetch": {
      "type": "http",
      "url": "https://web-fetch.<你的子域>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <你的 api key>" }
    }
  }
}
```

不懂 MCP 的 agent 可以直接 `POST /fetch`。

[English README](README.md)

---

## 部署（大约 5 分钟）

需要：Node 18+，一个 Cloudflare 账号。

```bash
npm install
npx wrangler login          # 浏览器里点一下授权
npm run setup
```

脚本会：

1. 部署 Worker（KV、R2 自动创建，不用填任何资源 ID）
2. 生成一把 API key 存成 secret
3. **可选** 让你贴一把 Cloudflare API token
4. 打印出上面那段 MCP 配置，复制到客户端即可

Account ID **不用手填**。脚本和 Worker 都会从 token 自动识别。

### 这一把 Cloudflare token 干什么用？

不贴也能用：普通网页抓取、MCP、快路径都没问题。

贴了之后多出这些能力：截图、PDF、多页 crawl、AI 抽取、以及用 GPT/Claude/Gemini 压缩长文。

创建方法：

1. 打开 [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create Token → 用 **Edit Cloudflare Workers** 模板
3. 创建完复制 token，setup 问你的时候贴进去

**不要再贴 OpenAI / Anthropic 的 key。** 现在一把 Cloudflare token 就够了（AI Gateway 开 Unified Billing 或 BYOK）。

以后要补 token：

```bash
npx wrangler secret put CF_API_TOKEN
```

### 用更好的模型压缩长文（可选）

默认用 Workers 自带的小模型。想换成 GPT / Claude / Gemini：

1. 控制台 **AI → AI Gateway** 建一个 gateway，打开 Unified Billing 或把供应商 key 存在网关里（BYOK）
2. setup 问你要不要走 AI Gateway 时填网关名字和模型，例如 `openai/gpt-5-mini`
3. 或者自己改 `wrangler.jsonc` 里这两项再 `npx wrangler deploy`：

```jsonc
"AI_GATEWAY_ID": "my-gateway",
"AI_MODEL": "openai/gpt-5-mini"
```

还是同一把 `CF_API_TOKEN`，不用第二把 key。

### 验证

把 setup 打印的地址换进去：

```bash
curl https://<你的-worker>.workers.dev/health
```

`capabilities` 会告诉你哪些开了、缺什么。配到一半就看这个。

---

## 接到客户端

**Claude Code / Cursor**（以及任何支持 Streamable HTTP 的 MCP 客户端）用 setup 打印的 JSON。

常用调用：

```jsonc
web_fetch({ url: "https://example.com/docs" })
web_fetch({ url: "https://example.com/pricing", query: "团队版多少钱？" })
```

传 `query` 时只返回和问题有关的段落，通常能少花很多 token。

不支持 MCP 就当 HTTP API 用：

```bash
curl -X POST https://<你的-worker>.workers.dev/fetch \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "query": "价格是多少？"}'
```

---

## 工具一览

| 工具 | 做什么 | 需要 |
|---|---|---|
| `web_fetch` | 读页面，转成 Markdown | 无 |
| `web_screenshot` | 截图 | CF token 或 browser binding |
| `web_pdf` | 转 PDF | 同上 |
| `web_extract` | 按提示抽出 JSON | CF token |
| `web_links` / `web_scrape` / `web_a11y` | 链接、CSS 抽取、无障碍树 | CF token |
| `web_crawl` | 多页爬取 | CF token |
| `web_click` / `web_type` / `web_evaluate` / `web_submit_form` | 页面交互 | browser binding |

当前部署跑不了的工具不会出现在 `tools/list` 里，避免 agent 反复重试。`wrangler.jsonc` 里设 `MCP_TOOLSET=minimal` 可以只暴露核心阅读工具。

---

## 另一种部署：连 GitHub

Fork 本仓库，Cloudflare 控制台 **Workers & Pages → Create → Import a repository**。第一次构建会自动建 KV 和 R2。

然后只需要：

```bash
openssl rand -hex 32 | npx wrangler secret put API_KEYS
npx wrangler secret put CF_API_TOKEN    # 可选，但推荐
```

Account ID 不用设。之后推 `main` 就会自动重新部署。

---

## 本地开发

```bash
npm install
npm run dev          # http://localhost:8787
npm test
npm run type-check
```

本地 secret 写在 `.dev.vars`（不要提交）：

```
API_KEYS=local-dev-key
CF_API_TOKEN=...
```

---

## 安全（很短）

抓取前会校验 URL，DNS 解析到内网地址会被拒绝。密钥不进仓库。`wrangler.jsonc` 里没有账号 ID、没有 token。

## 许可

MIT。从 [claude-world/cf-browser](https://github.com/claude-world/cf-browser) fork，围绕远程 MCP 和快路径重写。
