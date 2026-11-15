import { describe, expect, it } from "vitest";
import { escapeHtml, renderMarkdown, safeLinkTarget } from "./markdown";

describe("restricted markdown renderer", () => {
  it("renders the supported subset", () => {
    const html = renderMarkdown("# Title\n\nHello **bold** and *em* with `x<y`.\n\n- one\n- two\n\n1. first\n\n> quoted\n\n```\n<b>raw</b>\n```");
    expect(html).toBe([
      "<h2>Title</h2>",
      "<p>Hello <strong>bold</strong> and <em>em</em> with <code>x&lt;y</code>.</p>",
      "<ul><li>one</li><li>two</li></ul>",
      "<ol><li>first</li></ol>",
      "<blockquote><p>quoted</p></blockquote>",
      "<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>"
    ].join("\n"));
  });

  it("never passes raw HTML through", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("allows only safe link targets", () => {
    expect(renderMarkdown("[a](https://example.org/x?y=1&z=2)")).toBe('<p><a href="https://example.org/x?y=1&amp;z=2" rel="nofollow noopener noreferrer">a</a></p>');
    expect(renderMarkdown("[mail](mailto:hi@example.org)")).toBe('<p><a href="mailto:hi@example.org">mail</a></p>');
    expect(renderMarkdown("[rel](/pages/about)")).toBe('<p><a href="/pages/about">rel</a></p>');
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html;base64,xx", "//evil.example", "vbscript:x", "java\\script:x"]) {
      expect(renderMarkdown(`[x](${bad})`)).not.toContain("<a ");
    }
  });

  it("escapes attribute-breaking characters in link text and targets", () => {
    expect(safeLinkTarget('https://example.org/"onmouseover=')).toBe('https://example.org/"onmouseover=');
    expect(renderMarkdown('[x](https://example.org/"onmouseover=)')).toContain('href="https://example.org/&quot;onmouseover="');
    expect(escapeHtml(`'"<>&`)).toBe("&#39;&quot;&lt;&gt;&amp;");
  });

  it("bounds input size", () => {
    expect(() => renderMarkdown("x".repeat(100_001))).toThrow(RangeError);
  });
});
