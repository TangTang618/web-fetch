/**
 * MCP over Streamable HTTP.
 *
 * Stateless by design: every POST carries a complete JSON-RPC message and gets
 * a complete response, with no session to track and no Durable Object to pay
 * for.  That's all this server needs — it has no server-initiated messages, so
 * `GET /mcp` (the SSE listening channel) correctly returns 405.
 *
 * Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
 */

import {
  availableTools,
  errorResponse,
  findTool,
  isToolAvailable,
  assertUrlAllowed,
  unavailableReason,
  type ToolResponse,
} from "./tools.js";
import type { Env } from "../types.js";

export const SERVER_NAME = "web-fetch";
export const SERVER_VERSION = "3.0.0";

/** Protocol revisions this server speaks, newest first. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0] as string;

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

const INSTRUCTIONS = [
  "Reads web pages, including JavaScript-rendered ones.",
  "",
  "Prefer web_fetch with a `query` argument: it returns only the passages of the page that bear",
  "on your question, which is far cheaper than reading an entire page and usually more accurate.",
  "Use compress:\"off\" when you need the page verbatim.",
].join("\n");

/**
 * Handle one JSON-RPC message. Returns `null` for notifications, which get an
 * HTTP 202 with no body.
 */
export async function handleRpc(
  env: Env,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return isNotification ? null : fail(id, INVALID_REQUEST, "Malformed JSON-RPC request");
  }

  const method = message.method;

  // Notifications: acknowledged, never answered.
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      return ok(id, initializeResult(message.params));

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: availableTools(env).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });

    case "tools/call":
      return ok(id, await callTool(env, message.params));

    // Declared-capability-free methods still get a valid empty answer, so a
    // client that probes them doesn't treat the server as broken.
    case "resources/list":
      return ok(id, { resources: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });

    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

function initializeResult(params: Record<string, unknown> | undefined): unknown {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
  // Echo the client's version when we speak it; otherwise offer our latest and
  // let the client decide whether it can proceed.
  const protocolVersion =
    requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
      ? requested
      : LATEST_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

async function callTool(
  env: Env,
  params: Record<string, unknown> | undefined,
): Promise<ToolResponse> {
  const name = typeof params?.name === "string" ? params.name : "";
  const args =
    params?.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};

  const tool = findTool(name);
  if (!tool) {
    return errorResponse(`Unknown tool: ${name || "(missing name)"}`);
  }
  if (!isToolAvailable(tool, env)) {
    return errorResponse(unavailableReason(tool));
  }

  // SSRF check happens here as well as inside each backend: a tool must not be
  // able to reach a private address just because its backend forgot to look.
  const blocked = await assertUrlAllowed(args);
  if (blocked) return errorResponse(blocked);

  try {
    return await tool.handler(env, args);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : `${name} failed`);
  }
}

/**
 * Handle a POST body that is either one JSON-RPC message or a batch of them.
 *
 * Batching was removed in protocol revision 2025-06-18 but older clients still
 * send arrays, and answering them costs almost nothing.
 */
export async function handleMessage(
  env: Env,
  payload: unknown,
): Promise<{ status: number; body: unknown | null }> {
  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return { status: 400, body: fail(null, INVALID_REQUEST, "Empty batch") };
    }
    const responses: JsonRpcResponse[] = [];
    for (const item of payload) {
      const response = await handleRpc(env, item as JsonRpcRequest);
      if (response) responses.push(response);
    }
    return responses.length === 0
      ? { status: 202, body: null }
      : { status: 200, body: responses };
  }

  if (!payload || typeof payload !== "object") {
    return { status: 400, body: fail(null, PARSE_ERROR, "Request body must be a JSON object") };
  }

  const response = await handleRpc(env, payload as JsonRpcRequest);
  return response === null ? { status: 202, body: null } : { status: 200, body: response };
}

export const errorCodes = {
  PARSE_ERROR,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  INVALID_PARAMS,
  INTERNAL_ERROR,
};
