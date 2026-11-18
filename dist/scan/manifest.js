import { readFile } from "node:fs/promises";
import { basename, relative } from "node:path";
import { PROVIDERS } from "../providers.js";
/** Read every manifest and return the provider SDKs the repo depends on (layer 0: proof of dependency). */
export async function readSdkDependencies(root, manifests) {
    const out = [];
    for (const file of manifests) {
        let text;
        try {
            text = await readFile(file, "utf8");
        }
        catch {
            continue;
        }
        const rel = relative(root, file);
        const name = basename(file);
        if (name === "package.json")
            out.push(...fromPackageJson(text, rel));
        else if (name === "pom.xml")
            out.push(...fromPom(text, rel));
        else if (name.startsWith("build.gradle") || name === "libs.versions.toml")
            out.push(...fromGradle(text, rel));
        else if (name === "go.mod")
            out.push(...fromList(text, rel, "go", (pkg) => new RegExp(`^\\s*(?:require\\s+)?${escape(pkg)}(?:/v\\d+)?\\s+(v[\\w.\\-+]+)`, "m")));
        else if (name === "Gemfile" || name.endsWith(".gemspec") || name === "Gemfile.lock")
            out.push(...fromList(text, rel, "rb", (pkg) => new RegExp(`(?:gem|add_(?:runtime_)?dependency)\\s*\\(?\\s*["']${escape(pkg)}["'](?:\\s*,\\s*["']([^"']+)["'])?|^\\s{4}${escape(pkg)} \\(([^)]+)\\)`, "m")));
        else if (name === "composer.json")
            out.push(...fromList(text, rel, "php", (pkg) => new RegExp(`"${escape(pkg)}"\\s*:\\s*"([^"]+)"`)));
        else if (name.endsWith(".csproj") || name === "packages.config" || name === "Directory.Packages.props")
            out.push(...fromList(text, rel, "cs", (pkg) => new RegExp(`(?:Include|id)="${escape(pkg)}"(?:[^>]*?Version="([^"]+)")?`, "i")));
        else
            out.push(...fromPython(text, rel));
    }
    return dedupe(out);
}
function fromPackageJson(text, manifest) {
    let pkg;
    try {
        pkg = JSON.parse(text);
    }
    catch {
        return [];
    }
    const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
    };
    const out = [];
    for (const p of PROVIDERS) {
        for (const pkgName of p.packages.ts ?? []) {
            if (deps[pkgName])
                out.push({ provider: p.id, lang: "ts", name: pkgName, version: deps[pkgName], manifest });
        }
    }
    return out;
}
function fromPython(text, manifest) {
    const out = [];
    for (const p of PROVIDERS) {
        for (const pkgName of p.packages.py ?? []) {
            // matches: openai==1.2.3, openai>=1, "openai>=1.0", openai = "^1.0", anthropic[bedrock]
            const re = new RegExp(`(^|["'\\s,\\[])${escape(pkgName)}(\\[[^\\]]*\\])?\\s*(?:[=<>!~^]=?\\s*["']?([0-9][^"',\\s;]*)|=\\s*["']([^"']+)["'])?`, "mi");
            const m = re.exec(text);
            if (m)
                out.push({ provider: p.id, lang: "py", name: pkgName, version: m[3] ?? m[4], manifest });
        }
    }
    return out;
}
function fromPom(text, manifest) {
    const out = [];
    for (const p of PROVIDERS) {
        for (const coord of p.packages.java ?? []) {
            const [group, artifact] = coord.split(":");
            const re = new RegExp(`<groupId>\\s*${escape(group)}\\s*</groupId>\\s*<artifactId>\\s*${escape(artifact)}\\s*</artifactId>(?:\\s*<version>\\s*([^<\\s]+)\\s*</version>)?`);
            const m = re.exec(text);
            if (m)
                out.push({ provider: p.id, lang: "java", name: coord, version: m[1], manifest });
        }
    }
    return out;
}
function fromGradle(text, manifest) {
    const out = [];
    for (const p of PROVIDERS) {
        for (const coord of p.packages.java ?? []) {
            const re = new RegExp(`["']${escape(coord)}(?::([^"'\\s]+))?["']|module\\s*=\\s*["']${escape(coord)}["']`);
            const m = re.exec(text);
            if (m)
                out.push({ provider: p.id, lang: "java", name: coord, version: m[1], manifest });
        }
    }
    return out;
}
/** Go modules, Ruby gems, Composer packages and NuGet packages: one regex per known SDK package name. */
function fromList(text, manifest, lang, re) {
    const out = [];
    for (const p of PROVIDERS) {
        for (const pkg of p.packages[lang] ?? []) {
            const m = re(pkg).exec(text);
            if (m)
                out.push({ provider: p.id, lang, name: pkg, version: m[1] ?? m[2], manifest });
        }
    }
    return out;
}
function dedupe(list) {
    const seen = new Set();
    return list.filter((d) => {
        const k = `${d.provider}|${d.lang}|${d.manifest}`;
        if (seen.has(k))
            return false;
        seen.add(k);
        return true;
    });
}
function escape(s) {
    return s.replace(/[.*+?^${}()|[\]\\/@-]/g, "\\$&");
}
export function langFamily(lang) {
    return lang === "js" ? "ts" : lang;
}
