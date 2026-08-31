# Contributing

## Scope

This repo is one Cloudflare Worker, built with TypeScript, Hono, Wrangler and
Vitest. There is no separate SDK or client package to keep in sync — that is
deliberate, and new features should land in the Worker rather than in a wrapper
around it.

Keep changes focused, add or update tests for behavior changes, and avoid
committing secrets or generated credentials.

## Prerequisites

- Node.js 18+
- A Cloudflare account and `npx wrangler login`, if you are working on deployed
  behavior rather than logic

## Development

```bash
npm install
npm run dev          # local Worker at http://localhost:8787
```

Local secrets go in `.dev.vars` (gitignored), one `KEY=value` per line:

```
API_KEYS=local-dev-key
CF_API_TOKEN=...
# CF_ACCOUNT_ID is optional. The Worker looks it up from the token.
```

`wrangler.jsonc` **is** committed, and must stay free of resource IDs, account
identifiers and tokens — that absence is what lets a fresh clone deploy without
editing anything.

Before opening a PR:

```bash
npm run type-check
npm test
```

## Testing notes

Tests run in plain Node, not workerd. That is a constraint worth preserving: the
HTML→Markdown converter and the compression policy are written without runtime
globals so they stay directly unit-testable. If you find yourself reaching for a
workerd-only API in that core logic, prefer a portable implementation.

Route-level tests drive the real Hono app via `app.fetch(request, env)` with
in-memory fakes for KV and R2 — see `tests/helpers.ts`.

Network is always mocked. No test may make a real request to Cloudflare or to a
third-party site.

## Code style

- Match the existing layout and naming in the file you touch.
- Keep imports explicit and consistent with the current ESM setup (`.js`
  extensions on relative imports).
- Prefer small, targeted changes over broad refactors.
- Comment the *why* — a non-obvious tradeoff, a workaround, a limit — not the
  what.
- Update the README and CHANGELOG when setup, behavior, or response shapes
  change.

## Pull requests

1. Create a branch from `main`.
2. Make the smallest change that resolves the issue.
3. Run `npm run type-check && npm test`.
4. Update docs if setup, behavior, or API usage changed.
5. Open a PR with a clear summary, linked issue, and test notes.
