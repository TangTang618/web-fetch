/**
 * Model-backed content compression.
 *
 * Returning a 200KB documentation page to an agent is worse than useless — it
 * blows the context window and buries the answer.  This layer shrinks page
 * content before it leaves the Worker, in one of two shapes:
 *
 *   - **Query-directed extraction** (a `query` was supplied): keep only the
 *     passages that bear on the question, verbatim where possible.
 *   - **Condensation** (no query): a structured digest that keeps the page's
 *     headings, key facts, code and links.
 *
 * Policy, matching the documented default (`compress: "auto"`):
 *
 *   | content size            | with query        | without query |
 *   |-------------------------|-------------------|---------------|
 *   | < COMPRESS_QUERY_MIN    | returned raw      | returned raw  |
 *   | < COMPRESS_THRESHOLD    | extracted         | returned raw  |
 *   | >= COMPRESS_THRESHOLD   | extracted         | condensed     |
 *
 * Short pages are left alone even when a query is present: below ~800 tokens
 * the whole page is cheaper to hand over than a model round-trip, and raw text
 * can't lose anything.
 *
 * Compression never fails a request.  If the model errors, times out, or isn't
 * configured, the original content is returned with a warning attached.
 */

import { chat, resolveBackend } from "./ai.js";
import type { CompressMode, Env } from "../types.js";

const DEFAULT_THRESHOLD_TOKENS = 8_000;
const DEFAULT_QUERY_MIN_TOKENS = 800;

/** Tokens of page text handed to the model per call. */
const CHUNK_TOKENS = 6_000;
/** Upper bound on chunks, so one huge page can't fan out into 50 model calls. */
const MAX_CHUNKS = 8;
/** How many chunk calls run at once. */
const CONCURRENCY = 3;
/** Output cap per chunk call. */
const MAX_OUTPUT_TOKENS = 1_500;

export type CompressOutcome = {
  content: string;
  /** Absent when the content was returned unchanged. */
  compression?: {
    model: string;
    query?: string;
    original_chars: number;
    output_chars: number;
    truncated?: boolean;
  };
  warnings: string[];
};

/**
 * Rough token estimate.
 *
 * Latin text runs about 4 characters per token; CJK is closer to 1 character
 * per token.  Counting them separately keeps the estimate honest for Chinese
 * and Japanese pages, which would otherwise be underestimated 4x and sail past
 * the compression threshold untouched.
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0xac00 && code <= 0xd7af) || // hangul
      (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    ) {
      cjk++;
    }
  }
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Split text into chunks of roughly `CHUNK_TOKENS`, preferring to break at
 * markdown headings and then at blank lines, so a chunk rarely starts
 * mid-sentence.
 */
