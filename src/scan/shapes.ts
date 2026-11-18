/**
 * Code shapes that hold model IDs, beyond the named settings in context.ts. They are only *candidates*: a model ID
 * in one of these shapes counts when the repo shows it really talks to that provider (see evidence.ts). That keeps a
 * benchmark table or a docs list in a repo that never calls the provider quiet, and finds the model enum, fallback
 * list or per-provider default map in an app that does.
 *
 * Shapes (all languages, from the syntax tree):
 * - a collection of models: an array/list/tuple/set, an object or dict's values, or an enum, with at least two model
 *   IDs in it. A row inside a table of rows (presets: ("Groq", url, "llama-…")) counts with its table;
 * - a model passed positionally to something model-shaped: get_chat_model("…"), new LLMLoop(key, "…"), not to
 *   lookups (normalizeModelName, get_model_provider, price/limit/capability helpers).
 *
 * Never a candidate: a lookup-table key, a collection used for a membership check (`model in [...]`,
 * `[...].includes(model)`), a collection named for prices, limits, capabilities or retired models, and anything
 * inside a recorded API response.
 */
import type { Node } from "./parser.js";
import { nameMatcher } from "./names.js";

/** Containers whose items or values can be a set of models */
const COLLECTIONS = new Set(["array", "list", "tuple", "set", "object", "dictionary", "array_initializer", "enum_body", "enum_declaration"]);
/** Containers that are one row of a bigger table */
const ROWS = new Set(["array", "list", "tuple", "object", "dictionary", "array_initializer", "argument_list", "arguments"]);
/** Wrappers between a string and its container that don't change meaning */
const PASS = new Set(["pair", "enum_assignment", "enum_constant", "argument_list", "arguments", "parenthesized_expression", "expression_statement", "assignment", "spread_element", "as_expression", "satisfies_expression", "keyword_argument"]);

/** Collections named for data about models, not the models an app uses */
export const DATA_OWNER = nameMatcher(
  /pric|cost|saving|limit|token|context_?(window|length|size)|max_?context|capabilit|compat|famil|keyword|prefix|retired|deprecat|legacy|sunset|support|feature|cutoff|leaderboard|rating|reasoning|thinking|sampling|temperature|unsupported|without|tokeni[sz]|placeholder|readable|friendly/i,
  // short words count only as whole words of the name (MODEL_ELO yes, DEVELOPER_MODELS no; TOOL_MODELS yes, STOOLS no)
  ["window", "matrix", "hint", "pattern", "condition", "requested", "when", "eol", "bench", "benchmark", "score", "rank", "ranking", "leader", "elo", "vision", "no", "cache", "stream", "streaming", "json", "tool", "encoding", "encoder", "history", "region", "example", "display", "pretty", "label", "title"],
);


/** Lists (not maps) of other names or versions for one entry: aliases: [...], snapshots: [...], unresolved: [...] */
export const NAME_LIST = /alias|snapshot|unresolved|variant|other_?names|synonym/i;

/** Callee names that take a model to use: get_chat_model, init_chat_model, ChatModel(...), new LLMLoop(...), create_agent */
const MODEL_CALL = /model|llm|chat|agent|embedd?(er|ing)/i;
/** ...but not helpers that look a model up, describe it or compare it */
const LOOKUP_CALL = /provider|name|normali[sz]|pric|cost|limit|token|support|capab|info|cutoff|context|window|count|encod|^(is|has)|label|display|format|pars|valid|known|lookup|find|match|compar|equal|alias|famil|icon|logo|colou?r|meta|spec|config_for|max_|min_|assert|expect|should|tobe|toequal/i;

/** Keys that only appear in an API *response* (recorded or mocked): the model there is output, not a setting */
const RESPONSE_KEYS = new Set([
  "choices", "usage", "created", "created_at", "system_fingerprint", "finish_reason", "stop_reason", "stop_sequence",
  "prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens", "usage_metadata", "usageMetadata",
  "candidates", "modelVersion", "model_version", "response_id", "responseId", "logprobs", "service_tier", "object",
]);

