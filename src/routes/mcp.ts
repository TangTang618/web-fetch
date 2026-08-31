/**
 * `/mcp` — the Streamable HTTP transport endpoint.
 *
 * This is the surface that makes the Worker portable: any MCP client, on any
 * platform, needs nothing but this URL and an API key. No runtime to install.
 */

import { Hono } from "hono";
import { handleMessage } from "../mcp/server.js";
import type { AppEnv } from "../types.js";

const app = new Hono<AppEnv>();

/**
 * Clients advertise what they can read via `Accept`. The spec lets the server
 * answer a POST with either a single JSON object or an SSE stream; we prefer
 * plain JSON, and only fall back to SSE framing for a client that asked for
 * event-stream *without* accepting JSON.
 */
function prefersSse(accept: string | undefined): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return lower.includes("text/event-stream") && !lower.includes("application/json");
}

function sseResponse(body: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// Authentication runs in mcpAuthMiddleware, before the rate limiter.
app.post("/", async (c) => {
  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } },
      400,
    );
  }

  const { status, body } = await handleMessage(c.env, payload);

  if (body === null) {
    return c.body(null, 202);
  }

  if (prefersSse(c.req.header("Accept"))) {
    return sseResponse(body);
  }

  return c.json(body as Record<string, unknown>, status as 200);
});

/**
 * This server never initiates messages, so there is nothing to stream. The
 * spec's prescribed answer is 405.
 */
app.get("/", (c) => {
  return c.json(
    { error: "This MCP server does not offer a server-initiated stream. POST JSON-RPC instead.", status: 405 },
    405,
    { Allow: "POST, DELETE" },
  );
});

/** Stateless server: there is no session to terminate, but say so politely. */
app.delete("/", (c) => c.body(null, 204));

export default app;
