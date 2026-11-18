/**
 * Which version of a package a place in the repo runs with: the version its lockfile pins, and the range its
 * manifest allows. Used by the compatibility check (feed/_compat.json `sdk`): some SDK versions don't know a new
 * model and handle it wrongly (an old @ai-sdk/anthropic caps a model it doesn't know at 4,096 output tokens).
 *
 * Only reads files; nothing is installed or run. The nearest manifest that declares the package, walking up from
 * the file, decides the project; the nearest lockfile at or above it gives the version.
 *
 *   npm:  package.json; package-lock.json / npm-shrinkwrap.json, bun.lock, pnpm-lock.yaml, yarn.lock
 *   pypi: pyproject.toml, requirements*.txt, Pipfile; poetry.lock, uv.lock, pdm.lock, Pipfile.lock, pinned requirements
 */
import { parse as parseYaml } from "yaml";
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "bun.lock", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"];
const PY_LOCKS = ["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock"];
const PY_MANIFESTS = ["pyproject.toml", "requirements.txt", "requirements.in", "Pipfile"];
/** How to update one package in that lockfile, for the tracking issue */
export const UPDATE_HINT = {
    "package-lock.json": (p) => `npm update ${p}`,
    "npm-shrinkwrap.json": (p) => `npm update ${p}`,
    "bun.lock": (p) => `bun update ${p}`,
    "bun.lockb": (p) => `bun update ${p}`,
    "pnpm-lock.yaml": (p) => `pnpm update ${p}`,
    "yarn.lock": (p) => `yarn up ${p}`,
    "poetry.lock": (p) => `poetry update ${p}`,
    "uv.lock": (p) => `uv lock --upgrade-package ${p}`,
    "pdm.lock": (p) => `pdm update ${p}`,
    "Pipfile.lock": (p) => `pipenv update ${p}`,
};
const dirsUp = (file) => {
    const parts = file.split("/").slice(0, -1);
    const out = [];
    for (let i = parts.length; i >= 0; i--)
        out.push(parts.slice(0, i).join("/"));
    return out;
};
const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/@-]/g, "\\$&");
/** PEP 503: names compare lowercased, with runs of -, _ and . equal */
const pyName = (s) => s.toLowerCase().replace(/[-_.]+/g, "-");
export function installedFor(read, fromFile, ecosystem, pkg) {
    const dirs = dirsUp(fromFile);
    let manifestDir;
    const out = {};
    for (const d of dirs) {
        const found = ecosystem === "npm" ? npmRange(read, d, pkg) : pyRange(read, d, pkg);
        if (found) {
            manifestDir = d;
            Object.assign(out, found);
            break;
        }
    }
    if (manifestDir === undefined)
        return undefined;
    // The lockfile next to the manifest, or a workspace root's above it
    for (const d of dirs.slice(dirs.indexOf(manifestDir))) {
        for (const name of ecosystem === "npm" ? NPM_LOCKS : PY_LOCKS) {
            const text = read(join(d, name));
            if (text === undefined)
                continue;
            const member = manifestDir.slice(d.length).replace(/^\//, "");
            const v = ecosystem === "npm" ? npmLocked(name, text, pkg, member, out.range) : pyLocked(name, text, pkg);
            if (v)
                return { ...out, version: v, lockfile: join(d, name) };
            return { ...out, unreadableLock: join(d, name) };
        }
    }
    // A requirements file with an exact pin is its own lock
    if (ecosystem === "pypi" && out.range && /^==\s*[\w.]+$/.test(out.range.trim()))
        return { ...out, version: out.range.trim().slice(2).trim(), lockfile: out.manifest };
    return out;
}
function npmRange(read, dir, pkg) {
    const text = read(join(dir, "package.json"));
    if (text === undefined)
        return undefined;
    try {
        const j = JSON.parse(text);
        for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
            const r = j[k]?.[pkg];
            if (typeof r === "string")
                return { range: r, manifest: join(dir, "package.json") };
        }
    }
    catch {
        /* not JSON */
    }
    return undefined;
}
function pyRange(read, dir, pkg) {
    const want = pyName(pkg);
    for (const name of PY_MANIFESTS) {
        const text = read(join(dir, name));
        if (text === undefined)
            continue;
        // "anthropic>=0.40", anthropic = "^0.40", anthropic[bedrock]==0.40.0
        const re = /(^|["'\s,[])([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(?:((?:[=<>!~^]=?|===)\s*[^"',;\s#]+(?:\s*,\s*(?:[=<>!~]=?)\s*[^"',;\s#]+)*)|=\s*["']([^"']*)["'])?/gm;
        for (const m of text.matchAll(re)) {
            if (pyName(m[2]) !== want)
                continue;
            const range = (m[4] ?? m[5] ?? "").trim();
            return { range: range || "*", manifest: join(dir, name) };
        }
    }
    return undefined;
}
/** The version a lockfile resolves `pkg` to for the project in `member` (a path below the lockfile's folder) */
function npmLocked(name, text, pkg, member, range) {
    if (name === "bun.lockb")
        return undefined; // binary
    if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
        try {
            const j = JSON.parse(text);
            if (j.packages)
                return j.packages[join(member, `node_modules/${pkg}`)]?.version ?? j.packages[`node_modules/${pkg}`]?.version;
            return j.dependencies?.[pkg]?.version;
        }
        catch {
            return undefined;
        }
    }
    if (name === "bun.lock") {
        // JSONC (trailing commas): "packages": { "<pkg>": ["<pkg>@<version>", ...], "<member>/<pkg>": [...] }
        const at = (key) => new RegExp(`"${esc(key)}"\\s*:\\s*\\[\\s*"${esc(pkg)}@([^"]+)"`).exec(text)?.[1];
        return (member ? at(`${member}/${pkg}`) : undefined) ?? at(pkg);
    }
    if (name === "pnpm-lock.yaml") {
        try {
            const j = parseYaml(text, { maxAliasCount: 100 });
            const imp = j.importers?.[member || "."] ?? (member ? undefined : j);
            for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
                const e = imp?.[k]?.[pkg];
                const v = typeof e === "string" ? e : e?.version;
                if (v)
                    return v.replace(/[(_].*$/, "");
            }
        }
        catch {
            return undefined;
        }
        return undefined;
    }
    if (name === "yarn.lock") {
        // Blocks: `"@ai-sdk/anthropic@^3.0.0", "@ai-sdk/anthropic@npm:^3.0.1":` then `version "3.0.23"` (v1) or `version: 3.0.23`
        const blocks = text.split(/\n(?=\S)/);
        const head = (b) => b.split("\n")[0];
        const forPkg = blocks.filter((b) => new RegExp(`(^|[",\\s])${esc(pkg)}@`).test(head(b)));
        const pick = (range ? forPkg.find((b) => head(b).includes(`${pkg}@${range}`) || head(b).includes(`${pkg}@npm:${range}`)) : undefined) ?? (forPkg.length === 1 ? forPkg[0] : undefined);
        return pick ? /\n\s+version:?\s+"?([^"\s]+)"?/.exec(pick)?.[1] : undefined;
    }
    return undefined;
}
function pyLocked(name, text, pkg) {
    const want = pyName(pkg);
    if (name === "Pipfile.lock") {
        try {
            const j = JSON.parse(text);
            for (const sect of ["default", "develop"]) {
                for (const [k, v] of Object.entries(j[sect] ?? {}))
                    if (pyName(k) === want && v.version)
                        return v.version.replace(/^==/, "");
            }
        }
        catch {
            return undefined;
        }
        return undefined;
    }
    // poetry.lock, uv.lock, pdm.lock: [[package]] name = "x" version = "y"
    for (const block of text.split(/\n(?=\[\[package\]\])/)) {
        const n = /\nname\s*=\s*"([^"]+)"/.exec("\n" + block.replace(/^\[\[package\]\]\s*/, ""))?.[1];
        if (n && pyName(n) === want)
            return /\nversion\s*=\s*"([^"]+)"/.exec("\n" + block)?.[1];
    }
    return undefined;
}
export function parseVersion(s) {
    const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-.]?((?:a|b|rc|alpha|beta|pre|dev|canary)[\w.]*))?/i.exec(s);
    if (!m)
        return undefined;
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ? -1 : 0];
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3];
/**
 * Is this version one that has the fix? `mins` holds the first good version of each release line
 * ("2.0.107", "3.0.125", "4.0.67"). A version on a line above all of them is taken as good; one on a line below,
 * or between listed lines, isn't.
 */
