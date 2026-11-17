/**
 * Escaping for text that comes from scanned repos (file names, model strings, snippets, manifest versions) or from
 * a repo's own .vitasta.yml (titles, replacements), so it can't add links, images, HTML or break tables in reports
 * that GitHub renders.
 */

const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n\u2028\u2029]+/g, " ");

/** Inline code span that holds any text, backticks included. Use `cell` inside table rows. */
export function code(s: unknown): string {
  const t = oneLine(s);
  const run = Math.max(0, ...(t.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(run + 1);
  const pad = t.startsWith("`") || t.endsWith("`") || t === "" ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/** Plain text with markdown and HTML neutralised. */
export function text(s: unknown): string {
  return oneLine(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]()#!|~])/g, "\\$1");
}

/** A table cell: pipes would end the cell even inside a code span. */
export const cell = (s: string) => s.replace(/\|/g, "\\|");

/** Fenced code block whose fence can't be closed by the content. */
export function fence(s: unknown): string {
  const t = String(s ?? "");
  const run = Math.max(2, ...(t.match(/`{3,}/g) ?? []).map((m) => m.length));
  const f = "`".repeat(run + 1);
  return `${f}\n${t}\n${f}`;
}

/** A link only if it's a plain http(s) URL; anything else is shown as text. */
export function url(s: unknown): string {
  const t = oneLine(s);
  return /^https?:\/\/[^\s<>"'`]+$/.test(t) ? `<${t}>` : text(t);
}
