import { describe, it, expect } from "vitest";
import { htmlToMarkdown, decodeEntities, tokenize } from "../src/lib/html-to-markdown.js";

const BASE = "https://example.com/docs/page";

function md(html: string): string {
  return htmlToMarkdown(html, BASE).markdown;
}

describe("tokenize", () => {
  it("does not treat markup inside <script> as tags", () => {
    const tokens = [...tokenize('<p>a</p><script>if (x < 1) { y("</p>") }</script><p>b</p>')];
    const openTags = tokens.filter((t) => t.kind === "open").map((t) => (t as { tag: string }).tag);
    expect(openTags).toEqual(["p", "script", "p"]);
  });

  it("ignores comments and doctypes", () => {
    const tokens = [...tokenize("<!DOCTYPE html><!-- <p>hidden</p> --><p>real</p>")];
    const openTags = tokens.filter((t) => t.kind === "open").map((t) => (t as { tag: string }).tag);
    expect(openTags).toEqual(["p"]);
  });

  it("handles > inside a quoted attribute value", () => {
    const tokens = [...tokenize('<a href="/a?x=1&gt;2" title="a > b">link</a>')];
    const open = tokens.find((t) => t.kind === "open") as { attrs: Record<string, string> };
    expect(open.attrs.title).toBe("a > b");
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities", () => {
    expect(decodeEntities("a &amp; b &#65; &#x42;")).toBe("a & b A B");
  });

  it("leaves unknown entities alone", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings and paragraphs", () => {
    expect(md("<h1>Title</h1><p>Body text.</p>")).toBe("# Title\n\nBody text.");
  });

  it("drops script, style and nav chrome", () => {
    const out = md(
      "<nav>Home About</nav><style>.a{color:red}</style><script>var x=1</script><p>Real content</p><footer>© 2026</footer>",
    );
    expect(out).toBe("Real content");
  });

  it("absolutises relative links against the page URL", () => {
    expect(md('<p><a href="../other">link</a></p>')).toBe("[link](https://example.com/other)");
  });

  it("skips in-page anchors and javascript handlers but keeps their text", () => {
    expect(md('<p><a href="#top">top</a> and <a href="javascript:void(0)">js</a></p>')).toBe(
      "top and js",
    );
  });

  it("keeps images that carry alt text and drops decorative ones", () => {
    const out = md('<p><img src="/a.png" alt="A chart"><img src="/spacer.gif" alt=""></p>');
    expect(out).toBe("![A chart](https://example.com/a.png)");
  });

  it("preserves code blocks verbatim", () => {
    const out = md("<pre><code>const a = 1;\n  const b = 2;</code></pre>");
    expect(out).toBe("```\nconst a = 1;\n  const b = 2;\n```");
  });

  it("renders ordered and unordered lists with numbering", () => {
    expect(md("<ol><li>one</li><li>two</li></ol>")).toBe("1. one\n2. two");
    expect(md("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });

  it("prefers <main> content over surrounding page furniture", () => {
    const out = md(
      "<body><div>Sidebar junk</div><main><h2>Real</h2><p>Content</p></main><div>More junk</div></body>",
    );
    expect(out).toBe("## Real\n\nContent");
  });

  it("extracts the document title without emitting it as body text", () => {
    const result = htmlToMarkdown("<head><title>My Page</title></head><body><p>Hi</p></body>", BASE);
    expect(result.title).toBe("My Page");
    expect(result.markdown).toBe("Hi");
  });

  it("decodes entities in body text", () => {
    expect(md("<p>Tom &amp; Jerry &mdash; &quot;friends&quot;</p>")).toBe(
      'Tom & Jerry — "friends"',
    );
  });

  it("reports visible text length, ignoring markup syntax", () => {
    // textLength drives the escalation decision, so it must not be inflated by
    // the markdown characters the converter itself adds.
    const result = htmlToMarkdown("<h1>abc</h1>", BASE);
    expect(result.textLength).toBe(3);
  });

  it("survives unclosed tags without hanging or throwing", () => {
    expect(() => md("<div><p>unclosed <b>bold")).not.toThrow();
    expect(md("<div><p>unclosed <b>bold")).toContain("unclosed");
  });
});