export function versionOk(version, mins) {
    const v = parseVersion(version);
    const ms = mins.map(parseVersion).filter((m) => !!m).sort(cmp);
    if (!v || !ms.length)
        return undefined;
    const line = ms.find((m) => m[0] === v[0]);
    if (line)
        return cmp(v, line) >= 0;
    return v[0] > ms[ms.length - 1][0];
}
/** The first good version of the version's own release line, or the lowest listed when it has none */
export function minFor(version, mins) {
    const v = version ? parseVersion(version) : undefined;
    return (v && mins.find((m) => parseVersion(m)?.[0] === v[0])) ?? mins[0];
}
const INF = {};
/** One npm/Poetry/PEP 440 comparator → the interval it allows */
function comparator(tok) {
    const m = /^(===|==|<=|>=|<|>|=|\^|~=|~|!=)?\s*v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:\.\*)?([-.]?(?:a|b|rc|alpha|beta|pre|dev|canary)[\w.]*)?$/i.exec(tok);
    if (!m)
        return undefined;
    const op = m[1] ?? "";
    if (op === "!=")
        return INF; // excludes one version: as good as anything here
    const wild = (x) => x === undefined || /^[xX*]$/.test(x);
    const nums = [m[2], m[3], m[4]];
    const given = nums.findIndex(wild) === -1 ? 3 : nums.findIndex(wild);
    if (given === 0)
        return INF;
    const n = nums.map((x) => (wild(x) ? 0 : Number(x)));
    const base = [n[0], n[1], n[2], m[5] ? -1 : 0];
    const bump = (i) => (i === 0 ? [n[0] + 1, 0, 0, -1] : i === 1 ? [n[0], n[1] + 1, 0, -1] : [n[0], n[1], n[2] + 1, -1]);
    const lo = { v: base, incl: true };
    switch (op) {
        case "^": {
            // ^1.2.3 <2; ^0.2.3 <0.3; ^0.0.3 <0.0.4; ^1.x <2
            const i = n[0] > 0 || given === 1 ? 0 : n[1] > 0 || given === 2 ? 1 : 2;
            return { lo, hi: { v: bump(i), incl: false } };
        }
        case "~":
            return { lo, hi: { v: bump(given === 1 ? 0 : 1), incl: false } };
        case "~=": // PEP 440: ~=2.2 is >=2.2,<3; ~=1.4.5 is >=1.4.5,<1.5
            return { lo, hi: { v: bump(Math.max(0, given - 2)), incl: false } };
        case ">=":
            return { lo };
        case ">":
            return given < 3 ? { lo: { v: bump(given - 1), incl: true } } : { lo: { v: base, incl: false } };
        case "<":
            return { hi: { v: base, incl: false } };
        case "<=":
            return given < 3 ? { hi: { v: bump(given - 1), incl: false } } : { hi: { v: base, incl: true } };
        default:
            // exact, or a partial/x-range: 3.0.23, 3.x, 3.0.*
            return given < 3 ? { lo, hi: { v: bump(given - 1), incl: false } } : { lo, hi: { v: base, incl: true } };
    }
}
const maxLo = (a, b) => (!a ? b : !b ? a : cmp(a.v, b.v) > 0 || (cmp(a.v, b.v) === 0 && !a.incl) ? a : b);
const minHi = (a, b) => (!a ? b : !b ? a : cmp(a.v, b.v) < 0 || (cmp(a.v, b.v) === 0 && !a.incl) ? a : b);
const empty = (i) => !!i.lo && !!i.hi && (cmp(i.lo.v, i.hi.v) > 0 || (cmp(i.lo.v, i.hi.v) === 0 && !(i.lo.incl && i.hi.incl)));
/** A range → the intervals it allows; undefined when it isn't a version range (a git URL, file:, workspace:) */
export function rangeIntervals(range) {
    let r = range.trim().replace(/^npm:[^@]+@/, "");
    if (r === "" || r === "*" || r === "latest" || /^[xX]$/.test(r))
        return [INF];
    if (/^(workspace:|file:|link:|git|github:|https?:|catalog:)|\//.test(r))
        return undefined;
    const sets = [];
    for (let alt of r.split("||")) {
        alt = alt.trim();
        const hy = /^(\S+)\s+-\s+(\S+)$/.exec(alt);
        const toks = hy ? [`>=${hy[1]}`, `<=${hy[2]}`] : alt.replace(/(>=|<=|>|<|===|==|=|~=|~|\^|!=)\s+/g, "$1").split(/[\s,]+/).filter(Boolean);
        let acc = INF;
        for (const t of toks) {
            const c = comparator(t);
            if (!c)
                return undefined;
            acc = { lo: maxLo(acc.lo, c.lo), hi: minHi(acc.hi, c.hi) };
        }
        if (!empty(acc))
            sets.push(acc);
    }
    return sets;
}
/**
 * Can this range resolve to a version that has the fix? True when some allowed version is at or above a release
 * line's first good version and still on that line (or on a line above all listed ones).
 */
export function rangeAllows(range, mins) {
    const sets = rangeIntervals(range);
    if (!sets)
        return undefined;
    const ms = mins.map(parseVersion).filter((m) => !!m).sort(cmp);
    if (!ms.length)
        return undefined;
    const good = ms.map((m) => ({ lo: { v: m, incl: true }, hi: { v: [m[0] + 1, 0, 0, -1], incl: false } }));
    good.push({ lo: { v: [ms[ms.length - 1][0] + 1, 0, 0, -1], incl: true } });
    return sets.some((s) => good.some((g) => !empty({ lo: maxLo(s.lo, g.lo), hi: minHi(s.hi, g.hi) })));
}
