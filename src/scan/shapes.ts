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

/** Containers whose items or values can be a set of models */
const COLLECTIONS = new Set(["array", "list", "tuple", "set", "object", "dictionary", "array_initializer", "enum_body", "enum_declaration"]);
/** Containers that are one row of a bigger table */
const ROWS = new Set(["array", "list", "tuple", "object", "dictionary", "array_initializer", "argument_list", "arguments"]);
/** Wrappers between a string and its container that don't change meaning */
const PASS = new Set(["pair", "enum_assignment", "enum_constant", "argument_list", "arguments", "parenthesized_expression", "expression_statement", "assignment", "spread_element", "as_expression", "satisfies_expression", "keyword_argument"]);

/** Collections named for data about models, not the models an app uses */
export const DATA_OWNER = /pric|cost|saving|limit|token|context_?(window|length|size)|max_?context|window|capabilit|famil|hint|pattern|keyword|prefix|retired|deprecat|legacy|sunset|eol|support|feature|cutoff|bench|score|rank|leader|elo|rating|vision|reasoning|thinking|sampling|temperature|(^|_)no_|unsupported|without|cache|stream|json|tool|encod|tokeni[sz]|histor|region|placeholder|example|display|pretty|label|title/i;
/** Lists (not maps) of other names or versions for one entry: aliases: [...], snapshots: [...], unresolved: [...] */
export const NAME_LIST = /alias|snapshot|unresolved|variant|other_?names|synonym/i;

/** Callee names that take a model to use: get_chat_model, init_chat_model, ChatModel(...), new LLMLoop(...), create_agent */
const MODEL_CALL = /model|llm|chat|agent/i;
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

/** A collection used to check membership: `model in [...]`, `[...].includes(model)`, `Set.of(...).contains(m)` */
function membershipCheck(c: Node): boolean {
  const p = c.parent;
  if (!p) return false;
  if (p.type === "comparison_operator") return true; // python `x in [...]`
  if (p.type === "member_expression" || p.type === "attribute" || p.type === "field_access") return true; // [...].includes(m)
  if (p.type === "binary_expression" && p.childForFieldName("right")?.id === c.id) return /\bin\b/.test(p.text);
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
  return membershipCheck(c) || membershipCheck(table) || DATA_OWNER.test(ownerName(c)) || DATA_OWNER.test(ownerName(table)) ||
    (["array", "list", "tuple", "set", "array_initializer"].includes(c.type) && NAME_LIST.test(ownerName(c)));
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
  if (isKey(s) || inRecordedResponse(s)) return undefined;

  // id="…" / name="…" given to something model-shaped: OpenAIChat(id="gpt-4o-mini")
  if (s.parent?.type === "keyword_argument" && /^(id|name|model_id|model_name|model_key)$/.test(s.parent.childForFieldName("name")?.text ?? "")) {
    const call = s.parent.parent?.parent;
    const last = (call?.childForFieldName("function")?.text ?? "").split(".").pop() ?? "";
    if (MODEL_CALL.test(last) && !LOOKUP_CALL.test(last)) return "setting";
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
  if (!COLLECTIONS.has(c.type) && !isPyEnumBody(c)) return undefined;
  let table = c;
  let up: Node | null = c.parent;
  while (up && (PASS.has(up.type) || up.type === "satisfies_expression")) up = up.parent;
  if (ROWS.has(c.type) && up && COLLECTIONS.has(up.type)) table = up;
  // A [from, to] pair in a table of pairs (Map entries, replacement or lookup rows): the first item is a key
  if (["array", "list", "tuple"].includes(c.type) && c.namedChildren.length === 2 && c.namedChildren[0]?.id === s.id && table !== c) return undefined;
  if (membershipCheck(table) || membershipCheck(c)) return undefined;
  if (DATA_OWNER.test(ownerName(table)) || DATA_OWNER.test(ownerName(c))) return undefined;
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
