/**
 * `POST /fetch` — the REST twin of the `web_fetch` MCP tool.
 *
 * Same core, same defaults, so an agent that speaks plain HTTP instead of MCP
 * gets identical behaviour.
 */

import { Hono } from "hono";
import { FetchPageError } from "../lib/fetch-page.js";
import { webFetch } from "../lib/web-fetch.js";
import type { AppEnv, FetchRequestBody } from "../types.js";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "Invalid JSON body", status: 400 }, 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return c.json({ error: "Missing required field: url", status: 400 }, 400);
  }

  try {
    const result = await webFetch(c.env, body as unknown as FetchRequestBody);
    return c.json(result);
  } catch (err) {
    if (err instanceof FetchPageError) {
      return c.json({ error: err.message, status: err.status }, err.status as 400);
    }
    return c.json(
      { error: err instanceof Error ? err.message : "Fetch failed", status: 502 },
      502,
    );
  }
});

export default app;
