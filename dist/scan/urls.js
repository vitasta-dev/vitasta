import { PROVIDERS, matchUrl, urlVersionOf } from "../providers.js";
export const STRING_NODES = {
    ts: ["string", "template_string"],
    js: ["string", "template_string"],
    py: ["string"],
    java: ["string_literal", "text_block"],
    rb: ["string"],
    // v10: PHP single- and double-quoted strings ("…/v19.0/{$pageId}/feed"), Go and C# strings
    php: ["string", "encapsed_string"],
    go: ["interpreted_string_literal", "raw_string_literal"],
    cs: ["string_literal", "verbatim_string_literal", "interpolated_string_expression"],
};
const INTERPOLATION = new Set(["template_substitution", "interpolation"]);
/** The string's text, with interpolated parts as "{?}" and without its quotes */
function stringText(node) {
    let out = "";
    let at = node.startIndex;
    const walk = (n) => {
        for (const c of n.children) {
            if (!c)
                continue;
            if (INTERPOLATION.has(c.type)) {
                out += node.text.slice(at - node.startIndex, c.startIndex - node.startIndex) + "{?}";
                at = c.endIndex;
            }
            else if (c.childCount)
                walk(c);
        }
    };
    walk(node);
    out += node.text.slice(at - node.startIndex);
    return out.replace(/^[a-zA-Z]{0,3}("""|'''|["'`])/, "").replace(/("""|'''|["'`])$/, "");
}
/** Providers whose version path is theirs alone, so it counts without a host (e.g. Shopify's /admin/api/2026-04/) */
const standalone = () => PROVIDERS.filter((p) => p.urlVersion && p.urlVersionStandsAlone);
export function urlVersionUsages(tree, file, lang, source, found) {
    const types = STRING_NODES[lang];
    if (!types)
        return [];
    // v13: per line (a call and its URL string on one line are one place); other places with the same version count too
    const covered = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.provider}|${u.apiVersion.split(": ").pop()}|${u.line}`));
    const lines = source.split("\n");
    const out = [];
    const seen = new Set();
    for (const node of tree.rootNode.descendantsOfType(types)) {
        if (!node)
            continue;
        // A string inside a template's substitution is reached on its own; a Python docstring is prose
        if (lang === "py" && node.parent?.type === "expression_statement")
            continue;
        // A config placeholder's default (Spring @Value("${graph.url:https://graph.facebook.com/v13.0}"), ${VAR:-…}) is
        // the URL the app uses when nothing sets the key
        const raw = stringText(node);
        const text = /^\$\{[\w.\-\[\]]+:-?([^{}]*)\}$/.exec(raw)?.[1] ?? raw;
        if (text.length > 2000 || !/\/v?\d/.test(text))
            continue;
        // A base URL often ends at the version ("…/v18.0"), and version patterns expect a "/" after it
        // v14: a part put straight after the version (`…/v21.0${resource}`) starts the next path segment
        const probe = text.replace(/(\d)\{\?\}/g, "$1/{?}") + "/";
        let provider;
        let version;
        const hit = /(^|[/.{])[a-z0-9-]+\.[a-z]{2,}/i.test(text) ? matchUrl(probe) : undefined;
        if (hit?.provider.urlVersion) {
            provider = hit.provider;
            version = urlVersionOf(hit.provider, probe);
        }
        else if (!hit) {
            provider = standalone().find((p) => p.urlVersion.test(probe));
            version = provider && urlVersionOf(provider, probe);
            // v7: a versioned URL on a host that counts only with a version (www.facebook.com/v19.0/dialog/oauth)
            if (!provider) {
                const host = /^[a-z][a-z0-9+.-]*:\/\/([^/:?#]+)/i.exec(text)?.[1]?.toLowerCase();
                provider = host ? PROVIDERS.find((p) => p.urlVersion && p.versionOnlyHosts?.includes(host)) : undefined;
                version = provider && urlVersionOf(provider, probe);
            }
        }
        if (!provider || !version)
            continue;
        const key = `${provider.id}|${version}`;
        const line = node.startPosition.row + 1;
        if (covered.has(`${key}|${line}`) || seen.has(`${key}|${line}`))
            continue;
        seen.add(`${key}|${line}`);
        out.push({
            provider: provider.id, kind: "version-pin", lang, file, line, apiVersion: `url: ${version}`,
            confidence: "likely", snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
        });
    }
    return out;
}
