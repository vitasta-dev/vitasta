/**
 * Version pins written in URL strings, wherever they are.
 *
 * The analyzers report a URL's API version on the HTTP call they can follow it to. Real code often hides that call:
 * a base URL in a constant or a settings field, a client's base URL, a wrapper like `deps.fetch`, a helper that
 * returns the URL, or a store host held in a variable (`https://${shop}/admin/api/2026-04/…`). A URL on a versioned
 * API's host still pins that version, so it counts on the line where it's written, like a model ID in a model
 * setting. Strings come from the syntax tree, so comments never count; Python docstrings are skipped.
 */
import type { Node, Tree } from "web-tree-sitter";
import { PROVIDERS, matchUrl, urlVersionOf, type ProviderDef } from "../providers.js";
import type { Lang, Usage } from "../types.js";

const STRING_NODES: Partial<Record<Lang, string[]>> = {
  ts: ["string", "template_string"],
  js: ["string", "template_string"],
  py: ["string"],
  java: ["string_literal", "text_block"],
};
const INTERPOLATION = new Set(["template_substitution", "interpolation"]);

/** The string's text, with interpolated parts as "{?}" and without its quotes */
function stringText(node: Node): string {
  let out = "";
  let at = node.startIndex;
  const walk = (n: Node) => {
    for (const c of n.children) {
      if (!c) continue;
      if (INTERPOLATION.has(c.type)) {
        out += node.text.slice(at - node.startIndex, c.startIndex - node.startIndex) + "{?}";
        at = c.endIndex;
      } else if (c.childCount) walk(c);
    }
  };
  walk(node);
  out += node.text.slice(at - node.startIndex);
  return out.replace(/^[a-zA-Z]{0,3}("""|'''|["'`])/, "").replace(/("""|'''|["'`])$/, "");
}

/** Providers whose version path is theirs alone, so it counts without a host (e.g. Shopify's /admin/api/2026-04/) */
const standalone = () => PROVIDERS.filter((p) => p.urlVersion && p.urlVersionStandsAlone);

export function urlVersionUsages(tree: Tree, file: string, lang: Lang, source: string, found: Usage[]): Usage[] {
  const types = STRING_NODES[lang];
  if (!types) return [];
  const covered = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.provider}|${u.apiVersion!.split(": ").pop()}`));
  const lines = source.split("\n");
  const out: Usage[] = [];
  const seen = new Set<string>();
  for (const node of tree.rootNode.descendantsOfType(types)) {
    if (!node) continue;
    // A string inside a template's substitution is reached on its own; a Python docstring is prose
    if (lang === "py" && node.parent?.type === "expression_statement") continue;
    const text = stringText(node);
    if (text.length > 2000 || !/\/v?\d/.test(text)) continue;
    // A base URL often ends at the version ("…/v18.0"), and version patterns expect a "/" after it
    const probe = text + "/";
    let provider: ProviderDef | undefined;
    let version: string | undefined;
    const hit = /(^|[/.{])[a-z0-9-]+\.[a-z]{2,}/i.test(text) ? matchUrl(probe) : undefined;
    if (hit?.provider.urlVersion) {
      provider = hit.provider;
      version = urlVersionOf(hit.provider, probe);
    } else if (!hit) {
      provider = standalone().find((p) => p.urlVersion!.test(probe));
      version = provider && urlVersionOf(provider, probe);
    }
    if (!provider || !version) continue;
    const key = `${provider.id}|${version}`;
    const line = node.startPosition.row + 1;
    if (covered.has(key) || seen.has(`${key}|${line}`)) continue;
    seen.add(`${key}|${line}`);
    out.push({
      provider: provider.id, kind: "version-pin", lang, file, line, apiVersion: `url: ${version}`,
      confidence: "likely", snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
    });
  }
  return out;
}
