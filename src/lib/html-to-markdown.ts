/**
 * HTML → Markdown conversion.
 *
 * This backs the plain-fetch fast path. It is a self-contained tokenizer
 * rather than a wrapper around the runtime's `HTMLRewriter`, for two reasons:
 * the conversion rules are the part most likely to need tuning, so they have
 * to be unit-testable outside workerd; and a portable converter keeps the door
 * open to running this core somewhere other than a Worker.
 *
 * It is deliberately not a full Readability port. It drops the obvious chrome
 * (script/style/nav/footer/aside), prefers `<main>`/`<article>` when the page
 * offers one, and converts the structural tags an LLM actually needs:
 * headings, paragraphs, lists, links, images, code, quotes and tables. Pages
 * where that isn't good enough are caught by the caller, which escalates to
 * real browser rendering — see `fetch-page.ts`.
 */

/** Elements whose entire subtree is dropped. */
const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "canvas",
  "iframe",
  "template",
  "nav",
  "footer",
  "aside",
  "head",
]);

/** Elements parsed as raw text: their content is never markup. */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

/** Elements with no closing tag. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Inline wrappers that map to a simple pair of markdown markers. */
const INLINE_MARKERS: Record<string, string> = {
  strong: "**",
  b: "**",
  em: "*",
  i: "*",
  del: "~~",
  s: "~~",
};

/** Block-level elements that just need separation around them. */
const BLOCK_TAGS = new Set(["p", "div", "section", "header", "dt", "dd", "figcaption"]);

export type ConversionResult = {
  markdown: string;
  title?: string;
  /** Visible text length, used by the caller to judge whether the page rendered. */
  textLength: number;
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: "text"; value: string }
  | { kind: "open"; tag: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; tag: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  laquo: "«",
  raquo: "»",
};

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    let value = match[2] ?? "";
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

export function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const length = html.length;

  while (i < length) {
    const lt = html.indexOf("<", i);

    if (lt === -1) {
      const text = html.slice(i);
      if (text) yield { kind: "text", value: decodeEntities(text) };
      return;
    }

    if (lt > i) {
      yield { kind: "text", value: decodeEntities(html.slice(i, lt)) };
    }

    // Comments, CDATA and doctype declarations carry nothing we want.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end === -1 ? length : end + 1;
      continue;
    }

    const isClose = html[lt + 1] === "/";
    const nameStart = lt + (isClose ? 2 : 1);
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(nameStart, nameStart + 64));

    if (!nameMatch) {
      // A bare "<" in text. Emit it and move on.
      yield { kind: "text", value: "<" };
      i = lt + 1;
      continue;
    }

    const tag = (nameMatch[0] ?? "").toLowerCase();
    const gt = findTagEnd(html, nameStart + tag.length);
    if (gt === -1) return;

    if (isClose) {
      yield { kind: "close", tag };
      i = gt + 1;
      continue;
    }

    const attrSource = html.slice(nameStart + tag.length, gt).replace(/\/$/, "");
    const selfClosing = html[gt - 1] === "/" || VOID_TAGS.has(tag);
    yield { kind: "open", tag, attrs: parseAttributes(attrSource), selfClosing };
    i = gt + 1;

    // Raw-text elements swallow everything up to their closing tag, so that
    // markup-looking content inside a <script> never reaches the converter.
    if (RAW_TEXT_TAGS.has(tag) && !selfClosing) {
      const closeIndex = findRawTextEnd(html, tag, i);
      const raw = html.slice(i, closeIndex === -1 ? length : closeIndex);
      if (raw) yield { kind: "text", value: tag === "title" ? decodeEntities(raw) : raw };
      if (closeIndex === -1) return;
      yield { kind: "close", tag };
      i = html.indexOf(">", closeIndex);
      i = i === -1 ? length : i + 1;
    }
  }
}