export function chunkText(text: string, chunkTokens = CHUNK_TOKENS): string[] {
  if (estimateTokens(text) <= chunkTokens) return [text];

  // Split into blocks at headings and paragraph breaks, keeping the delimiters.
  const blocks = text.split(/\n(?=#{1,6}\s)|\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  let currentTokens = 0;

  for (const block of blocks) {
    const blockTokens = estimateTokens(block);

    // A single oversized block (e.g. a giant table) gets hard-split on lines.
    if (blockTokens > chunkTokens) {
      if (current) {
        chunks.push(current);
        current = "";
        currentTokens = 0;
      }
      for (const piece of hardSplit(block, chunkTokens)) chunks.push(piece);
      continue;
    }

    if (currentTokens + blockTokens > chunkTokens && current) {
      chunks.push(current);
      current = block;
      currentTokens = blockTokens;
    } else {
      current = current ? `${current}\n\n${block}` : block;
      currentTokens += blockTokens;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function hardSplit(block: string, chunkTokens: number): string[] {
  const out: string[] = [];
  let current = "";
  let currentTokens = 0;

  const push = () => {
    if (current) out.push(current);
    current = "";
    currentTokens = 0;
  };

  for (const line of block.split("\n")) {
    const lineTokens = estimateTokens(line);

    // A single line can itself exceed the budget — minified markup, or prose
    // with no line breaks at all. Splitting only on newlines would hand the
    // whole thing to the model in one piece, so fall back to slicing it.
    if (lineTokens > chunkTokens) {
      push();
      for (const piece of sliceByTokens(line, chunkTokens)) out.push(piece);
      continue;
    }

    if (currentTokens + lineTokens > chunkTokens && current) push();
    current = current ? `${current}\n${line}` : line;
    currentTokens += lineTokens;
  }

  push();
  return out;
}

/** Slice a single long string into pieces of at most `chunkTokens`. */
function sliceByTokens(line: string, chunkTokens: number): string[] {
  const tokens = estimateTokens(line);
  // Characters per token varies with script (~4 for Latin, ~1 for CJK), so
  // derive the ratio from this specific string rather than assuming.
  const charsPerToken = Math.max(1, line.length / Math.max(1, tokens));
  const sliceChars = Math.max(1, Math.floor(chunkTokens * charsPerToken));

  const pieces: string[] = [];
  for (let i = 0; i < line.length; i += sliceChars) {
    pieces.push(line.slice(i, i + sliceChars));
  }
  return pieces;
}

const EXTRACT_SYSTEM = [
  "You extract the parts of a web page that answer a specific question.",
  "",
  "Rules:",
  "- Copy relevant passages VERBATIM. Do not paraphrase facts, numbers, prices, versions, dates, or identifiers.",
  "- Reproduce code blocks, commands, tables and links exactly as written, keeping markdown fences.",
  "- Keep the markdown heading each passage came from, so the caller knows where it sits in the page.",
  "- Omit navigation, boilerplate, ads, cookie notices and anything unrelated to the question.",
  "- If this section of the page contains nothing relevant, reply with exactly: NOTHING_RELEVANT",
  "- Output only the extracted markdown. No preamble, no commentary, no meta-explanation.",
].join("\n");

const CONDENSE_SYSTEM = [
  "You condense a web page into a compact briefing for another AI agent.",
  "",
  "Rules:",
  "- Preserve the page's heading structure.",
  "- Keep all concrete facts verbatim: numbers, prices, versions, dates, names, identifiers.",
  "- Reproduce code blocks, commands and API signatures exactly, keeping markdown fences.",
  "- Keep links that a reader would need to follow, in markdown link syntax.",
  "- Drop navigation, boilerplate, ads, cookie notices, repeated marketing copy.",
  "- Aim for roughly a quarter of the original length, shorter if the page is mostly filler.",
  "- Output only the condensed markdown. No preamble, no commentary.",
].join("\n");

const NOTHING_RELEVANT = "NOTHING_RELEVANT";

/**
 * Decide whether to compress, and do it.  Always resolves; on any failure the
 * original content comes back with a warning.
 */
export async function compressContent(
  env: Env,
  content: string,
  opts: { mode?: CompressMode; query?: string } = {},
): Promise<CompressOutcome> {
  const mode: CompressMode = opts.mode ?? "auto";
  const query = opts.query?.trim() || undefined;
  const warnings: string[] = [];

  if (mode === "off" || !content.trim()) {
    return { content, warnings };
  }

  const tokens = estimateTokens(content);
  const threshold = intVar(env.COMPRESS_THRESHOLD, DEFAULT_THRESHOLD_TOKENS);
  const queryMin = intVar(env.COMPRESS_QUERY_MIN, DEFAULT_QUERY_MIN_TOKENS);

  if (mode === "auto") {
    const wanted = query ? tokens > queryMin : tokens > threshold;
    if (!wanted) return { content, warnings };
  }

  const backend = resolveBackend(env);
  if (backend.kind === "none") {
    warnings.push(`Compression skipped: ${backend.reason}`);
    return { content, warnings };
  }

  let chunks = chunkText(content);
  let truncated = false;
  if (chunks.length > MAX_CHUNKS) {
    chunks = chunks.slice(0, MAX_CHUNKS);
    truncated = true;
    warnings.push(
      `Page exceeded the ${MAX_CHUNKS}-chunk compression budget; only the first ` +
        `${MAX_CHUNKS} sections were processed. Use compress:"off" for the full text.`,
    );
  }

  const system = query ? EXTRACT_SYSTEM : CONDENSE_SYSTEM;
  const results = await mapChunks(env, chunks, system, query);

  const failures = results.filter((r) => !r.ok).length;
  if (failures === results.length) {
    const firstError = results.find((r) => !r.ok);
    warnings.push(
      `Compression failed, returning full content: ${
        firstError && !firstError.ok ? firstError.error : "unknown error"
      }`,
    );
    return { content, warnings };
  }
  if (failures > 0) {
    warnings.push(`${failures} of ${results.length} sections failed to compress and were dropped.`);
  }

  const kept = results
    .flatMap((r) => (r.ok ? [r.text.trim()] : []))
    .filter((text) => text && !text.includes(NOTHING_RELEVANT));

  if (kept.length === 0) {
    // The model read the page and found nothing on-topic. Say so plainly
    // rather than dumping the whole page back and pretending it's an answer.
    const message = query
      ? `No content on this page appears relevant to: ${query}`
      : "The model produced no output for this page.";
    warnings.push(`${message} Retry with compress:"off" to inspect the raw page.`);
    return { content: message, warnings };
  }

  const merged = kept.join("\n\n");

  return {
    content: merged,
    compression: {
      model: backend.model,
      query,
      original_chars: content.length,
      output_chars: merged.length,
      ...(truncated ? { truncated: true } : {}),
    },
    warnings,
  };
}

type ChunkResult = { ok: true; text: string } | { ok: false; error: string };

async function mapChunks(
  env: Env,
  chunks: string[],
  system: string,
  query: string | undefined,
): Promise<ChunkResult[]> {
  const results: ChunkResult[] = [];

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(
      batch.map(async (chunk, offset): Promise<ChunkResult> => {
        const position =
          chunks.length > 1 ? `Section ${i + offset + 1} of ${chunks.length}.\n\n` : "";
        const user = query
          ? `Question: ${query}\n\n${position}Page content:\n\n${chunk}`
          : `${position}Page content:\n\n${chunk}`;

        const res = await chat(env, [
          { role: "system", content: system },
          { role: "user", content: user },
        ], { maxTokens: MAX_OUTPUT_TOKENS });

        return res.ok ? { ok: true, text: res.text } : { ok: false, error: res.error };
      }),
    );
    results.push(...settled);
  }

  return results;
}
