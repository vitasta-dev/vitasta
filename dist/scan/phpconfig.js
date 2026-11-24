/** The dotted key of the value on a line of a config/*.php file: file name, then each enclosing array's key */
function keyAt(rel, lines, row) {
    const m = /(?:^|\/)config\/((?:[\w-]+\/)*[\w-]+)\.php$/.exec(rel);
    if (!m)
        return undefined;
    const own = /^\s*['"]([\w.-]+)['"]\s*=>/.exec(lines[row])?.[1];
    if (!own)
        return undefined;
    const path = [own];
    let depth = 0;
    for (let r = row - 1; r >= 0; r--) {
        const l = lines[r];
        // brackets closed above us don't enclose us
        depth += (l.match(/\]/g) ?? []).length - (l.match(/\[/g) ?? []).length;
        if (depth < 0) {
            const k = /^\s*['"]([\w.-]+)['"]\s*=>\s*(?:array\s*\(|\[)\s*$/.exec(l)?.[1];
            if (k)
                path.unshift(k);
            depth = 0;
        }
    }
    return [m[1].replace(/\//g, "."), ...path].join(".");
}
export function phpConfigReadUsages(files, found) {
    const php = files.filter((f) => f.lang === "php" && f.source.length <= 2_000_000);
    const out = [];
    const have = new Set(found.map((u) => `${u.file}|${u.line}|${u.apiVersion ?? ""}`));
    const byRel = new Map(php.map((f) => [f.rel, f]));
    for (const u of found) {
        if (u.kind !== "version-pin" || !u.apiVersion || u.inTest || !/(?:^|\/)config\/[\w/-]+\.php$/.test(u.file))
            continue;
        const f = byRel.get(u.file);
        if (!f)
            continue;
        const key = keyAt(u.file, f.source.split("\n"), u.line - 1);
        if (!key)
            continue;
        const read = new RegExp(`\\b(?:config|Config::get|\\$config->get|config\\(\\)->get)\\s*\\(\\s*['"]${key.replace(/[.]/g, "\\.")}['"]`);
        for (const g of php) {
            if (g.rel === u.file)
                continue;
            g.source.split("\n").forEach((l, i) => {
                if (!read.test(l) || have.has(`${g.rel}|${i + 1}|${u.apiVersion}`))
                    return;
                have.add(`${g.rel}|${i + 1}|${u.apiVersion}`);
                out.push({
                    provider: u.provider, kind: "version-pin", lang: "php", file: g.rel, line: i + 1, apiVersion: u.apiVersion, confidence: u.confidence,
                    snippet: l.trim().slice(0, 200), reason: `reads config('${key}'), whose default is ${u.apiVersion.replace(/^\w+: /, "")} (${u.file}:${u.line})`,
                });
            });
        }
    }
    return out;
}
/**
 * A request setting read from framework config: 'temperature' =>
 * config('anthropic.temperature') in a Guzzle body, with config/anthropic.php holding 'temperature' =>
 * env('ANTHROPIC_TEMPERATURE', 0.2). The config line is where the value is set: the same setting there, "possible",
 * with the request line as an alsoLine.
 */
export function phpConfigParamUsages(files, found) {
    const cfg = files.filter((f) => f.lang === "php" && /(?:^|\/)config\/(?:[\w-]+\/)*[\w-]+\.php$/.test(f.rel) && f.source.length <= 1_000_000);
    if (!cfg.length)
        return [];
    const at = new Map();
    for (const f of cfg) {
        const lines = f.source.split("\n");
        lines.forEach((l, i) => {
            const k = keyAt(f.rel, lines, i);
            if (k && !at.has(k))
                at.set(k, { file: f.rel, line: i + 1, text: l.trim() });
        });
    }
    const out = [];
    const have = new Set(found.flatMap((u) => (u.params ?? []).map((p) => `${u.file}|${u.line}|${p}`)));
    for (const u of found) {
        if (u.lang !== "php" || !u.params?.length || !u.op || !u.snippet)
            continue;
        const m = /\b(?:config|Config::get)\(\s*['"]([\w.-]+)['"]/.exec(u.snippet);
        const c = m ? at.get(m[1]) : undefined;
        if (!c)
            continue;
        for (const p of u.params) {
            if (have.has(`${c.file}|${c.line}|${p}`))
                continue;
            have.add(`${c.file}|${c.line}|${p}`);
            out.push({
                provider: u.provider, kind: u.kind, lang: "php", file: c.file, line: c.line, op: u.op, params: [p], confidence: "possible",
                snippet: c.text.slice(0, 200), reason: `${p} is set here and read as config('${m[1]}') in the request at ${u.file}:${u.line}`,
                ...(c.file === u.file ? { alsoLines: [u.line] } : {}),
            });
        }
    }
    return out;
}
