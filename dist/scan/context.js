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
import { nameMatcher } from "./names.js";
const MODELISH = /model|(^|[_.-])llm([_-]?(name|id))?$|^llm(Name|Id)?$|deployment[_-]?name$|deploymentName$/i;
/** Names that hold model IDs as data, not as the model the app uses */
const NOT_A_SETTING = nameMatcher(/prefix|keyword|famil|pric|cost|limit|token|context|alias|retired|deprecat|replacement|legacy|_map$|map$|capabilit|placeholder/i, 
// whole words only: ClaudeModel holds "demo" and StableModel "table", and both are settings
["hint", "pattern", "window", "table", "label", "example", "sample", "demo", "seed", "display"]);
/** A map from model ID to a display name is for showing results, not a picker: MODEL_NAMES, DISPLAY_NAMES */
const DISPLAY_MAP = /names$|_names|display|pretty|title|label|readable|friendly|human/i;
/** Collections named for a capability are lookup sets, not the models the app uses: NO_SAMPLING_MODELS, REASONING_MODELS */
const CAPABILITY_LIST = /sampling|temperature|reasoning|vision|thinking|(^|_)no_|unsupported|without|feature|cache|tool|json|stream/i;
/** Keys inside a model registry entry: MODELS = [{ name: "gpt-4o-mini", … }] */
const REGISTRY_KEY = /^["']?(name|id|value|slug|model|model_?id|model_?name|modelId|modelName|apiName|api_name)["']?$/;
/** Your own helpers taking a model positionally: generateText(prompt, system, "claude-…"). Not tokenizers or counters. */
const GENERATION_CALL = /(^|\.)(generate|complete|completion|chat|ask|call|invoke|run|query|prompt|send|stream|answer|summari[sz]e|translate|classify|extract|embed)\w*$/i;
const NOT_GENERATION = /token|encod|count|tiktoken|price|cost/i;
/** Calls whose first argument is a model ID: Vercel AI SDK providers, LangChain, Google GenerativeModel, getModel(...) */
const FACTORY = /(^|\.)(anthropic|openai|google|gemini|vertex|bedrock|azure|mistral|xai|groq|createModel|getModel|model|languageModel|GenerativeModel|getGenerativeModel|ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI|ChatVertexAI|ChatBedrock(Converse)?)$/;
/** A string literal naming a flag or key: '--judge-model' → judge-model, "MODEL" → MODEL; anything else → "" */
function flagName(n) {
    if (!n || !/^(string|string_literal|template_string)$/.test(n.type))
        return "";
    const t = n.text.replace(/^[a-zA-Z]{0,2}["'`]+|["'`]+$/g, "");
    if (/^-{0,2}[\w.-]{1,60}$/.test(t))
        return t.replace(/^-+/, "");
    // A CLI flag spec: "-m, --model <model>", "--model [name]": the long flag's name
    const long = t.length <= 80 && t.startsWith("-") ? /--([\w.-]{1,60})/.exec(t)?.[1] : undefined;
    return long ?? "";
}
/**
 * The default of a model-named flag, key or option given as the next argument: getArg('--model', 'claude-…'),
 * config.get("judge_model", "gpt-4o"), getOrDefault("model", "…"), options.option('model', { default: '…' }).
 */
function namedDefault(args, n) {
    const items = args.namedChildren.filter((x) => !!x && x.type !== "comment");
    if (items.length < 2)
        return false;
    // The default right after the flag, or after the flag and a description: .option(flags, "TTS model", "tts-1")
    const second = items[1].id === n.id;
    const third = items.length >= 3 && items[2].id === n.id && /^(string|string_literal|template_string)$/.test(items[1].type) && !!flagName(items[0]) && /^["'`]?-/.test(items[0].text);
    if (!second && !third)
        return false;
    return isSettingName(flagName(items[0]));
}
/** A class that wraps one provider's model in agent frameworks (agno Claude, OpenAIChat, Gemini, ChatMistral…) */
const MODEL_CLASS = /^(?:Chat|Async)?(?:Claude|Anthropic|OpenAI|OpenAIChat|AzureOpenAI|GPT|Gemini|Google|VertexAI|Mistral|MistralChat|Groq|DeepSeek|Cohere|CohereChat|Bedrock|AwsBedrock|Ollama|xAI|Grok|LiteLLM|Perplexity|Together|Fireworks)(?:Chat|Model|LLM)?$/;
/**
 * DEFAULT_PROVIDER = "openai/gpt-4o", LLM = "anthropic:claude-…": a provider-and-model route string assigned to one
 * provider- or LLM-named variable (a route is unmistakably a model choice; lists and maps of them aren't this case)
 */
function routeSetting(name, literal) {
    const last = name.split(/[.\[\]'"]/).filter(Boolean).pop() ?? name;
    return /(^|_|[a-z])(provider|llm)s?$|^(llm|provider)(_|$)/i.test(last) && /^[a-zA-Z]?["'`][a-z][\w-]*[/:][\w.:@-]+["'`]$/.test(literal.trim());
}
export function isSettingName(name) {
    const last = name.split(/[.\[\]'"]/).filter(Boolean).pop() ?? name;
    return MODELISH.test(last) && !NOT_A_SETTING.test(last);
}
export function isFactoryCall(calleeText) {
    return FACTORY.test(calleeText.replace(/\s+/g, ""));
}
function isGenerationCall(calleeText) {
    const c = calleeText.replace(/\s+/g, "");
    return GENERATION_CALL.test(c) && !NOT_GENERATION.test(c);
}
/** Bedrock IDs/ARNs and Vertex "@version" IDs are unmistakable and only ever written to be used. */
export function alwaysCounts(model) {
    return hostOfModel(model) !== undefined;
}
/** Climb through wrappers that don't change meaning: (x), a || "default", c ? a : b, x as T, x satisfies T. */
function climb(n, wrappers) {
    let cur = n;
    while (cur.parent && wrappers.includes(cur.parent.type)) {
        // a comparison (model === "gpt-4") is a check, not a setting: stop there
        if (cur.parent.type === "binary_expression" && !["||", "??", "+"].includes(cur.parent.childForFieldName("operator")?.text ?? ""))
            break;
        if (cur.parent.type === "boolean_operator" && cur.parent.childForFieldName("operator")?.text !== "or")
            break;
        cur = cur.parent;
    }
    return cur;
}
const JS_WRAPPERS = ["parenthesized_expression", "binary_expression", "ternary_expression", "as_expression", "satisfies_expression", "non_null_expression", "await_expression"];
const kindOf = (b, k) => (b ? k : undefined);
/** A string that's the key of a key/value pair (a lookup table key, not a value) */
export function isPairKey(s, wrappers = []) {
    const n = climb(s, wrappers);
    return n.parent?.type === "pair" && n.parent.childForFieldName("key")?.id === n.id;
}
/**
 * Inside a collection of models: a list/array item (directly or in an entry object), or the value of a map whose key
 * is itself a model ID ({"claude-x": "claude-x@2025…"}). For IDs that count anywhere, this makes them "listed".
 */
export function inModelCollection(s, isModelId) {
    let n = s;
    for (let depth = 0; n?.parent && depth < 4; depth++, n = n.parent) {
        const p = n.parent;
        if (["list", "tuple", "set", "array"].includes(p.type))
            return true;
        if (p.type === "pair" && p.childForFieldName("value")?.id === n.id) {
            const key = p.childForFieldName("key")?.text.replace(/^["'`]|["'`]$/g, "") ?? "";
            if (isModelId(key))
                return true;
        }
        if (!["pair", "dictionary", "object", "parenthesized_expression"].includes(p.type))
            return false;
    }
    return false;
}
/** A display label ("GPT 4o", "Fast and cheap"), not a colour, number, URL, path or another model ID */
function looksLikeLabel(quoted) {
    const t = quoted.replace(/^["'`]|["'`]$/g, "").trim();
    if (!/[A-Za-z]{2}/.test(t))
        return false;
    if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|var\(--|https?:|\/|\.\/)/i.test(t))
        return false;
    if (/^[\w./-]+\.(png|svg|jpe?g|webp|ico|json|ya?ml)$/i.test(t))
        return false;
    if (/^(bg|text|border|from|to|ring)-[a-z]+-\d{2,3}$/.test(t))
        return false; // Tailwind colour classes
    return !/^(gpt-|claude-|gemini-|o\d)/.test(t);
}
/** JS/TS: is this string literal a model setting? */
export function jsSetting(s) {
    return !!jsSettingKind(s);
}
export function jsSettingKind(s) {
    // process.env.LLM_MODEL ?? "gpt-4o": a model ID as an environment variable's fallback is configuration
    const b = s.parent;
    if (b?.type === "binary_expression" && b.childForFieldName("right")?.id === s.id && /^(\?\?|\|\|)$/.test(b.childForFieldName("operator")?.text ?? "") && /^(process\.env|import\.meta\.env)(\.|\[)|^Deno\.env\.get\(/.test(b.childForFieldName("left")?.text ?? ""))
        return "setting";
    // x.model ??= "gpt-4o" / x.model ||= "…": a default for a model setting
    if (b?.type === "augmented_assignment_expression" && b.childForFieldName("right")?.id === s.id && /^(\?\?=|\|\|=)$/.test(b.childForFieldName("operator")?.text ?? "") && isSettingName((b.childForFieldName("left")?.text ?? "").split(".").pop() ?? ""))
        return "setting";
    const n = climb(s, JS_WRAPPERS);
    const p = n.parent;
    if (!p)
        return undefined;
    switch (p.type) {
        case "variable_declarator":
            return kindOf(p.childForFieldName("value")?.id === n.id && (isSettingName(p.childForFieldName("name")?.text ?? "") || routeSetting(p.childForFieldName("name")?.text ?? "", n.text)), "setting");
        case "pair": {
            const isValue = p.childForFieldName("value")?.id === n.id;
            if (isValue && (optionObjectDefault(n) || descriptorDefault(n)))
                return "setting";
            // const model: Model<"…"> = { id: "gpt-5.1-codex", … }, { model: { id: "…" } }: the id of a model object
            if (isValue && /^["']?(id|model_?id|modelId|name)["']?$/.test(p.childForFieldName("key")?.text ?? "") && p.parent?.type === "object" && isModelObject(p.parent))
                return "setting";
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
                return kindOf((labelValue || entryObject) && listOwnerIsSetting(obj, JS_WRAPPERS, ["variable_declarator", "pair", "assignment_expression"], ownerName) && !DISPLAY_MAP.test(ownerOf(obj, JS_WRAPPERS)), "listed");
            }
            return undefined;
        }
        case "assignment_expression":
            return kindOf(p.childForFieldName("right")?.id === n.id && isSettingName(p.childForFieldName("left")?.text ?? ""), "setting");
        case "required_parameter":
        case "optional_parameter":
        case "assignment_pattern":
        case "object_assignment_pattern":
            // ({ defaultModel = "openai/gpt-4.1" }) => …: a default in a destructured parameter, too
            return kindOf(isSettingName((p.childForFieldName("pattern") ?? p.childForFieldName("left"))?.text ?? ""), "setting");
        case "arguments": {
            const call = p.parent;
            const callee = call?.childForFieldName(call.type === "new_expression" ? "constructor" : "function")?.text ?? "";
            return kindOf((p.namedChildren[0]?.id === n.id && isFactoryCall(callee)) || isGenerationCall(callee) || namedDefault(p, n) || schemaDefault(call, callee), "setting");
        }
        case "array":
            return kindOf(listOwnerIsSetting(p, JS_WRAPPERS, ["variable_declarator", "pair", "assignment_expression"], ownerName, true), "listed");
        case "literal_type": {
            // type ClaudeModel = "claude-…" | "claude-…": the allowed values, so "listed"
            let u = p.parent;
            while (u && ["union_type", "parenthesized_type"].includes(u.type))
                u = u.parent;
            if (u?.type === "type_alias_declaration")
                return kindOf(isSettingName(u.childForFieldName("name")?.text ?? ""), "listed");
            // interface Options { model: "gpt-4o" | "gpt-4o-mini" }, or a parameter (model: "a" | "b") => …
            if (u?.type === "type_annotation") {
                const owner = u.parent;
                if (owner?.type === "property_signature" || owner?.type === "public_field_definition")
                    return kindOf(isSettingName(owner.childForFieldName("name")?.text ?? ""), "listed");
                if (owner?.type === "required_parameter" || owner?.type === "optional_parameter")
                    return kindOf(isSettingName(owner.childForFieldName("pattern")?.text ?? ""), "listed");
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
export function pySetting(s) {
    return !!pySettingKind(s);
}
export function pySettingKind(s) {
    const n = climb(s, PY_WRAPPERS);
    const p = n.parent;
    if (!p)
        return undefined;
    switch (p.type) {
        case "assignment":
            return kindOf(p.childForFieldName("right")?.id === n.id && (isSettingName(p.childForFieldName("left")?.text ?? "") || routeSetting(p.childForFieldName("left")?.text ?? "", n.text)), "setting");
        case "keyword_argument": {
            const k = p.childForFieldName("name")?.text ?? "";
            // add_argument("--model", default="gpt-4o"), click.option("--judge-model", default=…)
            if (/^(default|default_value|initial|value)$/.test(k) && p.parent?.type === "argument_list") {
                // qa_model: str = Field(default="gpt-4.1-mini"), judge_model = field(default="…")
                const call = p.parent.parent;
                return kindOf(isSettingName(flagName(p.parent.namedChildren[0])) || (!!call && pySettingTarget(call)), "setting");
            }
            if (/^(id|model_id|model_name)$/.test(k) && p.parent?.type === "argument_list" && MODEL_CLASS.test(p.parent.parent?.childForFieldName("function")?.text.split(".").pop() ?? ""))
                return "setting";
            return kindOf(isSettingName(k), "setting");
        }
        case "default_parameter":
        case "typed_default_parameter":
            return kindOf(isSettingName(p.childForFieldName("name")?.text ?? ""), "setting");
        case "pair": {
            const isValue = p.childForFieldName("value")?.id === n.id;
            const dict = p.parent;
            const inList = !!dict?.parent && ["list", "tuple"].includes(dict.parent.type);
            if (isValue && isSettingName(p.childForFieldName("key")?.text ?? "")) {
                // {"model": "claude-…", "label": "Sonnet"} inside a list is a picker entry (a "name" alone may be an agent config)
                return inList && /["'](label|title|display_name|displayName)["']\s*:/.test(dict.text) ? "listed" : "setting";
            }
            if (isValue && REGISTRY_KEY.test(p.childForFieldName("key")?.text ?? "") && inList) {
                return kindOf(listOwnerIsSetting(dict.parent, PY_WRAPPERS, ["assignment", "keyword_argument", "pair"], ownerName), "listed");
            }
            if (!isValue && dict?.type === "dictionary") {
                const v = p.childForFieldName("value");
                const labelValue = v?.type === "string" && looksLikeLabel(v.text);
                return kindOf(labelValue && listOwnerIsSetting(dict, PY_WRAPPERS, ["assignment", "keyword_argument", "pair"], ownerName) && !DISPLAY_MAP.test(ownerOf(dict, PY_WRAPPERS)), "listed");
            }
            return undefined;
        }
        case "argument_list": {
            const call = p.parent;
            const fn = call?.childForFieldName("function")?.text ?? "";
            if (namedDefault(p, n))
                return "setting";
            // os.environ.get("OPENAI_MODEL", "gpt-4o"): the default of a model-named setting
            // os.getenv("LLM_PROVIDER", "openai/gpt-4o"): a model ID as an environment variable's default is configuration
            if (/(^|\.)(environ\.get|getenv|environ\.setdefault)$/.test(fn) && p.namedChildren[1]?.id === n.id)
                return "setting";
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
function pySettingTarget(call) {
    const n = climb(call, PY_WRAPPERS);
    const p = n.parent;
    if (p?.type === "assignment")
        return isSettingName(p.childForFieldName("left")?.text ?? "");
    if (p?.type === "keyword_argument")
        return isSettingName(p.childForFieldName("name")?.text ?? "");
    return false;
}
/** Java: is this string literal a model setting? */
export function javaSetting(s) {
    const p = s.parent;
    if (!p)
        return false;
    if (p.type === "variable_declarator")
        return isSettingName(p.childForFieldName("name")?.text ?? "");
    if (p.type === "argument_list") {
        const call = p.parent;
        const name = call?.childForFieldName("name")?.text ?? call?.childForFieldName("type")?.text ?? "";
        return isSettingName(name) || isFactoryCall(name) || namedDefault(p, s) || keyedGetterDefault(name, p, s);
    }
    if (p.type === "array_initializer")
        return listOwnerIsSetting(p, [], ["variable_declarator"], (o) => o.childForFieldName("name")?.text ?? "");
    return javaModelReturn(s);
}
/**
 * A preference or config getter's default under a model-named key: prefs.getString(KEY_MODEL, "gpt-3.5-turbo"),
 * props.getProperty(Keys.MODEL, "…"), map.getOrDefault(MODEL_KEY, "…")
 */
function keyedGetterDefault(callName, args, n) {
    if (!/^(?:get(?:String|OrDefault|Property|Value|Or)?|opt(?:String)?|read(?:String)?|getConfig\w*)$/.test(callName))
        return false;
    const items = args.namedChildren.filter((x) => !!x && x.type !== "comment");
    if (items.length !== 2 || items[1].id !== n.id)
        return false;
    const key = items[0];
    const name = key.type === "identifier" ? key.text : key.type === "field_access" ? (key.childForFieldName("field")?.text ?? "") : flagName(key);
    return !!name && isSettingName(name);
}
/**
 * Java: a model id a model-named method returns (getDefaultModel(): return "…", a switch arm case "x" -> "…" or
 * case "x": return "…", a ternary branch)
 */
function javaModelReturn(s) {
    let n = s;
    for (let up = 0; up < 6 && n.parent; up++) {
        const p = n.parent;
        if (p.type === "return_statement" || p.type === "yield_statement" || p.type === "switch_rule")
            return modelNamedMethod(p);
        if (!/^(?:ternary_expression|parenthesized_expression|expression_statement|switch_block_statement_group)$/.test(p.type))
            return false;
        n = p;
    }
    return false;
}
function modelNamedMethod(n) {
    for (let p = n.parent; p; p = p.parent) {
        if (p.type === "method_declaration")
            return isSettingName(p.childForFieldName("name")?.text ?? "");
        if (p.type === "class_body" || p.type === "lambda_expression")
            return false;
    }
    return false;
}
/**
 * Line-based (PHP, C#): a model id returned by a model-named function: `return "…"`, a match / switch arm
 * (`'anthropic' => 'claude-…'`, `"x" => "…",` in a C# switch expression, `case "x": return "…"`), or a ternary
 * branch, in the nearest function above whose name says model (defaultModel, GetDefaultModel, resolveModel)
 *
 */
export function modelFunctionReturn(lines, row, before) {
    const ret = /(?:\breturn\s+|\byield\s+|=>\s*|->\s*|\?\s*|:\s*)$/.exec(before);
    if (!ret)
        return false;
    const arm = /(?:=>|->)\s*$/.test(before);
    const colon = /:\s*$/.test(before) && !/\?/.test(before) && !/\bcase\b|\bdefault\b/.test(before);
    if (colon)
        return false;
    let sawSwitch = false;
    for (let r = row; r >= Math.max(0, row - 80); r--) {
        const l = lines[r] ?? "";
        if (/\b(?:match|switch)\s*[({]|\bswitch\b/.test(l))
            sawSwitch = true;
        const fn = /\bfunction\s+&?(\w+)\s*\(|^\s*(?:(?:public|private|protected|internal|static|async|override|virtual|final|abstract)\s+)+[\w<>\[\]?,. ]+?\s+(\w+)\s*\(/.exec(l);
        if (fn) {
            if (arm && !sawSwitch)
                return false;
            return isSettingName(fn[1] ?? fn[2]);
        }
        // another declaration (a class) above the line: not inside a function
        if (r < row && /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|partial)\s+)*(?:class|interface|trait|enum|record|struct)\s+\w+/.test(l))
            return false;
    }
    return false;
}
/** Config line "key: value" / "KEY=value" / "\"key\": \"value\"": is the key model-named? */
export function configKeySetting(lineBeforeToken) {
    const m = /["']?([\w.\-]+)["']?\s*[:=]\s*["']?\s*$/.exec(lineBeforeToken.slice(-256));
    return !!m && isSettingName(m[1]);
}
function ownerName(o) {
    return (o.childForFieldName("name") ?? o.childForFieldName("key") ?? o.childForFieldName("left"))?.text ?? "";
}
function ownerOf(list, wrappers) {
    const o = climb(list, wrappers).parent;
    return o ? ownerName(o) : "";
}
function listOwnerIsSetting(list, wrappers, owners, nameOf, isCollection = false) {
    const n = climb(list, wrappers);
    const o = n.parent;
    if (!o || !owners.includes(o.type))
        return false;
    const name = nameOf(o);
    return isSettingName(name) && !(isCollection && CAPABILITY_LIST.test(name));
}
function enclosingFunctionName(n) {
    let cur = n.parent;
    while (cur) {
        if (/function|method/.test(cur.type)) {
            const name = cur.childForFieldName("name")?.text;
            if (name)
                return name;
            // const getModel = () => …
            if (cur.parent?.type === "variable_declarator")
                return cur.parent.childForFieldName("name")?.text;
            return undefined;
        }
        cur = cur.parent;
    }
    return undefined;
}
/** { default: "gpt-4o" } given right after a model-named flag: yargs.option('model', { default: … }) */
export function optionObjectDefault(s) {
    const pair = s.parent;
    if (pair?.type !== "pair" || pair.childForFieldName("value")?.id !== s.id)
        return false;
    if (!/^["']?(default|defaultValue|default_value|initial)["']?$/.test(pair.childForFieldName("key")?.text ?? ""))
        return false;
    const obj = pair.parent;
    const args = obj?.parent;
    if (!obj || !args || args.type !== "arguments")
        return false;
    const items = args.namedChildren.filter((x) => !!x);
    const i = items.findIndex((x) => x.id === obj.id);
    return i > 0 && isSettingName(flagName(items[i - 1]));
}
const DEFAULT_KEY = /^["']?(default|defaultValue|default_value|initial|initialValue)["']?$/;
/** The string value of `key: "…"` among an object's pairs */
function pairValue(obj, key) {
    for (const c of obj.namedChildren) {
        if (c?.type !== "pair" || !key.test(c.childForFieldName("key")?.text ?? ""))
            continue;
        const v = c.childForFieldName("value");
        if (v?.type === "string")
            return v.text.replace(/^["'`]|["'`]$/g, "");
    }
    return undefined;
}
/**
 * A property descriptor's default, where the descriptor names a model setting: form and node definitions such as
 * { name: "model", type: "options", default: "gpt-4o" } and resource locators
 * { name: "model", type: "resourceLocator", default: { mode: "list", value: "claude-…" } }.
 * The setting is named by the descriptor's `name` (or `id`/`key`), not by the `default` key itself.
 */
export function descriptorDefault(s) {
    let pair = s.parent;
    if (pair?.type !== "pair" || pair.childForFieldName("value")?.id !== s.id)
        return false;
    // default: { mode: "list", value: "…" }: step out of the value object to the `default` pair
    if (/^["']?(value|id)["']?$/.test(pair.childForFieldName("key")?.text ?? "") && pair.parent?.type === "object" && pair.parent.parent?.type === "pair") {
        pair = pair.parent.parent;
    }
    if (!DEFAULT_KEY.test(pair.childForFieldName("key")?.text ?? ""))
        return false;
    const descriptor = pair.parent;
    if (descriptor?.type !== "object")
        return false;
    const name = pairValue(descriptor, /^["']?(name|id|key)["']?$/) ?? pairValue(descriptor, /^["']?(displayName|display_name|label|title)["']?$/);
    return !!name && isSettingName(name);
}
/** model: z.string().default("gpt-4o"), MODEL: Joi.string().default("…"): a schema default under a model-named key */
function schemaDefault(call, callee) {
    if (!call || !/\.(default|catch|withDefault)$/.test(callee))
        return false;
    let n = call;
    // the rest of the chain: .default("x").describe("…")
    while (n.parent && (n.parent.type === "member_expression" || n.parent.type === "call_expression"))
        n = n.parent;
    const p = n.parent;
    if (p?.type === "pair")
        return p.childForFieldName("value")?.id === n.id && isSettingName(p.childForFieldName("key")?.text ?? "");
    if (p?.type === "variable_declarator")
        return isSettingName(p.childForFieldName("name")?.text ?? "");
    return false;
}
/** An object that is one model's description: assigned to a model-named variable or key, or typed as a Model */
function isModelObject(obj) {
    let n = obj;
    while (n.parent && ["parenthesized_expression", "as_expression", "satisfies_expression"].includes(n.parent.type))
        n = n.parent;
    const p = n.parent;
    if (!p)
        return false;
    if (p.type === "variable_declarator") {
        const name = p.childForFieldName("name")?.text ?? "";
        const type = p.childForFieldName("type")?.text ?? "";
        return /^model$|Model$|^(default|selected|current|active)_?model$/i.test(name) || /:\s*(\w+\.)?(Model|LanguageModel|ChatModel)\b/.test(type);
    }
    if (p.type === "pair")
        return /^["']?(model|default_?model|defaultModel)["']?$/.test(p.childForFieldName("key")?.text ?? "");
    return false;
}
