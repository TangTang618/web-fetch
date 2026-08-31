# web-fetch 快速上手

给 AI agent 用的网页阅读工具，直接跑在 Cloudflare Worker 上。

部署一次，之后任何 agent、任何平台，只要一个 URL 加一把 key 就能读网页——不装
Python，不装 npx，没有本地运行时。工具本身就是那个 Worker。

> 完整文档见 [README.md](README.md)，这里只讲怎么最快跑起来。

## 接进去

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

这份配置在 Claude Code、Cursor，以及任何支持 Streamable HTTP 的 MCP 客户端里都能用。
不支持 MCP 的 agent 可以直接 `POST /fetch`，或者导入 `/openapi.json`。

## 核心用法

```jsonc
// 整页内容，转成 Markdown
web_fetch({ url: "https://example.com/docs" })

// 只要与问题相关的部分，通常能省 10-50 倍 token
web_fetch({ url: "https://example.com/pricing", query: "团队版多少钱？" })
```

省 token 靠两件事：

**快路径。** agent 要读的大多数页面（文档、README、博客）本来就是服务端渲染的，
为它们启动一次无头 Chrome 纯属浪费。默认的 `mode: "auto"` 先走普通 HTTP 请求，
只有在结果为空、被拦、或明显是前端渲染时才升级到真浏览器。

**小模型压缩。** 一个 200KB 的文档页会撑爆 agent 的上下文，答案反而被埋掉。
传 `query` 就只返回相关段落，原文引用；不传 query 时，超过阈值的页面会被压缩成
结构化摘要。prompt 里明确要求代码块、数字、版本号、链接**原样保留**——摘要式改写
最容易毁掉的就是这些。

| 内容长度 | 传了 `query` | 没传 `query` |
|---|---|---|
| 小于约 800 token | 原样返回 | 原样返回 |
| 小于约 8k token | 定向抽取 | 原样返回 |
| 大于约 8k token | 定向抽取 | 结构化压缩 |

想要原文就传 `compress: "off"`，想强制压缩就传 `"on"`。

## 部署

### 方式一：一条命令

```bash
git clone https://github.com/sakisakisa-design/web-fetch.git
cd web-fetch
npm install
npm run setup
```

脚本会部署 Worker、自动开好 KV 和 R2、生成 API key 存成 secret，最后把客户端配置
打印出来。Windows / macOS / Linux 行为一致。

### 方式二：关联 GitHub 仓库

Fork 本仓库，然后在 Cloudflare 控制台 **Workers & Pages → Create → Import a
repository** 选中你的 fork。仓库里的 `wrangler.jsonc` 故意不写任何资源 ID，
Cloudflare 会在首次构建时自动创建 KV 命名空间和 R2 桶并绑定。

然后设一个 secret 就能用了：

```bash
openssl rand -hex 32 | npx wrangler secret put API_KEYS
```

之后每次推 `main` 都会自动重新部署。

### 验证

```bash
curl https://<你的-worker>.workers.dev/health
```

`/health` 会明确列出当前部署具备哪些能力、缺什么。配置没配全时，看这个最快。

## 配置

除了 `API_KEYS` 之外都不是必须的。只配这一个，普通抓取、快路径、整个 MCP 接口就都能跑。
其余的是解锁更多能力。

| Secret | 解锁什么 |
|---|---|
| `API_KEYS` | **必填。** 逗号分隔的可用 key 列表。 |
| `CF_ACCOUNT_ID` + `CF_API_TOKEN` | Browser Rendering REST API：crawl、AI 抽取、links、a11y、截图。token 用 "Edit Cloudflare Workers" 模板创建。 |
| `AI_PROVIDER_KEY` | **模型供应商**的 key（比如 OpenAI 的 `sk-…`）。只有在网关本身不持有 provider 凭据时才需要。 |
| `AI_GATEWAY_TOKEN` | Cloudflare AI Gateway **自己的**令牌（走 `cf-aig-authorization` 头）。网关开了鉴权时需要；如果网关自己存着 provider key，**这一把就够了**。 |

### 压缩用哪个模型

压缩走 [AI Gateway 的 OpenAI 兼容端点](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)，
换供应商只改一个字符串，而且自动获得 Gateway 的缓存、日志、限流和护栏。

在 `wrangler.jsonc` 里：

```jsonc
"vars": {
  "AI_GATEWAY_ID": "my-gateway",
  "AI_GATEWAY_ACCOUNT_ID": "<账号 id>",  // 已设 CF_ACCOUNT_ID 的话可省略
  "AI_MODEL": "openai/gpt-5-mini"        // 或 google-ai-studio/gemini-2.5-flash、anthropic/claude-haiku-4-5 …
}
```

再按你的网关配置方式，设**其中一把** key：

- **网关自己持有 provider key**（[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
  或 [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)）——
  一把 Cloudflare token 管所有供应商，换模型只改 `AI_MODEL`：

  ```bash
  npx wrangler secret put AI_GATEWAY_TOKEN
  ```

- **你自己带 provider key**（传统方式）：

  ```bash
  npx wrangler secret put AI_PROVIDER_KEY
  ```

两个都设也可以，各走各的头。**没配 provider key 时不会发 `Authorization` 头**——
正是这一点让网关能够代为提供上游凭据。

`AI_GATEWAY_ID` **留空**的话会用 Workers AI binding（默认
`@cf/meta/llama-3.1-8b-instruct-fast`）。那个完全不用配置，但可选模型都很小——
凡是在意抽取保真度的场景，建议走 Gateway 接大模型。

**填了 `AI_GATEWAY_ID` 就视为你明确选择了 gateway。** 此时如果 `AI_MODEL`、
`AI_PROVIDER_KEY` 或账号 ID 缺了任何一项，压缩会**直接停用并报出缺什么**，
而不会偷偷退回 binding——否则你以为在用 gpt-5-mini，实际返回的是 3B 小模型的结果，
表面上还看不出异常。

要是一个模型都没配，压缩会被跳过、返回完整内容并附带一条 warning。**它永远不会让请求失败。**

想确认当前实际在用哪个后端：

```bash
curl https://<你的-worker>.workers.dev/health
# → "compression": { "enabled": true, "backend": "gateway", "model": "openai/gpt-5-mini" }
```

## 安全

URL 在每次抓取前都会校验，DNS 解析结果会比对私有地址段（RFC 1918、回环、链路本地、
CGNAT、IPv6 ULA、NAT64）。重定向落点会重新校验，而且因安全原因被拒的 URL 不会再走
浏览器路径重试。Puppeteer 会话另外还会拦截每一个子请求。

`wrangler.jsonc` 里只有 binding，没有任何资源 ID、token 或账号标识。

## 许可

MIT