const unquote = (t: string) => t.replace(/^[a-zA-Z]{0,2}["'`]+|["'`]+$/g, "");

function keyOf(pair: Node): string {
  const k = pair.childForFieldName("key") ?? pair.namedChildren[0];
  return k ? unquote(k.text) : "";
}

function isKey(s: Node): boolean {
  const p = s.parent;
  return !!p && p.type === "pair" && (p.childForFieldName("key") ?? p.namedChildren[0])?.id === s.id;
}

/** The object/dict holding this string as a value looks like an API response: ≥2 response-only keys */
export function inRecordedResponse(s: Node): boolean {
  let n: Node | null = s;
  for (let depth = 0; n && depth < 3; depth++) {
    const p: Node | null = n.parent;
    if (!p) return false;
    if (p.type === "object" || p.type === "dictionary") {
      let hits = 0;
      for (const c of p.namedChildren) if (c?.type === "pair" && RESPONSE_KEYS.has(keyOf(c))) hits++;
      if (hits >= 2) return true;
    }
    n = p;
  }
  return false;
}

/** Tables whose entry for a model is that model's setup: configs, clients, agents, presets, profiles */
const SUBSCRIPT_OWNER = /config|model|llm|client|agent|setting|preset|profile|provider|engine/i;

const COST_CONTEXT = /pric|cost|saving|estimat|billing|budget|spend|charge|quota|metering|invoice/i;

/**
 * Inside code about prices or costs: a `pricing: { compute() {...} }` entry, a `cost_for()` function, a
 * PRICES table. A model there is the input to an estimate, not the model the app calls.
 */
export function inCostContext(s: Node): boolean {
  let n: Node | null = s.parent;
  for (let depth = 0; n && depth < 14; depth++, n = n.parent) {
    const name =
      n.type === "pair" ? (n.childForFieldName("key") ?? n.namedChildren[0])?.text
      : /function|method|variable_declarator|assignment|class/.test(n.type) ? (n.childForFieldName("name") ?? n.childForFieldName("left"))?.text
      : undefined;
    if (name && COST_CONTEXT.test(name)) return true;
    if (/^(program|module|source_file)$/.test(n.type)) return false;
  }
  return false;
}

/** Name of whatever a collection is assigned to: MODELS = [...], "fallback": [...], class ModelType(Enum) */
function ownerName(c: Node): string {
  let n: Node = c;
  for (let i = 0; i < 5 && n.parent; i++) {
    const p: Node = n.parent;
    // A call or constructor wrapping the collection (new Set([...]), frozenset(...), List.of(...)) has no name of
    // its own: look past it to what it is assigned to
    if (["call_expression", "new_expression", "call", "method_invocation", "object_creation_expression"].includes(p.type)) {
      n = p;
      continue;
    }
    const name = p.childForFieldName("name") ?? p.childForFieldName("left") ?? p.childForFieldName("key") ?? (p.type === "pair" ? p.namedChildren[0] : null);
    if (name && name.id !== n.id) return unquote(name.text);
    if (!["parenthesized_expression", "as_expression", "satisfies_expression", "type_assertion", "arguments", "argument_list"].includes(p.type)) break;
    n = p;
  }
  return "";
}

/** Names of the collections around this one (a table of entries inside a named table), innermost first */
function outerOwners(c: Node, levels = 3): string[] {
  const out: string[] = [];
  let n: Node | null = c.parent;
  for (let i = 0; n && i < 8 && out.length < levels; i++, n = n.parent) {
    if (COLLECTIONS.has(n.type)) {
      const o = ownerName(n);
      if (o) out.push(o);
    }
  }
  return out;
}

/** Keys whose value is text for people, not a model to use: label: "o1-mini", title: "GPT-4o" */
const DISPLAY_KEY = /^(label|title|display_?name|displayName|description|tooltip|hint|placeholder|help|subtitle|caption|alt)$/i;

/** A collection used to check membership: `model in [...]`, `[...].includes(model)`, `Set.of(...).contains(m)` */
function membershipCheck(c: Node): boolean {
  const p = c.parent;
  if (!p) return false;
  if (p.type === "comparison_operator") return true; // python `x in [...]`
  if (p.type === "member_expression" || p.type === "attribute" || p.type === "field_access") return true; // [...].includes(m)
  if (p.type === "binary_expression" && p.childForFieldName("right")?.id === c.id) return /\bin\b/.test(p.text);
  return false;
}

/** String tests: prefix, suffix and substring checks, regex tests */
const MATCH_CALL = /^(startswith|endswith|startsWith|endsWith|includes|contains|indexOf|find|search|match|matches|test|fullmatch|fnmatch|has_prefix|HasPrefix|HasSuffix|Contains)$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A test on one model name: `v in model.lower()`, `.startswith(v)`, `.includes(v)`, `re.search(v, name)` */
function testsWith(v: string, text: string): boolean {
  const V = esc(v);
  return new RegExp(`\\b${V}\\s+in\\s+[\\w.\\[\\]"']*?(model|name|id)(_?(id|name|str|lower))?\\b(?!s)(\\.(lower|casefold|upper)\\(\\))?`).test(text) ||
    new RegExp(`\\.(startswith|endswith|startsWith|endsWith|includes|contains|indexOf|match|search|test)\\(\\s*${V}\\b`).test(text) ||
    new RegExp(`\\bre\\.(search|match|fullmatch)\\(\\s*${V}\\b`).test(text);
}

const onlyChecksCache = new WeakMap<object, Map<number, boolean>>();

/** The node that names a collection: the declarator/assignment/pair it is the value of (through wrappers) */
function definitionOf(c: Node): Node | undefined {
  let n: Node = c;
  for (let i = 0; i < 5 && n.parent; i++) {
    const p: Node = n.parent;
    if (["variable_declarator", "assignment", "pair", "public_field_definition", "field_declaration", "assignment_expression"].includes(p.type)) return p;
    if (!["call_expression", "new_expression", "call", "argument_list", "arguments", "parenthesized_expression", "as_expression", "satisfies_expression", "object_creation_expression", "method_invocation"].includes(p.type)) return undefined;
    n = p;
  }
  return undefined;
}

/**
 * A named collection that the file only ever tests names against or prices with: every use of COMPUTER_USE_MODELS
 * is COMPUTER_USE_MODELS.has(model) / `model in X`, or sits in a pricing function. Then it's a capability or price
 * list, not models the app offers. Unknown (false) when the file never uses it (it may be exported).
 */
function onlyChecked(c: Node, name: string): boolean {
  const perTree = onlyChecksCache.get(c.tree) ?? new Map<number, boolean>();
  onlyChecksCache.set(c.tree, perTree);
  if (perTree.has(c.startIndex)) return perTree.get(c.startIndex)!;
  let root: Node = c;
  while (root.parent) root = root.parent;
  const def = definitionOf(c);
  let uses = 0, checks = 0;
  for (const id of root.descendantsOfType(["identifier", "property_identifier", "field_identifier"])) {
    if (!id || id.text !== name) continue;
    // the definition itself (MODELS = …, this.MODELS = …, MODELS: …)
    if (def && id.startIndex >= def.startIndex && id.endIndex <= c.startIndex) continue;
    if (id.startIndex >= c.startIndex && id.endIndex <= c.endIndex) continue;
    uses++;
    let r: Node = id;
    if (r.parent && ["member_expression", "attribute", "field_access"].includes(r.parent.type) && r.parent.namedChildren[r.parent.namedChildren.length - 1]?.id === r.id) r = r.parent; // this.X / self.X
    const p = r.parent;
    const method = p && ["member_expression", "attribute", "field_access"].includes(p.type) && p.namedChildren[0]?.id === r.id ? p.namedChildren[p.namedChildren.length - 1]?.text ?? "" : "";
    const isMembership = /^(has|includes|contains|indexOf|containsKey|__contains__|issuperset|issubset)$/.test(method) ||
      (p?.type === "comparison_operator" && p.namedChildren[p.namedChildren.length - 1]?.id === r.id && /\bin\b/.test(p.text)) ||
      (p?.type === "binary_expression" && p.childForFieldName("right")?.id === r.id && /\bin\b/.test(p.childForFieldName("operator")?.text ?? ""));
    let inCost = false;
    for (let n: Node | null = r.parent, d = 0; n && d < 12; n = n.parent, d++) {
      if (/function|method/.test(n.type)) {
        const fn = n.childForFieldName("name")?.text ?? (n.parent?.type === "variable_declarator" ? n.parent.childForFieldName("name")?.text : "") ?? "";
        inCost = COST_CONTEXT.test(fn);
        break;
      }
    }
    if (isMembership || inCost) checks++;
    else break;
  }
  const out = uses > 0 && checks === uses;
  perTree.set(c.startIndex, out);
  return out;
}

/**
 * A collection of model names used to test a name, not to use it: passed to a string test (name.startswith((…)),
 * looped over in a test (any(x in model.lower() for x in (…)), for p in PREFIXES: if name.startswith(p)), or a named
 * collection used that way elsewhere in the file (PREFIXES.some((p) => id.startsWith(p))).
 */
export function inMatchCheck(c: Node): boolean {
  // passed straight to a string test
  let a: Node = c;
  while (a.parent && ["parenthesized_expression", "call"].includes(a.parent.type) && a.parent.type !== "call") a = a.parent;
  const args = a.parent;
  if (args && (args.type === "argument_list" || args.type === "arguments")) {
    const fn = args.parent?.childForFieldName("function") ?? args.parent?.childForFieldName("name");
    const last = (fn?.text ?? "").split(".").pop() ?? "";
    if (MATCH_CALL.test(last)) return true;
    // tuple(…)/frozenset(…) wrapping it: look one call further out
    if (/^(tuple|frozenset|set|list)$/.test(last)) {
      const outer = args.parent?.parent;
      if (outer && (outer.type === "argument_list" || outer.type === "arguments")) {
        const f2 = (outer.parent?.childForFieldName("function")?.text ?? "").split(".").pop() ?? "";
        if (MATCH_CALL.test(f2)) return true;
      }
    }
  }
  // looped over, and the loop variable is tested against a name
  const loop = c.parent;
  if (loop && ["for_in_clause", "for_statement", "for_in_statement"].includes(loop.type) && loop.childForFieldName("right")?.id === c.id) {
    const v = loop.childForFieldName("left")?.text ?? "";
    const scope = loop.type === "for_in_clause" ? loop.parent : loop;
    if (/^\w+$/.test(v) && scope && testsWith(v, scope.text)) return true;
  }
  // a named collection used that way elsewhere in the file
  const name = ownerName(c).split(".").pop() ?? "";
  if (/^\w{3,}$/.test(name) && onlyChecked(c, name)) return true;
  if (/^\w{3,}$/.test(name)) {
    let root: Node = c;
    while (root.parent) root = root.parent;
    const src = root.text;
    const N = esc(name);
    if (new RegExp(`\\.(startswith|endswith)\\(\\s*(tuple\\(\\s*)?(self\\.|cls\\.)?${N}\\b`).test(src)) return true;
    for (const m of src.matchAll(new RegExp(`\\bfor\\s+\\(?\\s*(?:const|let|var)?\\s*(\\w+)\\s+(?:in|of)\\s+(?:self\\.|cls\\.|this\\.)?${N}\\b`, "g"))) {
      if (testsWith(m[1], src.slice(m.index!, m.index! + 400))) return true;
    }
    for (const m of src.matchAll(new RegExp(`\\b${N}\\s*\\??\\.(some|find|filter|every|findIndex|any|anyMatch)\\(\\s*\\(?\\s*(\\w+)`, "g"))) {
      if (testsWith(m[2], src.slice(m.index!, m.index! + 300))) return true;
    }
  }
  return false;
}

/**
 * In a collection that holds data about models rather than models to use: a membership check, or one named for
 * prices, limits, capabilities, aliases, display names. Applies even to cloud-form IDs (Bedrock, Vertex).
 */
export function inDataCollection(s: Node): boolean {
  let c: Node | null = s.parent;
  while (c && PASS.has(c.type) && !COLLECTIONS.has(c.type)) c = c.parent;
  if (!c || !COLLECTIONS.has(c.type)) return false;
  let up: Node | null = c.parent;
  while (up && (PASS.has(up.type) || up.type === "satisfies_expression")) up = up.parent;
  const table = ROWS.has(c.type) && up && COLLECTIONS.has(up.type) ? up : c;
  return membershipCheck(c) || membershipCheck(table) || inMatchCheck(c) || DATA_OWNER.test(ownerName(c)) || DATA_OWNER.test(ownerName(table)) ||
    (["array", "list", "tuple", "set", "array_initializer"].includes(c.type) && NAME_LIST.test(ownerName(c)));
}

/** A provider's name as a routing table's value */
const PROVIDER_NAME = /^(openai|anthropic|google|gemini|vertex|azure|bedrock|mistral|groq|cohere|deepseek|xai|together|openrouter|perplexity|fireworks|ollama)$/i;
const CALLS = new Set(["call", "call_expression", "new_expression", "object_creation_expression", "method_invocation"]);
/** Keyword arguments that name the row's model */
const ROW_ID = /^(id|name|model|model_?id|model_?name|slug)$/;
/** Fields only a model-info entry has (not a price or a label): it describes a model offered to use */
const INFO_FIELD = /^["']?(max_?(output_?)?tokens|maxTokens|max_?completion_?tokens|context_?(window|length)|contextWindow|supports\w*|modalities|input_?modalities|reasoning|thinking|vision|tool_?call\w*|knowledge_?cutoff|released?|family|tier|capabilities)["']?$/i;

/** Names of an entry's fields: a dict/object's keys, or a constructor's keyword arguments */
function fieldsOf(v: Node | null): string[] {
  if (!v) return [];
  if (v.type === "object" || v.type === "dictionary") return v.namedChildren.filter((c): c is Node => c?.type === "pair").map(keyOf);
  if (CALLS.has(v.type)) {
    const args = v.childForFieldName("arguments");
    return (args?.namedChildren ?? []).filter((c): c is Node => c?.type === "keyword_argument").map((k) => k.childForFieldName("name")?.text ?? "");
  }
  return [];
}

/**
 * A model ID as the key of a registry of model-info entries: { "claude-3-opus-20240229": { maxTokens, contextWindow,
 * supportsImages, … }, … } with at least two such model keys. A map to prices or labels alone isn't one.
 */
function registryKey(s: Node, stringTypes: string[], isModelId: (text: string) => boolean): boolean {
  const pair = s.parent!;
  // the value describes the model ({ maxTokens, contextWindow, … }), or names the provider that serves it ("o1": "openai")
  const isInfo = (p: Node) => {
    const v = p.childForFieldName("value") ?? p.namedChildren[1] ?? null;
    if (v && stringTypes.includes(v.type) && PROVIDER_NAME.test(unquote(v.text))) return true;
    return fieldsOf(v).filter((f) => INFO_FIELD.test(f)).length >= 2;
  };
  if (!isInfo(pair)) return false;
  const map = pair.parent;
  if (!map || !(map.type === "object" || map.type === "dictionary")) return false;
  if (membershipCheck(map) || DATA_OWNER.test(ownerName(map)) || outerOwners(map).some((o) => DATA_OWNER.test(o))) return false;
  let n = 0;
  for (const p of map.namedChildren) {
    if (p?.type !== "pair") continue;
    const k = p.childForFieldName("key") ?? p.namedChildren[0];
    if (k && stringTypes.includes(k.type) && isModelId(unquote(k.text)) && isInfo(p) && ++n >= 2) return true;
  }
  return false;
}

/**
 * A list of models inside a bigger table named for data about models: TOOL_SCHEMA_COMPATIBILITY = [{ models: [...] }],
 * or one used in a prefix/substring test. The list's own name (models:) doesn't decide; the tables around it do.
 */
export function inDataTable(s: Node): boolean {
  let c: Node | null = s.parent;
  while (c && PASS.has(c.type) && !COLLECTIONS.has(c.type)) c = c.parent;
  if (!c || !COLLECTIONS.has(c.type)) return false;
  return inMatchCheck(c) || outerOwners(c).some((o) => DATA_OWNER.test(o));
}

/** Python `class ModelType(str, Enum):` body, treated as a collection of its assigned values */
function isPyEnumBody(n: Node): boolean {
  const cls = n.parent;
  return n.type === "block" && cls?.type === "class_definition" && /\b(Str|Int)?Enum\b|\bstr\b/.test(cls.childForFieldName("superclasses")?.text ?? "");
}

function strings(root: Node, types: string[]): Node[] {
  return root.descendantsOfType(types).filter((x): x is Node => !!x);
}

/**
 * Is this model-ID string a candidate, and how: "listed" (in a collection of models) or "setting" (passed to
 * something model-shaped)? `isModelId` says whether another string is a model ID of any provider.
 */
export function candidateKind(s: Node, stringTypes: string[], isModelId: (text: string) => boolean): "listed" | "setting" | undefined {
  if (inRecordedResponse(s)) return undefined;
  if (isKey(s)) return registryKey(s, stringTypes, isModelId) ? "listed" : undefined;

  // id="…" / name="…" given to something model-shaped: OpenAIChat(id="gpt-4o-mini")
  if (s.parent?.type === "keyword_argument" && /^(id|name|model_id|model_name|model_key)$/.test(s.parent.childForFieldName("name")?.text ?? "")) {
    const call = s.parent.parent?.parent;
    const last = (call?.childForFieldName("function")?.text ?? "").split(".").pop() ?? "";
    if (MODEL_CALL.test(last) && !LOOKUP_CALL.test(last)) return "setting";
  }

  // Picking a model's entry from a table of model configs or clients: supervisor_configs["gpt-4o-mini"], clients['o3']
  const sub = s.parent;
  if (sub && (sub.type === "subscript" || sub.type === "subscript_expression") && (sub.childForFieldName("subscript") ?? sub.childForFieldName("index"))?.id === s.id) {
    const isTarget = (sub.parent?.type === "assignment" || sub.parent?.type === "assignment_expression") && sub.parent.childForFieldName("left")?.id === sub.id;
    const obj = ((sub.childForFieldName("value") ?? sub.childForFieldName("object"))?.text ?? "").split(".").pop() ?? "";
    if (!isTarget && SUBSCRIPT_OWNER.test(obj) && !DATA_OWNER.test(obj) && !NAME_LIST.test(obj) && !COST_CONTEXT.test(obj)) return "setting";
    return undefined;
  }

  // Positional argument to something model-shaped
  let a: Node = s;
  while (a.parent && ["parenthesized_expression", "as_expression"].includes(a.parent.type)) a = a.parent;
  if (a.parent && (a.parent.type === "arguments" || a.parent.type === "argument_list")) {
    const call = a.parent.parent;
    const callee = call?.childForFieldName("function") ?? call?.childForFieldName("constructor") ?? call?.childForFieldName("name") ?? call?.childForFieldName("type");
    const last = (callee?.text ?? "").split(/[.\s:>]/).filter(Boolean).pop() ?? "";
    if (call?.type !== "enum_constant" && MODEL_CALL.test(last) && !LOOKUP_CALL.test(last)) return "setting";
  }

  // In a collection with at least one other model ID (counting the table when this is one row of it)
  let c: Node | null = s.parent;
  while (c && PASS.has(c.type) && !COLLECTIONS.has(c.type)) c = c.parent;
  if (!c) return undefined;
  // A row built by a constructor: { "gpt-5.3-codex": ModelInfo(id="gpt-5.3-codex", …), … }, [Model(name="…"), …]
  if (CALLS.has(c.type) && s.parent?.type === "keyword_argument" && ROW_ID.test(s.parent.childForFieldName("name")?.text ?? "")) {
    let up: Node | null = c.parent;
    while (up && PASS.has(up.type) && !COLLECTIONS.has(up.type)) up = up.parent;
    if (up && COLLECTIONS.has(up.type)) c = up;
  }
  if (!COLLECTIONS.has(c.type) && !isPyEnumBody(c)) return undefined;
  let table = c;
  let up: Node | null = c.parent;
  while (up && (PASS.has(up.type) || up.type === "satisfies_expression")) up = up.parent;
  if (ROWS.has(c.type) && up && COLLECTIONS.has(up.type)) table = up;
  // A [from, to] pair in a table of pairs (Map entries, replacement or lookup rows): the first item is a key
  if (["array", "list", "tuple"].includes(c.type) && c.namedChildren.length === 2 && c.namedChildren[0]?.id === s.id && table !== c) return undefined;
  if (membershipCheck(table) || membershipCheck(c) || inMatchCheck(c)) return undefined;
  if (DATA_OWNER.test(ownerName(table)) || DATA_OWNER.test(ownerName(c)) || outerOwners(table).some((o) => DATA_OWNER.test(o))) return undefined;
  if (s.parent?.type === "pair" && DISPLAY_KEY.test(keyOf(s.parent))) return undefined;
  if (["array", "list", "tuple", "set", "array_initializer"].includes(c.type) && NAME_LIST.test(ownerName(c))) return undefined;
  const ids = new Set<string>();
  for (const t of strings(table, stringTypes)) {
    if (isKey(t)) continue;
    const v = unquote(t.text);
    if (isModelId(v)) ids.add(v);
    if (ids.size >= 2) return "listed";
  }
  return undefined;
}

/**
 * The module-level name of the collection holding this string (export const GEMINI_TTS_MODELS = [...]), so the
 * whole repo can be checked for how it is used. Undefined for a key inside some object (models: [...]).
 */
export function collectionName(s: Node): string | undefined {
  let c: Node | null = s.parent;
  while (c && PASS.has(c.type) && !COLLECTIONS.has(c.type)) c = c.parent;
  if (!c || !COLLECTIONS.has(c.type)) return undefined;
  const def = definitionOf(c);
  if (!def || def.type === "pair") return undefined;
  // at module level: the declaration's statement sits in the program/module
  let n: Node | null = def;
  for (let i = 0; n && i < 4; i++, n = n.parent) if (/^(program|module|source_file)$/.test(n.parent?.type ?? "")) break;
  if (!n || !/^(program|module|source_file)$/.test(n.parent?.type ?? "")) return undefined;
  const name = (def.childForFieldName("name") ?? def.childForFieldName("left"))?.text ?? "";
  return /^[A-Za-z_]\w{3,}$/.test(name) ? name : undefined;
}

/** Keys whose contents document or sample a value rather than set it: example(s), json_schema_extra, x-example */
const EXAMPLE_KEY = /^["']?(examples?|json_schema_extra|schema_extra|x-?examples?|openapi_examples)["']?$/;
/** Calls that only count tokens or look up an encoding for a model name (tiktoken), never send it */
const TOKENIZER_CALL = /tiktoken|encoding_for_model|token_?counter|tokeni[sz]er|count_?tokens|num_?tokens|token_?count|chunk|truncat|encod(e|ing|er)\b|Tokeniz|TokenCounter|Encoding/i;

/**
 * A model name that's documentation or tokenizer input, not a setting: inside an example(s)/json_schema_extra
 * entry, an argument to a tokenizer or token counter, or the default of a parameter of a chunking/token function.
 */
export function inExampleOrTokenizer(s: Node): boolean {
  let n: Node | null = s.parent;
  for (let d = 0; n && d < 8; d++, n = n.parent) {
    if (n.type === "pair" && EXAMPLE_KEY.test((n.childForFieldName("key") ?? n.namedChildren[0])?.text ?? "")) return true;
    if (n.type === "keyword_argument" && EXAMPLE_KEY.test(n.childForFieldName("name")?.text ?? "")) return true;
    if (CALLS.has(n.type) && d < 4) {
      const fn = (n.childForFieldName("function") ?? n.childForFieldName("constructor") ?? n.childForFieldName("name"))?.text ?? "";
      if (TOKENIZER_CALL.test(fn.split(/[.\s]/).pop() ?? "")) return true;
    }
    if (/^(function_definition|function_declaration|method_definition|arrow_function|method_declaration)$/.test(n.type)) {
      // def chunk_text(text, model_name="gpt-4o-mini"): a default of a token/chunk helper's parameter
      const inParams = s.startIndex < (n.childForFieldName("body")?.startIndex ?? 0);
      const name = n.childForFieldName("name")?.text ?? (n.parent?.type === "variable_declarator" ? n.parent.childForFieldName("name")?.text ?? "" : "");
      return inParams && TOKENIZER_CALL.test(name);
    }
  }
  return false;
}
