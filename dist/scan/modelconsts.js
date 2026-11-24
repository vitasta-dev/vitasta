/**
 * C# / Java model ids kept in a constants class and chosen elsewhere:
 *   public static class ChatCompletionModels { public const string Gpt4o = "gpt-4o"; }
 *   public static class DefaultModels { public static string Chat = ChatCompletionModels.Gpt4o; }
 * A constant holding a model id is a catalog entry on its own; an assignment that picks one for something named as
 * a model or a default (DefaultModels.Chat, ModelId, defaultModel) is that model's setting, at the assignment.
 */
import { modelProvider } from "../providers.js";
export function modelConstantUsages(files, found) {
    const code = files.filter((f) => (f.lang === "cs" || f.lang === "java") && f.source.length <= 2_000_000);
    // Class.NAME → its model id
    const consts = new Map();
    for (const f of code) {
        let cls;
        f.source.split("\n").forEach((l, i) => {
            const c = /\b(?:class|interface|enum|record|struct)\s+(\w+)/.exec(l);
            if (c)
                cls = c[1];
            const m = /\b(?:const\s+string|static\s+(?:readonly\s+)?string|static\s+final\s+String|final\s+static\s+String)\s+(\w+)\s*=\s*"([^"]+)"/.exec(l);
            if (m && cls && modelProvider(m[2]))
                consts.set(`${cls}.${m[1]}`, { model: m[2], file: f.rel, line: i + 1 });
        });
    }
    if (!consts.size)
        return [];
    const have = new Set(found.filter((u) => u.model).map((u) => `${u.file}|${u.line}`));
    const out = [];
    // twice: a static field that picked a constant (DefaultModels.Chat) can be picked in turn (Model = DefaultModels.Chat)
    for (let round = 0; round < 2; round++)
        for (const f of code) {
            let cls;
            f.source.split("\n").forEach((l, i) => {
                const c = /\b(?:class|interface|enum|record|struct)\s+(\w+)/.exec(l);
                if (c)
                    cls = c[1];
                // Target = Class.NAME;  (a field, property initializer, local or argument default)
                const m = /\b(\w+)\s*(?:\{\s*get;\s*(?:set;\s*)?\}\s*)?=\s*(?:[\w.]+\.)?([A-Z]\w*)\.([A-Za-z_]\w*)\s*[;,)]/.exec(l);
                if (!m)
                    return;
                const k = consts.get(`${m[2]}.${m[3]}`);
                if (!k || have.has(`${f.rel}|${i + 1}`))
                    return;
                if (!/model|default/i.test(m[1]) && !/model|default/i.test(cls ?? ""))
                    return;
                const p = modelProvider(k.model);
                have.add(`${f.rel}|${i + 1}`);
                if (/\bstatic\b/.test(l) && cls)
                    consts.set(`${cls}.${m[1]}`, { model: k.model, file: f.rel, line: i + 1 });
                out.push({
                    provider: p.id, kind: "model-ref", lang: f.lang, file: f.rel, line: i + 1, model: k.model, confidence: "possible", setting: true,
                    snippet: l.trim().slice(0, 200), reason: `${m[1]} is ${m[2]}.${m[3]} = "${k.model}" (${k.file}:${k.line})`,
                });
            });
        }
    return out;
}
