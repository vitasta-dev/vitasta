/**
 * A deterministic per-file cost guard (test sets: one desktop app's long C# files took 10 minutes on the newer
 * cross-file passes). A file over any of these limits still gets the per-file analyzers (its calls, models and
 * versions), but not the passes added since v17 that search a whole file once per line, name or call (call map,
 * flow tracing, wrapper paths, vocab shapes …). Decided by the file alone, never by wall-clock time, so a scan's
 * results don't depend on how busy the machine is. Very large or machine-written files (generated clients, designer
 * files, embedded data) are where those passes are slowest and least useful.
 */
export const COST_LIMITS = { bytes: 600_000, lines: 15_000, longestLine: 20_000 };
export function isHeavySource(source) {
    if (source.length > COST_LIMITS.bytes)
        return true;
    let lines = 1, start = 0, longest = 0;
    for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) {
        if (i - start > longest)
            longest = i - start;
        start = i + 1;
        if (++lines > COST_LIMITS.lines)
            return true;
    }
    if (source.length - start > longest)
        longest = source.length - start;
    return longest > COST_LIMITS.longestLine;
}
/** A filter for file lists, remembering each file's verdict (by path) for the scan */
export function costGuard() {
    const seen = new Map();
    const heavy = (f) => {
        let v = seen.get(f.rel);
        if (v === undefined)
            seen.set(f.rel, (v = isHeavySource(f.source)));
        return v;
    };
    return { heavy, lite: (xs) => xs.filter((x) => !heavy(x)), skipped: () => [...seen].filter(([, v]) => v).map(([k]) => k).sort() };
}
