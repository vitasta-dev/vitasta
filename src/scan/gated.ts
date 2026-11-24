/**
 * A setting sent only when a capability check says the model takes it:
 *   init_chat_model(m, temperature=0 if takes_temperature(m) else None)
 *   temperature: supportsTemperature(model) ? 0.2 : undefined
 * The code already copes with models that reject the setting: still reported (possible), never failing a check.
 * Generic: the check's name has to name the setting itself (takes / supports / accepts / allows / can … temperature,
 * top_p, top_k, sampling); a check on anything else (is_fast(m), useCache) doesn't count. The other side must be
 * "not sent" (None / null / undefined / nil).
 */
import type { Usage } from "../types.js";

const SETTING = String.raw`(?:temperature|temp|sampling|top_?p|top_?k|topP|topK)`;
const GATE = String.raw`[\w.]*(?:takes|supports?|accepts?|allows?|can|has|uses?)_?(?:custom_?)?${SETTING}\w*\s*\(`;
const UNSET = String.raw`(?:None|null|undefined|nil)`;
// Python: X if gate(…) else None / None if not gate(…) else X; JS/TS/Ruby: gate(…) ? X : undefined / !gate(…) ? undefined : X
const PY = new RegExp(String.raw`\bif\s+(${GATE})[^\n]*?\belse\s+${UNSET}\b|\b${UNSET}\s+if\s+not\s+(${GATE})`, "i");
const TERN = new RegExp(String.raw`(?<![\w.])(${GATE})[^?\n]*\?[^:\n]*:\s*${UNSET}\b|!\s*(${GATE})[^?\n]*\?\s*${UNSET}\s*:`, "i");

export function markGatedSettings(usages: Usage[]): void {
  for (const u of usages) {
    if (!u.params?.length || u.gated || !u.snippet) continue;
    if (!u.params.every((p) => new RegExp(`^${SETTING}$`, "i").test(p))) continue;
    const m = PY.exec(u.snippet) ?? TERN.exec(u.snippet);
    if (!m) continue;
    const gate = (m[1] ?? m[2]).replace(/\s*\($/, "");
    u.gated = `sent only when ${gate}() says the model takes it`;
    u.confidence = "possible";
    u.reason = u.reason ? `${u.reason}; ${u.gated}` : u.gated;
  }
}
