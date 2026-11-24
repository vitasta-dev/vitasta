/**
 * The API version written in an SDK's import paths and namespaces (src/data/sdk-namespace-versions.json): the Google Ads
 * client libraries put it there (Google\Ads\GoogleAds\V23\Services in PHP, google.ads.googleads.v23.services in Python,
 * com.google.ads.googleads.v23.services in Java, Google.Ads.GoogleAds.V23.Services in C#, Google::Ads::GoogleAds::V23
 * in Ruby), and Python also takes it as version="v23". Every such file is a place that calls that version. One pin
 * per file and version, at its first line, the rest as alsoLines. Comments don't count.
 */
import { createRequire } from "node:module";
import type { Usage } from "../types.js";

type Rule = { provider: string; lang: string[]; re: string };
const RULES: Rule[] = (createRequire(import.meta.url)("../data/sdk-namespace-versions.json") as { rules: Rule[] }).rules;
const COMMENT = /^\s*(?:\/\/|#|\*|\/\*|--)/;

export function sdkNamespaceUsages(files: { rel: string; lang: Usage["lang"]; source: string }[], isTest: (rel: string) => boolean, found: Usage[] = []): Usage[] {
  const out: Usage[] = [];
  // (another rule already reports that version on that line)
  const have = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.file}|${u.line}|${u.apiVersion!.split(": ").pop()}`));
  for (const f of files) {
    if (f.source.length > 2_000_000) continue;
    const rules = RULES.filter((r) => r.lang.includes(f.lang));
    if (!rules.length) continue;
    const lines = f.source.split("\n");
    // provider|version → its lines
    const hits = new Map<string, number[]>();
    for (const r of rules) {
      const re = new RegExp(r.re, "g");
      lines.forEach((l, i) => {
        if (l.length > 1000 || COMMENT.test(l)) return;
        for (const m of l.matchAll(re)) {
          const v = m.slice(1).find(Boolean);
          if (!v) continue;
          const k = `${r.provider}|v${v}`;
          const at = hits.get(k) ?? [];
          if (!at.includes(i + 1)) at.push(i + 1);
          hits.set(k, at);
        }
      });
    }
    for (const [k, at] of hits) {
      const [provider, version] = k.split("|");
      at.sort((a, b) => a - b);
      if (have.has(`${f.rel}|${at[0]}|${version}`)) continue;
      out.push({
        provider, kind: "version-pin", lang: f.lang, file: f.rel, line: at[0], apiVersion: `setter: ${version}`, confidence: "likely",
        snippet: lines[at[0] - 1].trim().slice(0, 200), reason: `the SDK's own namespace names ${version}`,
        ...(at.length > 1 ? { alsoLines: at.slice(1) } : {}),
        ...(isTest(f.rel) ? { inTest: true } : {}),
      });
    }
  }
  return out;
}
