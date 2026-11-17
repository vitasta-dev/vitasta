/**
 * When does a model ID written outside a call count as a real usage?
 *
 * Only when it is clearly a model *setting*: the value of something named like a model (DEFAULT_MODEL, model:,
 * model_id=, OPENAI_MODEL=), an entry in a list of allowed models (CLAUDE_MODELS = [...]), or the argument of a
 * model factory (anthropic("claude-…"), GenerativeModel("gemini-…")). It does not count as a dictionary key, in
 * pricing/limit/hint/migration tables, in labels or sentences, or in comparisons.
 *
 * Measured on 55 public repos (13 Nov 2026): without this rule only 23% of loose model strings were real usages.
 */
import { hostOfModel } from "../providers.js";
import type { Node } from "./parser.js";

const MODELISH = /model/i;
/** Names that hold model IDs as data, not as the model the app uses */
const NOT_A_SETTING = /hint|prefix|pattern|keyword|famil|pric|cost|limit|token|context|window|alias|retired|deprecat|replacement|legacy|_map$|map$|table|capabilit|label/i;
/** Collections named for a capability are lookup sets, not the models the app uses: NO_SAMPLING_MODELS, REASONING_MODELS */
const CAPABILITY_LIST = /sampling|temperature|reasoning|vision|thinking|(^|_)no_|unsupported|without|feature|cache|tool|json|stream/i;
/** Keys inside a model registry entry: MODELS = [{ name: "gpt-4o-mini", … }] */
const REGISTRY_KEY = /^["']?(name|id|value|slug|model|model_?id|model_?name|modelId|modelName|apiName|api_name)["']?$/;
/** Your own helpers taking a model positionally: generateText(prompt, system, "claude-…"). Not tokenizers or counters. */
const GENERATION_CALL = /(^|\.)(generate|complete|completion|chat|ask|call|invoke|run|query|prompt|send|stream|answer|summari[sz]e|translate|classify|extract|embed)\w*$/i;
const NOT_GENERATION = /token|encod|count|tiktoken|price|cost/i;
/** Calls whose first argument is a model ID: Vercel AI SDK providers, LangChain, Google GenerativeModel, getModel(...) */
const FACTORY = /(^|\.)(anthropic|openai|google|gemini|vertex|bedrock|azure|mistral|xai|groq|createModel|getModel|model|languageModel|GenerativeModel|getGenerativeModel|ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|ChatVertexAI|ChatBedrock(Converse)?)$/;

export function isSettingName(name: string): boolean {
  const last = name.split(/[.\[\]'"]/).filter(Boolean).pop() ?? name;
  return MODELISH.test(last) && !NOT_A_SETTING.test(last);
}

export function isFactoryCall(calleeText: string): boolean {
  return FACTORY.test(calleeText.replace(/\s+/g, ""));
}

function isGenerationCall(calleeText: string): boolean {
  const c = calleeText.replace(/\s+/g, "");
  return GENERATION_CALL.test(c) && !NOT_GENERATION.test(c);
}

/** Bedrock IDs/ARNs and Vertex "@version" IDs are unmistakable and only ever written to be used. */
export function alwaysCounts(model: string): boolean {
  return hostOfModel(model) !== undefined;
}

/** Climb through wrappers that don't change meaning: (x), a || "default", c ? a : b, x as T, x satisfies T. */
function climb(n: Node, wrappers: string[]): Node {
  let cur = n;
  while (cur.parent && wrappers.includes(cur.parent.type)) {
    // a comparison (model === "gpt-4") is a check, not a setting: stop there
    if (cur.parent.type === "binary_expression" && !["||", "??", "+"].includes(cur.parent.childForFieldName("operator")?.text ?? "")) break;
    if (cur.parent.type === "boolean_operator" && cur.parent.childForFieldName("operator")?.text !== "or") break;
    cur = cur.parent;
  }
  return cur;
}

const JS_WRAPPERS = ["parenthesized_expression", "binary_expression", "ternary_expression", "as_expression", "satisfies_expression", "non_null_expression", "await_expression"];

/**
 * How a string counts as a model setting: "setting" (the model code uses: a model-named variable, key, parameter,
 * call argument) or "listed" (an entry in a model list, picker map, registry or type: offered, not necessarily used).
 */
export type SettingKind = "setting" | "listed";
const kindOf = (b: boolean, k: SettingKind): SettingKind | undefined => (b ? k : undefined);

/** A string that's the key of a key/value pair (a lookup table key, not a value) */
export function isPairKey(s: Node, wrappers: string[] = []): boolean {
  const n = climb(s, wrappers);
  return n.parent?.type === "pair" && n.parent.childForFieldName("key")?.id === n.id;
}

/**
 * Inside a collection of models: a list/array item (directly or in an entry object), or the value of a map whose key
 * is itself a model ID ({"claude-x": "claude-x@2025…"}). For IDs that count anywhere, this makes them "listed".
 */
export function inModelCollection(s: Node, isModelId: (text: string) => boolean): boolean {
  let n: Node | null = s;
  for (let depth = 0; n?.parent && depth < 4; depth++, n = n.parent) {
    const p: Node = n.parent;
    if (["list", "tuple", "set", "array"].includes(p.type)) return true;
    if (p.type === "pair" && p.childForFieldName("value")?.id === n.id) {
      const key = p.childForFieldName("key")?.text.replace(/^["'`]|["'`]$/g, "") ?? "";
      if (isModelId(key)) return true;
    }
    if (!["pair", "dictionary", "object", "parenthesized_expression"].includes(p.type)) return false;
  }
  return false;
}

/** A display label ("GPT 4o", "Fast and cheap"), not a colour, number, URL, path or another model ID */
function looksLikeLabel(quoted: string): boolean {
  const t = quoted.replace(/^["'`]|["'`]$/g, "").trim();
  if (!/[A-Za-z]{2}/.test(t)) return false;
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|var\(--|https?:|\/|\.\/)/i.test(t)) return false;
  if (/^[\w./-]+\.(png|svg|jpe?g|webp|ico|json|ya?ml)$/i.test(t)) return false;
  if (/^(bg|text|border|from|to|ring)-[a-z]+-\d{2,3}$/.test(t)) return false; // Tailwind colour classes
  return !/^(gpt-|claude-|gemini-|o\d)/.test(t);
}

/** JS/TS: is this string literal a model setting? */
export function jsSetting(s: Node): boolean {
  return !!jsSettingKind(s);
}

export function jsSettingKind(s: Node): SettingKind | undefined {
  const n = climb(s, JS_WRAPPERS);
  const p = n.parent;
  if (!p) return undefined;
  switch (p.type) {
    case "variable_declarator":
      return kindOf(p.childForFieldName("value")?.id === n.id && isSettingName(p.childForFieldName("name")?.text ?? ""), "setting");
    case "pair": {
      const isValue = p.childForFieldName("value")?.id === n.id;
      if (isValue && isSettingName(p.childForFieldName("key")?.text ?? "")) {
        // { model: "gpt-4o", label: "GPT 4o" } inside a list is a picker entry (a "name" alone may be an agent config)
        const obj = p.parent;
        return obj?.type === "object" && obj.parent?.type === "array" && /\b(label|title|displayName)\s*:/.test(obj.text) ? "listed" : "setting";
      }
      const obj = p.parent;
      // MODELS = [{ name: "gpt-4o-mini", … }]: a registry entry in a list of models
      if (isValue && REGISTRY_KEY.test(p.childForFieldName("key")?.text ?? "") && obj?.parent?.type === "array") {
        return kindOf(listOwnerIsSetting(obj.parent, JS_WRAPPERS, ["variable_declarator", "pair", "assignment_expression"], ownerName), "listed");
      }
      // MODELS = { "gpt-4o": "GPT 4o" }: a picker map keyed by model, with labels (not colours, numbers or model IDs) as values
      if (!isValue && obj?.type === "object") {
        const v = p.childForFieldName("value");
        const labelValue = v?.type === "string" && looksLikeLabel(v.text);
        const entryObject = v?.type === "object" && /\b(label|title|displayName|description|name)\s*:/.test(v.text) && !/\d\s*[,}]/.test(v.text.replace(/["'][^"']*["']/g, ""));
        return kindOf((labelValue || entryObject) && listOwnerIsSetting(obj, JS_WRAPPERS, ["variable_declarator", "pair", "assignment_expression"], ownerName), "listed");
      }
      return undefined;
    }
    case "assignment_expression":
      return kindOf(p.childForFieldName("right")?.id === n.id && isSettingName(p.childForFieldName("left")?.text ?? ""), "setting");
    case "required_parameter":
    case "optional_parameter":
    case "assignment_pattern":
      return kindOf(isSettingName((p.childForFieldName("pattern") ?? p.childForFieldName("left"))?.text ?? ""), "setting");
    case "arguments": {
      const call = p.parent;
      const callee = call?.childForFieldName(call.type === "new_expression" ? "constructor" : "function")?.text ?? "";
      return kindOf((p.namedChildren[0]?.id === n.id && isFactoryCall(callee)) || isGenerationCall(callee), "setting");
    }
    case "array":
      return kindOf(listOwnerIsSetting(p, JS_WRAPPERS, ["variable_declarator", "pair", "assignment_expression"], ownerName, true), "listed");
    case "literal_type": {
      // type ClaudeModel = "claude-…" | "claude-…": the allowed values, so "listed"
      let u: Node | null = p.parent;
      while (u && ["union_type", "parenthesized_type"].includes(u.type)) u = u.parent;
      if (u?.type === "type_alias_declaration") return kindOf(isSettingName(u.childForFieldName("name")?.text ?? ""), "listed");
      // interface Options { model: "gpt-4o" | "gpt-4o-mini" }, or a parameter (model: "a" | "b") => …
      if (u?.type === "type_annotation") {
        const owner = u.parent;
        if (owner?.type === "property_signature" || owner?.type === "public_field_definition") return kindOf(isSettingName(owner.childForFieldName("name")?.text ?? ""), "listed");
        if (owner?.type === "required_parameter" || owner?.type === "optional_parameter") return kindOf(isSettingName(owner.childForFieldName("pattern")?.text ?? ""), "listed");
      }
      return undefined;
    }
    case "return_statement":
      return kindOf(isSettingName(enclosingFunctionName(p) ?? ""), "setting");
    default:
      return undefined;
  }
}

const PY_WRAPPERS = ["parenthesized_expression", "boolean_operator", "conditional_expression"];

/** Python: is this string a model setting? */
export function pySetting(s: Node): boolean {
  return !!pySettingKind(s);
}

export function pySettingKind(s: Node): SettingKind | undefined {
  const n = climb(s, PY_WRAPPERS);
  const p = n.parent;
  if (!p) return undefined;
  switch (p.type) {
    case "assignment":
      return kindOf(p.childForFieldName("right")?.id === n.id && isSettingName(p.childForFieldName("left")?.text ?? ""), "setting");
    case "keyword_argument":
      return kindOf(isSettingName(p.childForFieldName("name")?.text ?? ""), "setting");
    case "default_parameter":
    case "typed_default_parameter":
      return kindOf(isSettingName(p.childForFieldName("name")?.text ?? ""), "setting");
    case "pair": {
      const isValue = p.childForFieldName("value")?.id === n.id;
      const dict = p.parent;
      const inList = !!dict?.parent && ["list", "tuple"].includes(dict.parent.type);
      if (isValue && isSettingName(p.childForFieldName("key")?.text ?? "")) {
        // {"model": "claude-…", "label": "Sonnet"} inside a list is a picker entry (a "name" alone may be an agent config)
        return inList && /["'](label|title|display_name|displayName)["']\s*:/.test(dict!.text) ? "listed" : "setting";
      }
      if (isValue && REGISTRY_KEY.test(p.childForFieldName("key")?.text ?? "") && inList) {
        return kindOf(listOwnerIsSetting(dict!.parent!, PY_WRAPPERS, ["assignment", "keyword_argument", "pair"], ownerName), "listed");
      }
      if (!isValue && dict?.type === "dictionary") {
        const v = p.childForFieldName("value");
        const labelValue = v?.type === "string" && looksLikeLabel(v.text);
        return kindOf(labelValue && listOwnerIsSetting(dict, PY_WRAPPERS, ["assignment", "keyword_argument", "pair"], ownerName), "listed");
      }
      return undefined;
    }
    case "argument_list": {
      const call = p.parent;
      const fn = call?.childForFieldName("function")?.text ?? "";
      // os.environ.get("OPENAI_MODEL", "gpt-4o"): the default of a model-named setting
      if (/(^|\.)(get|getenv)$/.test(fn)) {
        const key = p.namedChildren[0];
        return kindOf((p.namedChildren[1]?.id === n.id && !!key && isSettingName(key.text)) || (call ? pySettingTarget(call) : false), "setting");
      }
      return kindOf((p.namedChildren[0]?.id === n.id && isFactoryCall(fn)) || isGenerationCall(fn), "setting");
    }
    case "list":
    case "tuple":
    case "set":
      return kindOf(listOwnerIsSetting(p, PY_WRAPPERS, ["assignment", "keyword_argument", "pair"], ownerName, true), "listed");
    case "return_statement":
      return kindOf(isSettingName(enclosingFunctionName(p) ?? ""), "setting");
    default:
      return undefined;
  }
}

/** For os.environ.get(...) used as a value: is the thing it's assigned to model-named? */
function pySettingTarget(call: Node): boolean {
  const n = climb(call, PY_WRAPPERS);
  const p = n.parent;
  if (p?.type === "assignment") return isSettingName(p.childForFieldName("left")?.text ?? "");
  if (p?.type === "keyword_argument") return isSettingName(p.childForFieldName("name")?.text ?? "");
  return false;
}

/** Java: is this string literal a model setting? */
export function javaSetting(s: Node): boolean {
  const p = s.parent;
  if (!p) return false;
  if (p.type === "variable_declarator") return isSettingName(p.childForFieldName("name")?.text ?? "");
  if (p.type === "argument_list") {
    const call = p.parent;
    const name = call?.childForFieldName("name")?.text ?? call?.childForFieldName("type")?.text ?? "";
    return isSettingName(name) || isFactoryCall(name);
  }
  if (p.type === "array_initializer") return listOwnerIsSetting(p, [], ["variable_declarator"], (o) => o.childForFieldName("name")?.text ?? "");
  return false;
}

/** Config line "key: value" / "KEY=value" / "\"key\": \"value\"": is the key model-named? */
export function configKeySetting(lineBeforeToken: string): boolean {
  const m = /["']?([\w.\-]+)["']?\s*[:=]\s*["']?\s*$/.exec(lineBeforeToken);
  return !!m && isSettingName(m[1]);
}

function ownerName(o: Node): string {
  return (o.childForFieldName("name") ?? o.childForFieldName("key") ?? o.childForFieldName("left"))?.text ?? "";
}

function listOwnerIsSetting(list: Node, wrappers: string[], owners: string[], nameOf: (o: Node) => string, isCollection = false): boolean {
  const n = climb(list, wrappers);
  const o = n.parent;
  if (!o || !owners.includes(o.type)) return false;
  const name = nameOf(o);
  return isSettingName(name) && !(isCollection && CAPABILITY_LIST.test(name));
}

function enclosingFunctionName(n: Node): string | undefined {
  let cur: Node | null = n.parent;
  while (cur) {
    if (/function|method/.test(cur.type)) {
      const name = cur.childForFieldName("name")?.text;
      if (name) return name;
      // const getModel = () => …
      if (cur.parent?.type === "variable_declarator") return cur.parent.childForFieldName("name")?.text;
      return undefined;
    }
    cur = cur.parent;
  }
  return undefined;
}
