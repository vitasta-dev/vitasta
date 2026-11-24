/**
 * A published client library's own API version: a generated constants class in a
 * library module (public static final String VERSION = "2026-10") that the repo builds no URL with; its users do
 * (/admin/api/{VERSION}/graphql.json, per the README). The file itself may name no provider, so the evidence is the
 * module's: its manifest (artifact or package name, description) or its README names the provider. Then a constant
 * whose name says version, holding a value in that provider's version format, is the library's default version:
 * "possible", since no URL here uses it. Published modules only (not an app: a war, a private package).
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PROVIDERS } from "../providers.js";
import type { Usage } from "../types.js";

const read = (p: string, max = 200_000): string | undefined => {
  try {
    const s = statSync(p);
    return s.isFile() && s.size <= max ? readFileSync(p, "utf8") : undefined;
  } catch {
    return undefined;
  }
};
const MANIFEST = /(?:^|\/)(?:pom\.xml|build\.gradle(?:\.kts)?|package\.json|[\w.-]+\.gemspec|setup\.py|pyproject\.toml|[\w.-]+\.csproj|composer\.json)$/;
/** A manifest that publishes a library (not an application, not a private package) */
function published(name: string, text: string): boolean {
  if (name.endsWith("pom.xml")) return !/<packaging>\s*(?:war|pom|ear)\s*<\/packaging>/.test(text);
  if (/build\.gradle/.test(name)) return /maven-publish|java-library|`?publishing\s*\{/.test(text);
  if (name.endsWith("package.json")) return !/"private"\s*:\s*true/.test(text) && /"name"\s*:/.test(text);
  if (name.endsWith(".csproj")) return !/<IsPackable>\s*false/i.test(text) && (/<PackageId>|<IsPackable>\s*true|GeneratePackageOnBuild/i.test(text));
  if (name.endsWith("composer.json")) return /"type"\s*:\s*"library"/.test(text);
  return true;
}

export function libraryVersionConstUsages(root: string, files: { path: string; rel: string; lang: Usage["lang"] }[], manifests: string[], found: Usage[], isTest: (rel: string) => boolean): Usage[] {
  const out: Usage[] = [];
  const have = new Set(found.filter((u) => u.apiVersion).map((u) => `${u.file}|${u.line}`));
  for (const abs of manifests.filter((m) => MANIFEST.test(m) && !/\/node_modules\//.test(m)).slice(0, 300)) {
    const text = read(abs);
    if (!text || !published(abs, text)) continue;
    const dir = dirname(abs);
    const readme = ["README.md", "README.adoc", "README.rst", "README"].map((n) => read(join(dir, n), 400_000)).find(Boolean) ?? "";
    // the manifest's own description of the module (not its dependency list, which names every SDK it uses)
    const own = (abs.endsWith("pom.xml") ? (text.split(/<dependencies>/)[0] ?? "") : text.replace(/"(?:dev|peer)?[dD]ependencies"\s*:\s*\{[^}]*\}/g, "")) + "\n" + readme.slice(0, 20_000);
    for (const p of PROVIDERS) {
      if (!p.versionToken || !p.versionEvidence || !p.versionEvidence.test(own)) continue;
      const tok = p.versionToken.source.replace(/^\^/, "").replace(/\$$/, "");
      const re = new RegExp(`^[ \\t]*(?:(?:public|static|final|const|readonly|export|internal|private|protected)\\s+)*(?:[\\w<>?]+\\s+)?((?:[A-Za-z_$]\\w*?)?(?:VERSION|Version|version)\\w*)\\s*(?::\\s*[\\w<>]+\\s*)?[:=]\\s*["'\`](${tok})["'\`]`, "m");
      const relDir = relative(root, dir);
      for (const f of files) {
        if ((relDir && !f.rel.startsWith(relDir + "/")) || isTest(f.rel)) continue;
        const src = read(f.path);
        if (!src || !/version/i.test(src)) continue;
        const lines = src.split("\n");
        lines.forEach((l, i) => {
          const m = re.exec(l);
          if (!m || have.has(`${f.rel}|${i + 1}`)) return;
          have.add(`${f.rel}|${i + 1}`);
          out.push({
            provider: p.id, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `const: ${m[2]}`, confidence: "possible",
            snippet: l.trim().slice(0, 200),
            reason: `${m[1]} is the API version of the published ${relative(root, abs)} (a ${p.id} client by its manifest or README); no URL in this repo uses it`,
          });
        });
      }
    }
  }
  return out;
}
