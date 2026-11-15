/**
 * Restricted Markdown subset rendered to escaped HTML. Pure and deterministic.
 *
 * Supported: `#`/`##`/`###` headings (rendered h2–h4; the page title owns h1),
 * paragraphs, `- `/`* ` and `1. ` lists, `> ` quotes, fenced ``` code blocks,
 * inline `code`, **strong**, *emphasis* and [links](url).
 *
 * Every character of source text is HTML-escaped. Raw HTML is never passed through.
 * Link targets are limited to http(s), mailto and relative URLs; anything else is
 * rendered as plain text.
 */

export const MARKDOWN_MAX_LENGTH = 100_000;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Returns the URL if it is an allowed link target, otherwise null. */
export function safeLinkTarget(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.length > 2000 || /[\s\u0000-\u001f\u007f\\]/.test(url)) return null;
  if (/^https?:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      return parsed.hostname ? url : null;
    } catch {
      return null;
    }
  }
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(url)) return url;
  if (url.startsWith("//")) return null;
  if (/^(\/|\.\/|\.\.\/|#|\?)/.test(url)) return url;
  // Bare relative path: no scheme (no colon before the first slash, ? or #).
  const head = url.split(/[/?#]/, 1)[0] ?? "";
  if (!head.includes(":") && /^[A-Za-z0-9._~%-]/.test(url)) return url;
  return null;
}

const inlinePatterns: Array<{ re: RegExp; render: (m: RegExpExecArray) => string }> = [
  { re: /`([^`\n]+)`/, render: m => `<code>${escapeHtml(m[1]!)}</code>` },
  {
    re: /\[([^\]\n]{1,500})\]\(([^()\s]{1,2000})\)/,
    render: m => {
      const target = safeLinkTarget(m[2]!);
      const text = renderInline(m[1]!);
      if (!target) return text;
      const external = /^https?:/i.test(target);
      return `<a href="${escapeHtml(target)}"${external ? ' rel="nofollow noopener noreferrer"' : ""}>${text}</a>`;
    }
  },
  { re: /\*\*([^*\n]+)\*\*/, render: m => `<strong>${renderInline(m[1]!)}</strong>` },
  { re: /\*([^*\n]+)\*/, render: m => `<em>${renderInline(m[1]!)}</em>` }
];

export function renderInline(text: string): string {
  let out = "";
  let rest = text;
  while (rest.length > 0) {
    let best: { index: number; match: RegExpExecArray; render: (m: RegExpExecArray) => string } | null = null;
    for (const pattern of inlinePatterns) {
      const match = pattern.re.exec(rest);
      if (match && (best === null || match.index < best.index)) best = { index: match.index, match, render: pattern.render };
    }
    if (!best) {
      out += escapeHtml(rest);
      break;
    }
    out += escapeHtml(rest.slice(0, best.index)) + best.render(best.match);
    rest = rest.slice(best.index + best.match[0].length);
  }
  return out;
}

export function renderMarkdown(source: string): string {
  if (typeof source !== "string") throw new TypeError("markdown source must be a string");
  if (source.length > MARKDOWN_MAX_LENGTH) throw new RangeError("markdown source too long");
  const lines = source.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(renderInline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) html.push(`<${list.kind}>${list.items.map(item => `<li>${renderInline(item)}</li>`).join("")}</${list.kind}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html.push(`<blockquote><p>${quote.map(renderInline).join("<br>")}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flushAll();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i]!)) {
        code.push(lines[i]!);
        i += 1;
      }
      html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") { flushAll(); continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1]!.length + 1;
      html.push(`<h${level}>${renderInline(heading[2]!.trim())}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d{1,6}\.\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph(); flushQuote();
      const kind = bullet ? "ul" : "ol";
      const current = list as { kind: "ul" | "ol"; items: string[] } | null;
      if (!current || current.kind !== kind) { flushList(); list = { kind, items: [] }; }
      list!.items.push((bullet ?? ordered)![1]!);
      continue;
    }
    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      flushParagraph(); flushList();
      quote.push(quoted[1]!);
      continue;
    }
    flushList(); flushQuote();
    paragraph.push(line.trim());
  }
  flushAll();
  return html.join("\n");
}
