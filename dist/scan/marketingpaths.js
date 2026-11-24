const MARKETING = /(?:^|[^\w])act_|(?<![\w-])(?:campaigns|adsets|ads|adcreatives|adimages|advideos|insights|customaudiences|adaccounts|adrules_library)(?![\w-])/;
const DECL = /^\s*(?:(?:export|const|let|var|val|final|static|private|public|protected|readonly|internal)\s+)*(?:[\w<>\[\]?]+\s+)?([A-Za-z_$][\w$]{2,})\s*(?::[^=\n]*)?=(?![=>])/;
const dirOf = (rel) => rel.split("/").slice(0, -1).join("/");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function marketingByPaths(kept, files) {
    const bases = new Map();
    for (const u of kept) {
        if (u.provider !== "meta" || (u.kind !== "version-pin" && u.kind !== "http") || !u.snippet)
            continue;
        // the base URL declaration: a name set to a Graph URL that ends at the version (no path of its own)
        if (!/["'`]https:\/\/graph\.facebook\.com\/v\d+\.\d+\/?["'`]/.test(u.snippet))
            continue;
        const name = DECL.exec(u.snippet)?.[1];
        if (!name)
            continue;
        const key = `${dirOf(u.file)}|${name}`;
        bases.set(key, bases.get(key) ?? { dir: dirOf(u.file), names: new Set([name]) });
    }
    for (const [key, { dir }] of bases) {
        const name = key.split("|")[1];
        const re = new RegExp(`(?<![\\w$.])${esc(name)}(?![\\w$])`);
        const texts = [];
        for (const f of files) {
            if (dirOf(f.rel) !== dir || /(^|\/)(tests?|__tests__|testdata)\//i.test(f.rel) || /_test\.go$/.test(f.rel))
                continue;
            const lines = f.source.split("\n");
            lines.forEach((l, i) => {
                const m = re.exec(l);
                if (!m || DECL.test(l) && /=\s*["'`]https:/.test(l))
                    return;
                // what follows the name on the line: "/" + path, "/act_" + id + "/insights", fmt.Sprintf("%s/…", name, …)
                texts.push(l.slice(m.index + m[0].length));
                // inside a wrapper (func (c *C) doGet(path string)): the callers' arguments are the paths
                let fn;
                for (let r = i; r >= Math.max(0, i - 20) && !fn; r--)
                    fn = /^\s*(?:(?:public|private|protected|static|async|export)\s+)*(?:func\s*(?:\([^)]*\)\s*)?|def\s+|function\s+|(?:[\w<>\[\]]+\s+))([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(lines[r])?.[1];
                if (fn && !/^(?:if|for|while|switch|return|new)$/.test(fn)) {
                    const call = new RegExp(`(?<![\\w$])${esc(fn)}\\s*\\(([^\\n]*)`);
                    for (const g of files) {
                        if (dirOf(g.rel) !== dir || /_test\.go$/.test(g.rel))
                            continue;
                        for (const gl of g.source.split("\n")) {
                            if (new RegExp(`^\\s*(?:(?:public|private|protected|static|async|export)\\s+)*(?:func\\s*(?:\\([^)]*\\)\\s*)?|def\\s+|function\\s+)${esc(fn)}\\s*\\(`).test(gl))
                                continue;
                            const cm = call.exec(gl);
                            if (cm)
                                texts.push(cm[1]);
                        }
                    }
                }
            });
        }
        const withPath = texts.filter((t) => /["'`]|\w/.test(t) && /["'`][^"'`]*["'`]|\b[a-z_]\w*/i.test(t));
        const marketing = withPath.filter((t) => MARKETING.test(t)).length;
        if (!marketing || marketing * 2 < withPath.length)
            continue;
        for (const u of kept) {
            if (u.provider !== "meta" || dirOf(u.file) !== dir || !u.snippet || !re.test(u.snippet))
                continue;
            u.provider = "meta-marketing";
            u.reason = `${u.reason ? u.reason + "; " : ""}the paths joined to ${name} are Marketing API endpoints (act_*, campaigns, adsets, ads, insights)`;
        }
    }
}