/** Find the `>` closing a tag, skipping any inside quoted attribute values. */
function findTagEnd(html: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function findRawTextEnd(html: string, tag: string, from: number): number {
  const pattern = new RegExp(`</${tag}\\b`, "i");
  const match = pattern.exec(html.slice(from));
  return match ? from + match.index : -1;
}

// ---------------------------------------------------------------------------
// Markdown assembly
// ---------------------------------------------------------------------------

class MarkdownBuilder {
  private parts: string[] = [];
  private textChars = 0;
  private pendingNewlines = 0;

  /** Queue blank-line separation, collapsed with whatever is already pending. */
  block(count = 2): void {
    if (this.parts.length === 0) return; // never lead with blank lines
    this.pendingNewlines = Math.max(this.pendingNewlines, count);
  }

  write(text: string, opts: { counts?: boolean } = {}): void {
    if (!text) return;
    this.flushPending();
    this.parts.push(text);
    if (opts.counts !== false) this.textChars += text.trim().length;
  }

  private flushPending(): void {
    if (this.pendingNewlines > 0) {
      this.parts.push("\n".repeat(this.pendingNewlines));
      this.pendingNewlines = 0;
    }
  }

  get textLength(): number {
    return this.textChars;
  }

  get isEmpty(): boolean {
    return this.parts.length === 0;
  }

  /** True when the last thing written ended with whitespace. */
  get endsWithSpace(): boolean {
    const last = this.parts[this.parts.length - 1];
    return last === undefined || /\s$/.test(last);
  }

  toString(): string {
    // Only newline-level tidying happens here. Runs of spaces are already
    // collapsed as inline text is written, and doing it again at this point
    // would destroy the indentation inside fenced code blocks.
    return this.parts
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
}

function resolveUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

type ListContext = { ordered: boolean; index: number };

/**
 * Convert an HTML document to Markdown.
 *
 * @param html    Raw HTML source.
 * @param baseUrl Page URL, used to absolutise relative links and images.
 */
export function htmlToMarkdown(html: string, baseUrl: string): ConversionResult {
  const out = new MarkdownBuilder();

  // Prefer the page's own main-content landmark when it has one.
  const scopeTag = /<main[\s>]/i.test(html)
    ? "main"
    : /<article[\s>]/i.test(html)
      ? "article"
      : null;

  let scopeDepth = 0;
  let skipDepth = 0;
  let preDepth = 0;
  let inTitle = false;
  let title: string | undefined;
  const listStack: ListContext[] = [];
  const linkStack: string[] = [];

  const capturing = () => (scopeTag === null || scopeDepth > 0) && skipDepth === 0;

  for (const token of tokenize(html)) {
    if (token.kind === "text") {
      if (inTitle) {
        title = (title ?? "") + token.value;
        continue;
      }
      if (!capturing()) continue;

      if (preDepth > 0) {
        out.write(token.value);
        continue;
      }

      const collapsed = token.value.replace(/\s+/g, " ");
      if (!collapsed.trim()) {
        // Keep a single separating space between inline elements, but never
        // start a line with one.
        if (collapsed === " " && !out.isEmpty && !out.endsWithSpace) {
          out.write(" ", { counts: false });
        }
        continue;
      }
      out.write(collapsed);
      continue;
    }

    if (token.kind === "open") {
      const { tag, attrs, selfClosing } = token;

      if (tag === "title") {
        inTitle = true;
        continue;
      }

      if (scopeTag && tag === scopeTag) scopeDepth++;

      if (SKIP_TAGS.has(tag)) {
        if (!selfClosing) skipDepth++;
        continue;
      }

      if (!capturing()) continue;

      openTag(tag, attrs, selfClosing);
      continue;
    }

    // token.kind === "close"
    const { tag } = token;

    if (tag === "title") {
      inTitle = false;
      continue;
    }

    if (SKIP_TAGS.has(tag)) {
      if (skipDepth > 0) skipDepth--;
      continue;
    }

    if (capturing()) closeTag(tag);

    if (scopeTag && tag === scopeTag && scopeDepth > 0) scopeDepth--;
  }

  return {
    markdown: out.toString(),
    ...(title?.replace(/\s+/g, " ").trim() ? { title: title.replace(/\s+/g, " ").trim() } : {}),
    textLength: out.textLength,
  };

  function openTag(tag: string, attrs: Record<string, string>, selfClosing: boolean): void {
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      out.block();
      out.write(`${"#".repeat(Number(heading[1]))} `, { counts: false });
      return;
    }

    switch (tag) {
      case "br":
        out.write("\n", { counts: false });
        return;
      case "hr":
        out.block();
        out.write("---", { counts: false });
        out.block();
        return;
      case "ul":
      case "ol":
        out.block();
        listStack.push({ ordered: tag === "ol", index: 0 });
        return;
      case "li": {
        const ctx = listStack[listStack.length - 1];
        const indent = "  ".repeat(Math.max(0, listStack.length - 1));
        let marker = "- ";
        if (ctx) {
          ctx.index++;
          if (ctx.ordered) marker = `${ctx.index}. `;
        }
        out.block(1);
        out.write(`${indent}${marker}`, { counts: false });
        return;
      }
      case "a": {
        const href = attrs.href;
        // In-page anchors and javascript: handlers point nowhere useful once
        // the content leaves the page.
        if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) {
          linkStack.push("");
          return;
        }
        linkStack.push(resolveUrl(href, baseUrl));
        out.write("[", { counts: false });
        return;
      }
      case "img": {
        const src = attrs.src;
        const alt = (attrs.alt ?? "").trim();
        // An image earns its place in an LLM's context only if it says
        // something; a decorative src does not.
        if (!src || !alt) return;
        out.write(`![${alt}](${resolveUrl(src, baseUrl)})`, { counts: false });
        return;
      }
      case "pre":
        preDepth++;
        out.block();
        out.write("```\n", { counts: false });
        return;
      case "code":
        if (preDepth === 0) out.write("`", { counts: false });
        return;
      case "blockquote":
        out.block();
        out.write("> ", { counts: false });
        return;
      case "table":
        out.block();
        return;
      case "tr":
        out.block(1);
        return;
      case "td":
      case "th":
        out.write(" | ", { counts: false });
        return;
      default:
        break;
    }

    const marker = INLINE_MARKERS[tag];
    if (marker) {
      out.write(marker, { counts: false });
      return;
    }

    if (BLOCK_TAGS.has(tag) && !selfClosing) {
      out.block();
    }
  }

  function closeTag(tag: string): void {
    if (/^h[1-6]$/.test(tag)) {
      out.block();
      return;
    }

    switch (tag) {
      case "ul":
      case "ol":
        listStack.pop();
        out.block();
        return;
      case "li":
        out.block(1);
        return;
      case "a": {
        const href = linkStack.pop();
        if (href) out.write(`](${href})`, { counts: false });
        return;
      }
      case "pre":
        if (preDepth > 0) preDepth--;
        out.write("\n```", { counts: false });
        out.block();
        return;
      case "code":
        if (preDepth === 0) out.write("`", { counts: false });
        return;
      case "blockquote":
      case "table":
        out.block();
        return;
      default:
        break;
    }

    const marker = INLINE_MARKERS[tag];
    if (marker) {
      out.write(marker, { counts: false });
      return;
    }

    if (BLOCK_TAGS.has(tag)) {
      out.block();
    }
  }
}
