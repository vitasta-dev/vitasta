/**
 * Whose code a file is, when a repo keeps several AI vendors side by side. Two rules, both
 * generic: vendor names come from the scanner's providers and partner-models.json, never from a repo.
 *
 * 1. Compatible endpoints. A repo that points a provider's client at another vendor's host (Spring AI's Anthropic
 *    client at https://api.minimax.io/anthropic) is calling that vendor, not the provider: like Bedrock or Vertex.
 *    The provider's findings in that vendor's own code (a directory named after it, or a file whose name starts
 *    with it) are dropped. A gateway that passes requests through (Cloudflare, OpenRouter) isn't a vendor and
 *    keeps its findings.
 * 2. Vendor directories. In a providers/{anthropic,cohere,openai}/… layout, a value read in another vendor's
 *    directory (CohereChatOptions.getTopK()) doesn't feed this provider's request: the tracer stops there.
 *    A directory counts as a vendor's only next to at least one other vendor directory.
 */
import { vendorNames } from "../providers.js";
const VENDORS = vendorNames();
const norm = (s) => s.toLowerCase().replace(/[-_.]/g, "");
const VENDOR_NORM = new Map([...VENDORS].map((v) => [norm(v), v]));
/** Reverse-domain package roots (com/minimax/…): a company's name there says who wrote the code, not whose API it is */
const TLDISH = /^(?:com|org|net|io|ai|cn|de|co|dev|app|uk|jp|in)$/;
const segs = (rel) => rel.split("/").slice(0, -1);
/** Vendor directories of a repo: dir path → vendor, only where a sibling directory is another vendor's */
export function vendorDirs(rels) {
    const kids = new Map();
    for (const rel of rels) {
        const s = segs(rel);
        for (let i = 0; i < s.length; i++) {
            if (i > 0 && TLDISH.test(s[i - 1]))
                continue;
            const v = VENDOR_NORM.get(norm(s[i]));
            if (!v)
                continue;
            const parent = s.slice(0, i).join("/");
            if (!kids.has(parent))
                kids.set(parent, new Map());
            kids.get(parent).set(s.slice(0, i + 1).join("/"), v);
        }
    }
    const out = new Map();
    for (const m of kids.values())
        if (new Set(m.values()).size >= 2)
            for (const [d, v] of m)
                out.set(d, v);
    return out;
}
/** The vendor whose directory holds a file, if that vendor isn't the provider (and isn't the provider's own name) */
export function foreignVendorOf(rel, provider, dirs) {
    const s = segs(rel);
    for (let i = s.length; i > 0; i--) {
        const v = dirs.get(s.slice(0, i).join("/"));
        if (v)
            return norm(v) === norm(provider) ? undefined : v;
    }
    return undefined;
}
/**
 * Hosts a repo points a provider's client at that belong to another vendor: URLs whose path names the provider
 * (https://api.minimax.io/anthropic) on a host whose name is a known vendor's. Returns vendor → host.
 */
export function compatibleHosts(files, provider, providerHosts) {
    const out = new Map();
    const re = new RegExp(`https?://([A-Za-z0-9.-]+)(?::\\d+)?/[^\\s"'\`]*?\\b${provider}\\b`, "gi");
    for (const f of files) {
        if (!f.source.toLowerCase().includes(provider))
            continue;
        for (const m of f.source.matchAll(re)) {
            const host = m[1].toLowerCase();
            if (providerHosts.some((h) => host === h || host.endsWith("." + h)))
                continue;
            const labels = host.split(".");
            for (const l of labels.slice(0, -1)) {
                const v = VENDOR_NORM.get(norm(l));
                if (v && norm(v) !== norm(provider))
                    out.set(v, host);
            }
        }
    }
    return out;
}
/** A file that is a vendor's own code: a directory named after it (not a package root), or a file name starting with it */
export function fileOfVendor(rel, vendor) {
    const s = segs(rel);
    const n = norm(vendor);
    if (s.some((x, i) => norm(x) === n && !(i > 0 && TLDISH.test(s[i - 1]))))
        return true;
    // camelCase / snake_case words of the file name; a vendor is one word or a run of them (Open + AI)
    const words = (rel.split("/").pop().replace(/\.[^.]*$/, "").match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
    for (let a = 0; a < words.length; a++) {
        let run = "";
        for (let b = a; b < words.length && run.length < n.length; b++)
            if ((run += words[b]) === n)
                return true;
    }
    return false;
}
