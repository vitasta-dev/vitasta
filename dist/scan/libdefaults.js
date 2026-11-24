/**
 * v12: library defaults. A library that calls a versioned API without the app naming the version
 * (omniauth-facebook, Laravel Socialite, ASP.NET Core's AddFacebook(), whatsapp-api-js, messaging-api-messenger) pins
 * the version its own release ships with. The version comes from the nearest lockfile, or the manifest's range; the
 * library's default for that release comes from src/data/library-defaults.json (read from each library's source).
 * Reported at the place the app uses the library, unless the app overrides the version there.
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const DATA = createRequire(import.meta.url)("../data/library-defaults.json");
const num = (v) => v.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
const cmp = (a, b) => {
    const x = num(a);
    const y = num(b);
    for (let i = 0; i < 3; i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
};
const read = (p) => {
    try {
        return statSync(p).isFile() && statSync(p).size <= 5_000_000 ? readFileSync(p, "utf8") : undefined;
    }
    catch {
        return undefined;
    }
};
/** The installed (or minimum required) version of a package, from the nearest lockfile or manifest at or above dir */
export function installedVersion(root, dir, lib, csprojs) {
    const esc = lib.package.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    for (let d = dir;; d = dirname(d)) {
        const at = (f) => read(join(root, d, f));
        if (lib.ecosystem === "gem") {
            const lock = at("Gemfile.lock");
            const m = lock && new RegExp(`^\\s{4}${esc} \\(([\\d.]+)`, "m").exec(lock);
            if (m)
                return { version: m[1], from: join(d, "Gemfile.lock") };
            const gem = at("Gemfile");
            const g = gem && new RegExp(`gem\\s+["']${esc}["']\\s*,\\s*["'][~>=\\s]*([\\d.]+)`).exec(gem);
            if (g)
                return { version: g[1], from: join(d, "Gemfile") };
        }
        else if (lib.ecosystem === "npm") {
            const lock = at("package-lock.json");
            const m = lock && new RegExp(`"node_modules/${esc}"\\s*:\\s*\\{[^}]*?"version"\\s*:\\s*"([\\d.]+)`).exec(lock);
            if (m)
                return { version: m[1], from: join(d, "package-lock.json") };
            for (const name of ["yarn.lock", "pnpm-lock.yaml"]) {
                const yarn = at(name);
                const y = yarn && (new RegExp(`(?:^|\\n)"?${esc}@[^\\n]*\\n\\s+version:?\\s*"?([\\d.]+)`).exec(yarn) ?? new RegExp(`/${esc}@([\\d.]+)`).exec(yarn));
                if (y)
                    return { version: y[1], from: join(d, name) };
            }
            const pkg = at("package.json");
            const p = pkg && new RegExp(`"${esc}"\\s*:\\s*"[~^>=\\s]*([\\d.]+)`).exec(pkg);
            if (p)
                return { version: p[1], from: join(d, "package.json") };
        }
        else if (lib.ecosystem === "composer") {
            const lock = at("composer.lock");
            const m = lock && new RegExp(`"name"\\s*:\\s*"${esc}"\\s*,\\s*"version"\\s*:\\s*"v?([\\d.]+)`).exec(lock);
            if (m)
                return { version: m[1], from: join(d, "composer.lock") };
            const json = at("composer.json");
            const c = json && new RegExp(`"${esc}"\\s*:\\s*"[~^>=\\s]*v?([\\d.]+)`).exec(json);
            if (c)
                return { version: c[1], from: join(d, "composer.json") };
        }
        else if (lib.ecosystem === "go") {
            // go.mod: a require line (single or in a block), version without its leading v; a replace isn't followed
            const mod = at("go.mod");
            const m = mod && new RegExp(`^[ \\t]*(?:require\\s+)?${esc}\\s+v(\\d+\\.\\d+\\.\\d+)`, "m").exec(mod);
            if (m)
                return { version: m[1], from: join(d, "go.mod") };
        }
        else if (lib.ecosystem === "maven") {
            // A group whose artifacts share one version (versionGroup): any artifact of it, or its BOM, in pom.xml (a
            // ${property} resolved in this pom or the ones above it) or Gradle (build files, gradle/libs.versions.toml)
            const [group, artifact] = lib.package.split(":");
            const g = (lib.versionGroup ?? group).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
            const a = lib.versionGroup ? "[\\w.-]+" : artifact.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
            const pom = at("pom.xml");
            const pm = pom && new RegExp(`<groupId>\\s*${g}\\s*</groupId>\\s*<artifactId>\\s*${a}\\s*</artifactId>\\s*<version>\\s*([^<\\s]+)\\s*</version>`).exec(pom);
            if (pm) {
                let v = pm[1];
                const prop = /^\$\{([\w.-]+)\}$/.exec(v);
                if (prop) {
                    v = "";
                    for (let e = d;; e = dirname(e)) {
                        const t = read(join(root, e, "pom.xml"));
                        const pv = t && new RegExp(`<${prop[1].replace(/[.-]/g, "\\$&")}>\\s*([\\d][\\w.-]*)\\s*</`).exec(t);
                        if (pv) {
                            v = pv[1];
                            break;
                        }
                        if (e === "." || e === "" || e === dirname(e))
                            break;
                    }
                }
                if (/^\d+\.\d+/.test(v))
                    return { version: v, from: join(d, "pom.xml") };
            }
            for (const name of ["build.gradle", "build.gradle.kts", "gradle/libs.versions.toml"]) {
                const t = at(name);
                const gm = t && (new RegExp(`["']${g}:${a}:(\\d[\\w.-]*)["']`).exec(t) ?? new RegExp(`\\b(?:spring[-_]?ai|springAi)(?:[-_]?[Vv]ersion)?\\s*=\\s*["'](\\d[\\w.-]*)["']`).exec(group === "org.springframework.ai" ? t : ""));
                if (gm)
                    return { version: gm[1], from: join(d, name) };
            }
        }
        else if (lib.ecosystem === "pypi") {
            // v15: Python lockfiles (uv, Poetry, Pipenv), then requirements files and pyproject.toml
            const name = lib.package.replace(/[-_.]+/g, "[-_.]");
            for (const lockName of ["uv.lock", "poetry.lock"]) {
                const lock = at(lockName);
                const m = lock && new RegExp(`\\[\\[package\\]\\]\\s*\\nname\\s*=\\s*"${name}"\\s*\\nversion\\s*=\\s*"([\\d.]+)`, "i").exec(lock);
                if (m)
                    return { version: m[1], from: join(d, lockName) };
            }
            const pipenv = at("Pipfile.lock");
            const pv = pipenv && new RegExp(`"${name}"\\s*:\\s*\\{[^}]*?"version"\\s*:\\s*"==([\\d.]+)`, "i").exec(pipenv);
            if (pv)
                return { version: pv[1], from: join(d, "Pipfile.lock") };
            let names = [];
            try {
                names = readdirSync(join(root, d)).filter((n) => /^requirements[\w.-]*\.txt$/i.test(n));
            }
            catch {
                /* none */
            }
            for (const n of [...names, "pyproject.toml"]) {
                const t = at(n);
                const r = t && new RegExp(`^[ \\t]*["']?${name}(?:\\[[^\\]]*\\])?\\s*(?:===?|~=|>=|\\^|=\\s*["'][~^>=]*)\\s*([\\d.]+)`, "im").exec(t);
                if (r)
                    return { version: r[1], from: join(d, n) };
            }
        }
        else if (lib.ecosystem === "nuget" && csprojs) {
            for (const c of csprojs) {
                const m = new RegExp(`Include\\s*=\\s*"${esc}"\\s+Version\\s*=\\s*"([\\d.]+)`).exec(c.text);
                if (m)
                    return { version: m[1], from: c.path };
            }
            return undefined;
        }
        if (d === "." || d === "" || d === "/")
            break;
    }
    return undefined;
}
/** .csproj files under root (bounded), only read when a C# file uses a NuGet-based library */
function csprojTexts(root) {
    const out = [];
    const walk = (d, depth) => {
        if (depth > 6 || out.length > 200)
            return;
        let names = [];
        try {
            names = readdirSync(join(root, d));
        }
        catch {
            return;
        }
        for (const n of names) {
            if (n === "node_modules" || n === ".git" || n === "bin" || n === "obj")
                continue;
            const rel = d ? join(d, n) : n;
            if (/\.csproj$/i.test(n))
                out.push({ path: rel, text: read(join(root, rel)) ?? "" });
            else {
                try {
                    if (statSync(join(root, rel)).isDirectory())
                        walk(rel, depth + 1);
                }
                catch {
                    /* skip */
                }
            }
        }
    };
    walk("", 0);
    return out;
}
export function libraryDefaultUsages(root, files) {
    const out = [];
    const csprojs = files.some((f) => f.lang === "cs" && /\.AddFacebook\s*\(/.test(f.source)) ? csprojTexts(root) : [];
    const pinned = new Set();
    for (const lib of DATA.libraries) {
        const use = new RegExp(lib.use);
        const override = new RegExp(lib.override);
        // v14: a word the file must contain (passport-facebook for a bare `new Strategy(`), and a setting that counts
        // anywhere in the repo (fbgraph's setVersion in a shared module)
        const needs = lib.needs ? new RegExp(lib.needs) : undefined;
        if (lib.overrideRepo && files.some((f) => new RegExp(lib.overrideRepo).test(f.source)))
            continue;
        for (const f of files) {
            if (!lib.lang.includes(f.lang) || f.source.length > 2_000_000 || !use.test(f.source) || (needs && !needs.test(f.source)))
                continue;
            const lines = f.source.split("\n");
            const i = lines.findIndex((l) => use.test(l) && !/^\s*(\/\/|#|\*)/.test(l));
            if (i < 0)
                continue;
            // The app sets the version itself near the use (the explicit version is reported by the other rules)
            if (override.test(lines.slice(Math.max(0, i - 3), i + 12).join("\n")))
                continue;
            const inst = installedVersion(root, dirname(f.rel) || ".", lib, csprojs);
            if (!inst)
                continue;
            const found = lib.ranges.find((x) => cmp(inst.version, x.from) >= 0 && cmp(inst.version, x.below) < 0);
            if (!found)
                continue;
            // v15: a library whose API version is its own major.minor (Meta's Business SDKs: 21.0.3 calls v21.0)
            const [maj, min] = num(inst.version);
            const r = { ...found, version: found.fromPackage ? `v${maj}.${min}` : found.version };
            const why = `${lib.package} ${inst.version} (${inst.from}) calls ${r.version} by default (${lib.source.replace("<tag>", r.tag.split(",")[0].trim())})`;
            out.push({
                provider: lib.provider, kind: "version-pin", lang: f.lang, file: f.rel, line: i + 1, apiVersion: `default: ${r.version}`, confidence: "likely",
                snippet: lines[i].trim().slice(0, 200), reason: why,
            });
            // v13: the lockfile / manifest / csproj line that pins the library is a place a fix changes too
            const manifest = inst.from.replace(/^\.\//, "");
            if (!pinned.has(manifest)) {
                pinned.add(manifest);
                const ml = (read(join(root, manifest)) ?? "").split("\n");
                // (Maven: the line that holds the version, a <property> or the dependency's <version>; the coordinates never
                // appear as one string in a pom)
                const row = lib.ecosystem === "maven"
                    ? ml.findIndex((l) => l.includes(`>${inst.version}<`) || l.includes(`:${inst.version}`))
                    : ml.findIndex((l) => l.includes(lib.package));
                if (row >= 0) {
                    out.push({
                        provider: lib.provider, kind: "version-pin", lang: "config", file: manifest, line: row + 1, apiVersion: `default: ${r.version}`, confidence: "likely",
                        snippet: ml[row].trim().slice(0, 200), reason: why,
                    });
                }
            }
        }
    }
    return out;
}
