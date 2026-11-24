/**
 * Call map pilot (TS/JS and Python): a per-file index of structure, and links across files.
 *
 * Per file: imports (local name → module and imported name), exports and re-exports, top-level definitions with
 * their line ranges and members, and call sites (the callee's dotted name and the argument key names). Structure
 * only: no code text, no string values, so an index can be cached without holding a customer's code.
 *
 * Links follow imports, re-exports (export { x } from, export * from, Python's re-exported imports), default
 * exports and module.exports. A link that can't be resolved exactly is left out: a missed link is better than a
 * wrong one. Aliased imports (@/x, ~/x, src/x) and absolute Python modules resolve only to one file in the repo.
 */
import type { Node, Tree } from "./parser.js";
import { collectGarbage } from "./gc.js";
import { aiSdkFactories, blankCode, closeAt, PARAM_NAMES, PROVIDER_OPS, topKeys } from "./aisdk.js";
import { named, nodesOfType } from "./parser.js";
import type { Usage } from "../types.js";

export type CmLang = "ts" | "js" | "py";

export interface CmImport {
  local: string;
  spec: string;
  /** The imported name; "default" for a default import, "*" for a namespace or module import */
  name: string;
  line: number;
}
export interface CmExport {
  name: string;
  /** The local definition it names (export { a as b }: local a, name b) */
  local?: string;
  /** Re-exported from another module: export { a as b } from "./x" (from a), export * from "./x" (name "*") */
  spec?: string;
  from?: string;
}
export interface CmDef {
  name: string;
  kind: "function" | "class" | "object" | "value";
  /** 1-based line range */
  start: number;
  end: number;
  members?: { name: string; start: number; end: number; params?: string[] }[];
  params?: string[];
  /** A module-level instance: the callee of its initializer (stripe_service = StripeService()) */
  inst?: string;
}
export interface CmCall {
  /** Dotted callee: graphRequest.get, this.client.messages.create, stripe_service.create_payment_intent */
  callee: string;
  line: number;
  /** Keyword argument names (Python) or the keys of an object literal argument (JS) */
  keys?: string[];
  /** Names spread into the call: **params, ...options */
  spreads?: string[];
  /** Plain names passed by position (create(params)), by index; undefined for other arguments */
  args?: (string | null)[];
}
export interface FileIndex {
  v: 1;
  lang: CmLang;
  imports: CmImport[];
  exports: CmExport[];
  defs: CmDef[];
  calls: CmCall[];
  /** Kept without its calls (a file with no provider findings): CallMap.callsOf reads them again when a trace needs them */
  slim?: true;
  /** Lines with any call, also the ones not kept in `calls` */
  callLines?: number[];
}

const MAX_CALLS = 5000;
const DOTTED = /^(?:this|self|[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*)*$/;
const unq = (s: string) => s.replace(/^[`'"]|[`'"]$/g, "");
const line = (n: Node) => n.startPosition.row + 1;
const endLine = (n: Node) => n.endPosition.row + 1;

/** Index one parsed file */
export function indexFile(lang: CmLang, tree: Tree): FileIndex {
  return pruneCalls(lang === "py" ? indexPy(tree) : indexJs(tree));
}

/** Receivers and functions no trace goes through (console.log, JSON.stringify, len(), describe()) */
const IDLE_ROOTS = new Set(["console", "Math", "JSON", "Object", "Array", "Promise", "String", "Number", "Boolean", "Date", "Reflect", "Symbol", "Buffer", "path", "os"]);
const IDLE_CALLS = new Set(["require", "expect", "describe", "it", "test", "beforeEach", "afterEach", "beforeAll", "afterAll", "setTimeout", "clearTimeout", "setInterval", "parseInt", "parseFloat", "len", "isinstance", "str", "int", "float", "bool", "list", "tuple", "set", "range", "print", "enumerate", "zip", "sorted", "getattr", "hasattr", "super"]);
/**
 * Keep the calls a link or a trace can use: a function called by name, a member of an imported name, a module-level
 * definition or this/self, and any call passing keys, spreads or names on. Member calls on other receivers that pass
 * none of these (res.json(), items.map(fn => …) without a name) can't carry anything a trace follows.
 */
function pruneCalls(idx: FileIndex): FileIndex {
  idx.callLines = [...new Set(idx.calls.map((c) => c.line))];
  const roots = new Set<string>(["this", "self", "cls"]);
  for (const im of idx.imports) roots.add(im.local);
  for (const d of idx.defs) roots.add(d.name);
  idx.calls = idx.calls.filter((c) => {
    const callee = c.callee.startsWith("new ") ? c.callee.slice(4) : c.callee;
    const dot = callee.indexOf(".");
    if (dot < 0) return !IDLE_CALLS.has(callee);
    const root = callee.slice(0, dot);
    if (IDLE_ROOTS.has(root)) return false;
    return roots.has(root) || !!(c.keys?.length || c.spreads?.length || c.args?.some(Boolean));
  });
  return idx;
}

function calleeName(n: Node | null): string | undefined {
  if (!n) return undefined;
  const t = n.text.replace(/\s+/g, "").replace(/\?\./g, ".");
  return t.length <= 160 && DOTTED.test(t) ? t : undefined;
}

function indexJs(tree: Tree): FileIndex {
  const root = tree.rootNode;
  const imports: CmImport[] = [];
  const exports: CmExport[] = [];
  const defs: CmDef[] = [];
  for (const imp of nodesOfType(root, "import_statement")) {
    const src = imp.childForFieldName("source");
    if (!src) continue;
    const spec = unq(src.text);
    const clause = named(imp).find((n) => n.type === "import_clause");
    if (!clause) continue;
    for (const part of named(clause)) {
      if (part.type === "identifier") imports.push({ local: part.text, spec, name: "default", line: line(imp) });
      else if (part.type === "namespace_import") {
        const id = named(part).find((n) => n.type === "identifier");
        if (id) imports.push({ local: id.text, spec, name: "*", line: line(imp) });
      } else if (part.type === "named_imports") {
        for (const s of named(part).filter((n) => n.type === "import_specifier")) {
          const name = s.childForFieldName("name")?.text;
          const alias = s.childForFieldName("alias")?.text ?? name;
          if (name && alias) imports.push({ local: alias, spec, name: unq(name), line: line(imp) });
        }
      }
    }
  }
  // const x = require("./x") / const { a, b: c } = require("./x")
  for (const decl of nodesOfType(root, "variable_declarator")) {
    const value = decl.childForFieldName("value");
    const nameNode = decl.childForFieldName("name");
    if (!value || !nameNode || value.type !== "call_expression" || value.childForFieldName("function")?.text !== "require") continue;
    const arg = named(value.childForFieldName("arguments") ?? value)[0];
    if (!arg || arg.type !== "string") continue;
    const spec = unq(arg.text);
    if (nameNode.type === "identifier") imports.push({ local: nameNode.text, spec, name: "default", line: line(decl) });
    else if (nameNode.type === "object_pattern") {
      for (const prop of named(nameNode)) {
        const orig = prop.type === "pair_pattern" ? prop.childForFieldName("key")?.text : prop.text;
        const local = prop.type === "pair_pattern" ? prop.childForFieldName("value")?.text : prop.text;
        if (orig && local && /^[\w$]+$/.test(orig) && /^[\w$]+$/.test(local)) imports.push({ local, spec, name: orig, line: line(decl) });
      }
    }
  }
  const addDecl = (d: Node, exported: boolean) => {
    const out: CmDef[] = [];
    if (d.type === "function_declaration" || d.type === "generator_function_declaration") {
      const n = d.childForFieldName("name")?.text;
      if (n) out.push({ name: n, kind: "function", start: line(d), end: endLine(d), params: paramNames(d.childForFieldName("parameters")) });
    } else if (d.type === "class_declaration" || d.type === "abstract_class_declaration") {
      const n = d.childForFieldName("name")?.text;
      if (n) out.push({ name: n, kind: "class", start: line(d), end: endLine(d), members: classMembers(d.childForFieldName("body")) });
    } else if (d.type === "lexical_declaration" || d.type === "variable_declaration") {
      for (const v of named(d).filter((x) => x.type === "variable_declarator")) {
        const n = v.childForFieldName("name");
        if (n?.type !== "identifier") continue;
        out.push(valueDef(n.text, v, v.childForFieldName("value")));
      }
    } else if (d.type === "internal_module" || d.type === "module") {
      // export namespace WHATSAPP { export const API_VERSION = … }
      const n = d.childForFieldName("name")?.text;
      const body = d.childForFieldName("body");
      if (n && body) {
        const members: CmDef["members"] = [];
        for (const v of nodesOfType(body, "variable_declarator")) {
          const vn = v.childForFieldName("name");
          if (vn?.type === "identifier") members.push({ name: vn.text, start: line(v), end: endLine(v) });
        }
        out.push({ name: n, kind: "object", start: line(d), end: endLine(d), members });
      }
    }
    defs.push(...out);
    if (exported) for (const x of out) exports.push({ name: x.name, local: x.name });
  };
  for (const st of named(root)) {
    if (st.type === "export_statement") {
      const source = st.childForFieldName("source");
      const decl = st.childForFieldName("declaration");
      const value = st.childForFieldName("value");
      const clause = named(st).find((n) => n.type === "export_clause");
      if (source) {
        const spec = unq(source.text);
        if (clause) {
          for (const s of named(clause).filter((n) => n.type === "export_specifier")) {
            const n = s.childForFieldName("name")?.text;
            const a = s.childForFieldName("alias")?.text ?? n;
            if (n && a) exports.push({ name: unq(a), spec, from: unq(n) });
          }
        } else {
          const ns = named(st).find((n) => n.type === "namespace_export");
          const id = ns ? named(ns).find((n) => n.type === "identifier") : undefined;
          exports.push(id ? { name: id.text, spec, from: "*" } : { name: "*", spec, from: "*" });
        }
      } else if (decl) addDecl(decl, true);
      else if (clause) {
        for (const s of named(clause).filter((n) => n.type === "export_specifier")) {
          const n = s.childForFieldName("name")?.text;
          const a = s.childForFieldName("alias")?.text ?? n;
          if (n && a) exports.push({ name: unq(a), local: n });
        }
      } else if (value) {
        // export default name / export default function name() {} / export default { … }
        if (value.type === "identifier") exports.push({ name: "default", local: value.text });
        else {
          const n = value.childForFieldName("name")?.text;
          if ((value.type === "function_declaration" || value.type === "function_expression" || value.type === "class_declaration" || value.type === "class") && n) {
            addDecl(value.type === "class" ? value : value, false);
            if (!defs.some((d) => d.name === n)) defs.push({ name: n, kind: /class/.test(value.type) ? "class" : "function", start: line(value), end: endLine(value) });
            exports.push({ name: "default", local: n });
          } else {
            defs.push(valueDef("default", st, value));
            exports.push({ name: "default", local: "default" });
          }
        }
      } else {
        // export default function () {} (no name): the node is the declaration child
        const d = named(st).find((n) => /function|class/.test(n.type));
        if (d) {
          defs.push({ name: "default", kind: /class/.test(d.type) ? "class" : "function", start: line(d), end: endLine(d) });
          exports.push({ name: "default", local: "default" });
        }
      }
    } else if (st.type === "expression_statement") {
      // module.exports = x / module.exports = { a, b: c } / exports.a = x / module.exports.a = x
      const a = named(st)[0];
      if (a?.type !== "assignment_expression") continue;
      const left = a.childForFieldName("left")?.text.replace(/\s+/g, "");
      const right = a.childForFieldName("right");
      if (!left || !right) continue;
      if (left === "module.exports") {
        if (right.type === "identifier") exports.push({ name: "default", local: right.text });
        else if (right.type === "object") {
          for (const p of named(right)) {
            if (p.type === "shorthand_property_identifier") exports.push({ name: p.text, local: p.text });
            else if (p.type === "pair") {
              const k = p.childForFieldName("key")?.text;
              const v = p.childForFieldName("value");
              if (k && v?.type === "identifier") exports.push({ name: unq(k), local: v.text });
            }
          }
          defs.push(valueDef("default", st, right));
          exports.push({ name: "default", local: "default" });
        }
      } else {
        const m = /^(?:module\.)?exports\.([\w$]+)$/.exec(left);
        if (m) {
          if (right.type === "identifier") exports.push({ name: m[1], local: right.text });
          else {
            defs.push(valueDef(m[1], st, right));
            exports.push({ name: m[1], local: m[1] });
          }
        }
      }
    } else addDecl(st, false);
  }
  const calls: CmCall[] = [];
  for (const c of nodesOfType(root, ["call_expression", "new_expression"])) {
    if (calls.length >= MAX_CALLS) break;
    const fn = c.type === "new_expression" ? c.childForFieldName("constructor") : c.childForFieldName("function");
    const callee = calleeName(fn);
    if (!callee || callee === "require") continue;
    const args = named(c.childForFieldName("arguments") ?? c).filter((n) => n.type !== "comment");
    const keys: string[] = [];
    const spreads: string[] = [];
    for (const a of args) {
      if (a.type === "object") {
        for (const p of named(a)) {
          if (p.type === "pair") {
            const k = p.childForFieldName("key")?.text;
            if (k) keys.push(unq(k));
          } else if (p.type === "shorthand_property_identifier") keys.push(p.text);
          else if (p.type === "spread_element") {
            const s = calleeName(named(p)[0] ?? null);
            if (s) spreads.push(s);
          }
        }
      } else if (a.type === "spread_element") {
        const s = calleeName(named(a)[0] ?? null);
        if (s) spreads.push(s);
      }
    }
    const pos = args.map((a) => (a.type === "identifier" ? a.text : null));
    calls.push({ callee: c.type === "new_expression" ? `new ${callee}` : callee, line: line(c), ...(keys.length ? { keys } : {}), ...(spreads.length ? { spreads } : {}), ...(pos.some((x) => x) ? { args: pos } : {}) });
  }
  return { v: 1, lang: "ts", imports, exports, defs, calls };
}

function valueDef(name: string, at: Node, value: Node | null): CmDef {
  const base = { name, start: line(at), end: endLine(at) };
  if (!value) return { ...base, kind: "value" };
  if (/^(arrow_function|function_expression|function|generator_function)$/.test(value.type)) return { ...base, kind: "function", params: paramNames(value.childForFieldName("parameters")) };
  if (value.type === "class") return { ...base, kind: "class", members: classMembers(value.childForFieldName("body")) };
  if (value.type === "object") {
    const members: NonNullable<CmDef["members"]> = [];
    for (const p of named(value)) {
      if (p.type === "method_definition") {
        const n = p.childForFieldName("name")?.text;
        if (n) members.push({ name: unq(n), start: line(p), end: endLine(p), params: paramNames(p.childForFieldName("parameters")) });
      } else if (p.type === "pair") {
        const k = p.childForFieldName("key")?.text;
        if (k) members.push({ name: unq(k), start: line(p), end: endLine(p) });
      } else if (p.type === "shorthand_property_identifier") members.push({ name: p.text, start: line(p), end: endLine(p) });
    }
    return { ...base, kind: "object", members };
  }
  if (value.type === "new_expression" || value.type === "call_expression") {
    const callee = calleeName(value.type === "new_expression" ? value.childForFieldName("constructor") : value.childForFieldName("function"));
    return { ...base, kind: "value", ...(callee ? { inst: callee } : {}) };
  }
  return { ...base, kind: "value" };
}

function classMembers(body: Node | null): CmDef["members"] {
  if (!body) return [];
  const out: NonNullable<CmDef["members"]> = [];
  for (const m of named(body)) {
    if (m.type === "method_definition" || m.type === "public_field_definition" || m.type === "field_definition") {
      const n = (m.childForFieldName("name") ?? m.childForFieldName("property"))?.text;
      const v = m.childForFieldName("value");
      const params = m.type === "method_definition" ? paramNames(m.childForFieldName("parameters")) : v && /arrow_function|function/.test(v.type) ? paramNames(v.childForFieldName("parameters")) : undefined;
      if (n) out.push({ name: unq(n), start: line(m), end: endLine(m), ...(params ? { params } : {}) });
    }
  }
  return out;
}

function paramNames(p: Node | null): string[] | undefined {
  if (!p) return undefined;
  const out: string[] = [];
  for (const x of named(p)) {
    // Splats first: **params / *args / ...rest (also typed: **params: Unpack[…])
    const splat = x.type === "rest_pattern" || x.type === "list_splat_pattern" || x.type === "dictionary_splat_pattern" ? x : x.type === "typed_parameter" ? named(x).find((n) => n.type === "dictionary_splat_pattern" || n.type === "list_splat_pattern") : undefined;
    if (splat) {
      const n = named(splat).find((n) => n.type === "identifier");
      if (n) out.push(splat.type === "dictionary_splat_pattern" ? `**${n.text}` : `...${n.text}`);
      continue;
    }
    const id = x.type === "identifier" ? x : (x.childForFieldName("pattern") ?? x.childForFieldName("name") ?? named(x).find((n) => n.type === "identifier"));
    if (id?.type === "identifier") out.push(id.text);
  }
  return out;
}

function indexPy(tree: Tree): FileIndex {
  const root = tree.rootNode;
  const imports: CmImport[] = [];
  const defs: CmDef[] = [];
  for (const st of nodesOfType(root, ["import_from_statement", "import_statement"])) {
    if (st.type === "import_from_statement") {
      const mod = st.childForFieldName("module_name");
      if (!mod) continue;
      const spec = mod.text.replace(/\s+/g, "");
      if (named(st).some((n) => n.type === "wildcard_import")) {
        imports.push({ local: "*", spec, name: "*", line: line(st) });
        continue;
      }
      for (const n of st.childrenForFieldName("name").filter((x): x is Node => !!x)) {
        if (n.type === "aliased_import") {
          const nm = n.childForFieldName("name")?.text;
          const al = n.childForFieldName("alias")?.text;
          if (nm && al) imports.push({ local: al, spec, name: nm, line: line(st) });
        } else imports.push({ local: n.text, spec, name: n.text, line: line(st) });
      }
    } else {
      for (const n of st.childrenForFieldName("name").filter((x): x is Node => !!x)) {
        if (n.type === "aliased_import") {
          const nm = n.childForFieldName("name")?.text;
          const al = n.childForFieldName("alias")?.text;
          if (nm && al) imports.push({ local: al, spec: nm, name: "*", line: line(st) });
        } else imports.push({ local: n.text.split(".")[0], spec: n.text.split(".")[0], name: "*", line: line(st) });
      }
    }
  }
  const top = (st: Node) => {
    const d = st.type === "decorated_definition" ? st.childForFieldName("definition") : st;
    if (!d) return;
    if (d.type === "function_definition") {
      const n = d.childForFieldName("name")?.text;
      if (n) defs.push({ name: n, kind: "function", start: line(st), end: endLine(st), params: paramNames(d.childForFieldName("parameters")) });
    } else if (d.type === "class_definition") {
      const n = d.childForFieldName("name")?.text;
      const members: NonNullable<CmDef["members"]> = [];
      for (const m of named(d.childForFieldName("body") ?? d)) {
        const md = m.type === "decorated_definition" ? m.childForFieldName("definition") : m;
        if (md?.type === "function_definition") {
          const mn = md.childForFieldName("name")?.text;
          if (mn) members.push({ name: mn, start: line(m), end: endLine(m), params: (paramNames(md.childForFieldName("parameters")) ?? []).filter((x, i) => !(i === 0 && (x === "self" || x === "cls"))) });
        }
      }
      if (n) defs.push({ name: n, kind: "class", start: line(st), end: endLine(st), members });
    } else if (d.type === "expression_statement") {
      const a = named(d)[0];
      if (a?.type !== "assignment") return;
      const left = a.childForFieldName("left");
      const right = a.childForFieldName("right");
      if (left?.type !== "identifier") return;
      if (right?.type === "call") {
        const callee = calleeName(right.childForFieldName("function"));
        defs.push({ name: left.text, kind: "value", start: line(st), end: endLine(st), ...(callee ? { inst: callee } : {}) });
      } else if (right?.type === "lambda") defs.push({ name: left.text, kind: "function", start: line(st), end: endLine(st) });
      else if (right?.type === "dictionary") {
        const members: NonNullable<CmDef["members"]> = [];
        for (const p of named(right).filter((x) => x.type === "pair")) {
          const k = p.childForFieldName("key");
          if (k?.type === "string") members.push({ name: unq(k.text.replace(/^[rbuf]+/i, "")), start: line(p), end: endLine(p) });
        }
        defs.push({ name: left.text, kind: "object", start: line(st), end: endLine(st), members });
      } else defs.push({ name: left.text, kind: "value", start: line(st), end: endLine(st) });
    }
  };
  for (const st of named(root)) top(st);
  // Python: every top-level name is importable, imported names included (re-exports)
  const exports: CmExport[] = defs.map((d) => ({ name: d.name, local: d.name }));
  for (const im of imports) {
    if (im.local === "*") exports.push({ name: "*", spec: im.spec, from: "*" });
    else exports.push({ name: im.local, spec: im.spec, from: im.name });
  }
  const calls: CmCall[] = [];
  for (const c of nodesOfType(root, "call")) {
    if (calls.length >= MAX_CALLS) break;
    const callee = calleeName(c.childForFieldName("function"));
    if (!callee) continue;
    const keys: string[] = [];
    const spreads: string[] = [];
    const pos: (string | null)[] = [];
    for (const a of named(c.childForFieldName("arguments") ?? c)) {
      if (a.type !== "keyword_argument" && a.type !== "dictionary_splat" && a.type !== "list_splat" && a.type !== "comment") pos.push(a.type === "identifier" ? a.text : null);
      if (a.type === "keyword_argument") {
        const k = a.childForFieldName("name")?.text;
        if (k) keys.push(k);
      } else if (a.type === "dictionary_splat" || a.type === "list_splat") {
        const s = calleeName(named(a)[0] ?? null);
        if (s) spreads.push(s);
      } else if (a.type === "dictionary") {
        for (const p of named(a).filter((x) => x.type === "pair")) {
          const k = p.childForFieldName("key");
          if (k?.type === "string") keys.push(unq(k.text.replace(/^[rbuf]+/i, "")));
        }
      }
    }
    calls.push({ callee, line: line(c), ...(keys.length ? { keys } : {}), ...(spreads.length ? { spreads } : {}), ...(pos.some((x) => x) ? { args: pos } : {}) });
  }
  return { v: 1, lang: "py", imports, exports, defs, calls };
}

// ---------------------------------------------------------------------------------------------------------------
// Linking

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"];

export interface Hop {
  file: string;
  line: number;
  name: string;
}
export interface Resolved {
  file: string;
  def: CmDef;
  /** The member named after the def (graphRequest.get): set when the use names one */
  hops: Hop[];
}

/** Where a call map keeps its indexes: a Map, or a PackedIndex */
export interface IndexFiles {
  get(rel: string): FileIndex | undefined;
  set(rel: string, idx: FileIndex): unknown;
  has(rel: string): boolean;
  keys(): IterableIterator<string>;
  readonly size: number;
}

export class CallMap {
  readonly files: IndexFiles;
  /** Every source file in the repo (indexed or not), for resolving import paths */
  readonly known: Set<string>;
  /** Index a file not indexed yet, on demand (undefined: can't be read or parsed) */
  private readonly loader?: (rel: string) => FileIndex | undefined;
  private readonly failed = new Set<string>();
  private bySuffix?: Map<string, string[]>;
  /** Workspace packages: a package.json's name → its folder (a monorepo's packages import each other by name) */
  workspaces?: Map<string, string>;
  constructor(files: IndexFiles, known?: Iterable<string>, loader?: (rel: string) => FileIndex | undefined) {
    this.files = files;
    this.known = new Set([...files.keys(), ...(known ?? [])]);
    this.loader = loader;
  }

  get(rel: string): FileIndex | undefined {
    const have = this.files.get(rel);
    if (have || !this.loader || this.failed.has(rel) || !this.known.has(rel)) return have;
    const idx = this.loader(rel);
    if (!idx) {
      this.failed.add(rel);
      return undefined;
    }
    // Kept without its calls (memory); the calls of the last files read stay at hand for callsOf
    const slim: FileIndex = idx.slim ? idx : { ...idx, calls: [], slim: true };
    if (!idx.slim) {
      this.recentCalls.set(rel, idx.calls);
      if (this.recentCalls.size > 256) this.recentCalls.delete(this.recentCalls.keys().next().value!);
    }
    this.files.set(rel, slim);
    return slim;
  }

  /** A file's calls; a slim index is read again in full (once) */
  callsOf(rel: string): CmCall[] {
    const idx = this.get(rel);
    if (!idx) return [];
    if (!idx.slim) return idx.calls;
    // Read again, kept only among the last few (traces visit many files once)
    const have = this.recentCalls.get(rel);
    if (have) return have;
    const full = this.loader?.(rel);
    const calls = full && !full.slim ? full.calls : [];
    this.recentCalls.set(rel, calls);
    if (this.recentCalls.size > 256) this.recentCalls.delete(this.recentCalls.keys().next().value!);
    return calls;
  }
  private readonly recentCalls = new Map<string, CmCall[]>();

  private suffixes(): Map<string, string[]> {
    if (this.bySuffix) return this.bySuffix;
    const m = new Map<string, string[]>();
    for (const f of this.known) {
      const stem = f.replace(/\.d\.ts$/, "").replace(/\.[^./]+$/, "").replace(/\/(index|__init__)$/, "");
      const parts = stem.split("/");
      for (let i = 0; i < parts.length; i++) {
        const k = parts.slice(i).join("/");
        m.set(k, [...(m.get(k) ?? []), f]);
      }
    }
    this.bySuffix = m;
    return m;
  }

  /** The file an import names, or undefined when it isn't exactly one indexed file */
  resolveSpec(fromFile: string, spec: string): string | undefined {
    const idx = this.get(fromFile);
    if (!idx) return undefined;
    const dir = fromFile.split("/").slice(0, -1);
    const norm = (parts: string[]) => {
      const out: string[] = [];
      for (const p of parts) {
        if (p === "..") {
          if (!out.length) return undefined;
          out.pop();
        } else if (p !== "." && p) out.push(p);
      }
      return out.join("/");
    };
    if (idx.lang === "py") {
      if (spec.startsWith(".")) {
        const dots = /^\.+/.exec(spec)![0].length;
        const base = dir.slice(0, dir.length - (dots - 1));
        if (base.length < 0) return undefined;
        const rest = spec.slice(dots);
        const stem = norm([...base, ...(rest ? rest.split(".") : [])]);
        if (stem === undefined) return undefined;
        return [`${stem}.py`, `${stem}/__init__.py`].find((c) => this.known.has(c));
      }
      const tail = spec.replace(/\./g, "/");
      const hits = (this.suffixes().get(tail) ?? []).filter((f) => f.endsWith(".py"));
      // An absolute module is looked up from a source root: the importing file's own (the first folder above its
      // package with no __init__.py; a script's own folder) or the repo's root. polar.checkout.service from
      // server/polar/… is server/polar/checkout/service.py; `import stripe` there isn't dev/cli/commands/stripe.py
      let root = dir.join("/");
      while (root && this.known.has(`${root}/__init__.py`)) root = root.split("/").slice(0, -1).join("/");
      const roots = new Set([root, ""]);
      const exact = hits.filter((f) => {
        const stem = f.replace(/\.py$/, "").replace(/\/__init__$/, "");
        if (stem !== tail && !stem.endsWith(`/${tail}`)) return false;
        const prefix = stem.slice(0, stem.length - tail.length).replace(/\/$/, "");
        return roots.has(prefix);
      });
      return exact.length === 1 ? exact[0] : undefined;
    }
    if (spec.startsWith(".")) {
      const stem = norm([...dir, ...spec.split("/")]);
      if (stem === undefined) return undefined;
      const noExt = stem.replace(/\.(m?[jt]sx?|cjs|cts)$/, "");
      const cands = [stem, ...JS_EXT.map((e) => noExt + e), ...JS_EXT.map((e) => `${stem}/index${e}`)];
      return cands.find((c) => this.known.has(c));
    }
    // A workspace package by name (@typebot.io/ai/runChatCompletion is packages/ai/src/runChatCompletion.ts): its
    // folder, src/ or lib/, with the usual extensions and index files; exactly one file, or none
    if (this.workspaces?.size) {
      let pkg: string | undefined;
      for (const n of this.workspaces.keys()) if ((spec === n || spec.startsWith(`${n}/`)) && (!pkg || n.length > pkg.length)) pkg = n;
      if (pkg) {
        const dirOf = this.workspaces.get(pkg)!;
        const sub = spec.slice(pkg.length).replace(/^\//, "").replace(/\.(m?[jt]sx?|cjs|cts)$/, "");
        const stems = (sub ? [sub, `src/${sub}`, `lib/${sub}`] : ["src/index", "index", "lib/index"]).map((x) => (dirOf ? `${dirOf}/${x}` : x));
        const found = new Set<string>();
        for (const st of stems) {
          const hit = [...JS_EXT.map((e) => st + e), ...JS_EXT.map((e) => `${st}/index${e}`)].find((c) => this.known.has(c));
          if (hit) found.add(hit);
        }
        return found.size === 1 ? [...found][0] : undefined;
      }
    }
    // Aliases: @/lib/x, ~/lib/x, #lib/x, src/lib/x: exactly one indexed file must end with the path
    const alias = /^(?:@|~|#)\/(.+)$/.exec(spec)?.[1] ?? (/^(?:src|lib|app)\//.test(spec) ? spec : undefined);
    if (!alias) return undefined;
    const tail = alias.replace(/\.(m?[jt]sx?|cjs|cts)$/, "");
    const hits = (this.suffixes().get(tail) ?? []).filter((f) => !f.endsWith(".py"));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** The definition `name` exported by `file` leads to, following re-exports (at most `budget` hops) */
  resolveExport(file: string, name: string, budget = 4, seen = new Set<string>()): Resolved | undefined {
    const key = `${file}#${name}`;
    if (seen.has(key) || budget < 0) return undefined;
    seen.add(key);
    const idx = this.get(file);
    if (!idx) return undefined;
    const local = (n: string) => {
      const def = idx.defs.find((d) => d.name === n);
      return def ? { file, def, hops: [] as Hop[] } : undefined;
    };
    let found: Resolved | undefined;
    const direct = idx.exports.filter((e) => e.name === name);
    for (const e of direct) {
      if (e.local !== undefined) {
        const d = local(e.local);
        if (d) return d;
        // export { x } where x was imported here: follow that import
        const im = idx.imports.find((i) => i.local === e.local);
        if (im) found ??= this.follow(file, im, budget, seen);
      } else if (e.spec && e.from && e.from !== "*") {
        const target = this.resolveSpec(file, e.spec);
        const r = target ? this.resolveExport(target, e.from, budget - 1, seen) : undefined;
        if (r) return { ...r, hops: [{ file, line: 0, name }, ...r.hops] };
      }
    }
    if (found) return found;
    if (idx.lang !== "py" && name !== "default") {
      // export * from "./x": only when exactly one star export has it
      const hits = idx.exports.filter((e) => e.name === "*" && e.spec).map((e) => {
        const t = this.resolveSpec(file, e.spec!);
        return t ? this.resolveExport(t, name, budget - 1, seen) : undefined;
      }).filter((x): x is Resolved => !!x);
      if (hits.length === 1) return { ...hits[0], hops: [{ file, line: 0, name }, ...hits[0].hops] };
    }
    return undefined;
  }

  private follow(file: string, im: CmImport, budget: number, seen: Set<string>): Resolved | undefined {
    const target = this.resolveSpec(file, im.spec);
    if (!target || im.name === "*") return undefined;
    const r = this.resolveExport(target, im.name, budget - 1, seen);
    return r ? { ...r, hops: [{ file, line: im.line, name: im.local }, ...r.hops] } : undefined;
  }

  /** The repo file a namespace or module import names (import * as lib from "./lib"; const lib = require("./lib")) */
  moduleOfLocal(file: string, local: string): string | undefined {
    const im = this.get(file)?.imports.find((i) => i.local === local && (i.name === "*" || i.name === "default"));
    return im ? this.resolveSpec(file, im.spec) : undefined;
  }

  /** What a local name in `file` stands for: its own definition, or the one it's imported from */
  resolveLocal(file: string, name: string, budget = 4): Resolved | undefined {
    const idx = this.get(file);
    if (!idx) return undefined;
    const def = idx.defs.find((d) => d.name === name);
    if (def) return { file, def, hops: [] };
    const im = idx.imports.find((i) => i.local === name);
    return im ? this.follow(file, im, budget, new Set()) : undefined;
  }

  /**
   * The outside package a local name stands for, through the repo's own modules: stripe_lib in service.py, imported
   * from polar/integrations/stripe/__init__.py, which does `import stripe as stripe_lib`. Undefined for a name that
   * leads to a definition in the repo, or doesn't resolve.
   */
  resolveExternal(file: string, name: string, budget = 4): { spec: string; name: string } | undefined {
    if (budget < 0) return undefined;
    const idx = this.get(file);
    const im = idx?.imports.find((i) => i.local === name);
    if (!idx || !im) return undefined;
    const target = this.resolveSpec(file, im.spec);
    // Relative or aliased paths that don't lead to an indexed file aren't packages
    if (!target) return /^[.@~#]\/|^\./.test(im.spec) || (idx.lang !== "py" && /^(src|lib|app)\//.test(im.spec)) ? undefined : { spec: im.spec, name: im.name };
    if (im.name === "*") return undefined;
    const t = this.get(target);
    if (!t || t.defs.some((d) => d.name === im.name)) return undefined;
    // Re-exported there: export { x } from "pkg" / export { x } (imported there) / Python's imported name
    const e = t.exports.find((x) => x.name === im.name && x.spec && x.from && x.from !== "*");
    if (e && t.lang !== "py") {
      const tt = this.resolveSpec(target, e.spec!);
      if (!tt) return { spec: e.spec!, name: e.from! };
      return this.resolveExternalExport(tt, e.from!, budget - 1);
    }
    const local = t.exports.find((x) => x.name === im.name && x.local)?.local ?? im.name;
    return this.resolveExternal(target, local, budget - 1);
  }

  private resolveExternalExport(file: string, name: string, budget: number): { spec: string; name: string } | undefined {
    const t = this.get(file);
    if (!t || budget < 0 || t.defs.some((d) => d.name === name)) return undefined;
    const e = t.exports.find((x) => x.name === name);
    if (e?.spec && e.from && e.from !== "*") {
      const tt = this.resolveSpec(file, e.spec);
      return tt ? this.resolveExternalExport(tt, e.from, budget - 1) : { spec: e.spec, name: e.from };
    }
    return this.resolveExternal(file, e?.local ?? name, budget - 1);
  }

  /** The module a namespace import (import * as ns / import x as mod) names */
  resolveNamespace(file: string, name: string): string | undefined {
    const im = this.get(file)?.imports.find((i) => i.local === name && i.name === "*");
    return im ? this.resolveSpec(file, im.spec) : undefined;
  }

  /** The innermost top-level definition (and member) holding a line */
  enclosing(file: string, ln: number): { def: CmDef; member?: string } | undefined {
    const idx = this.get(file);
    if (!idx) return undefined;
    const def = idx.defs.filter((d) => d.start <= ln && ln <= d.end && d.kind !== "value").sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!def) return undefined;
    const member = def.members?.find((m) => m.start <= ln && ln <= m.end)?.name;
    return { def, ...(member ? { member } : {}) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tracing: a provider version fixed inside an exported function or method reaches the files that call it


const MAX_HOPS = 3;
/** A URL setting given the name, or a URL starting with it (base + path): `${NAME}${path}`, NAME + path, f"{NAME}/me" */
const URL_KEY = (name: string) => {
  const n = name.replace(/\$/g, "\\$");
  return new RegExp(`\\b(?:baseURL|baseUrl|base_url|url|uri|endpoint|prefixUrl|apiUrl|api_url)["']?\\s*[:=]\\s*(?:${n}\\s*(?:[,;})+]|$)|\`\\$\\{\\s*${n}\\s*\\}|f["']\\{${n}\\})`);
};

interface Carrier {
  file: string;
  def: CmDef;
  /** Members (of an object or class) that reach the usage; undefined: the def itself is the function */
  members?: Set<string>;
  /** Where the value is set, and the path so far */
  origin: Usage;
  path: string[];
  hop: number;
}

/** Members of a def that reach `member`, through this.x() / self.x() calls inside the def */
function reaching(calls: CmCall[], def: CmDef, member: string): Set<string> {
  const out = new Set([member]);
  const members = def.members ?? [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const m of members) {
      if (out.has(m.name)) continue;
      const inside = calls.filter((c) => c.line >= m.start && c.line <= m.end);
      if (inside.some((c) => [...out].some((t) => c.callee === `this.${t}` || c.callee === `self.${t}` || c.callee === `cls.${t}`))) {
        out.add(m.name);
        changed = true;
      }
    }
  }
  return out;
}

/** How an import path names a module file (from './graphRequest', from .client import, import pkg.client) */
/** What a caller's text must name: the definition, or for a default export its module's path */
function callerNames(map: CallMap, file: string, def: CmDef): string[] {
  const isDefault = def.name === "default" || !!map.get(file)?.exports.some((e) => e.name === "default" && e.local === def.name);
  return isDefault ? modulePaths(file) : [def.name];
}

export function modulePaths(file: string): string[] {
  const stem = file.split("/").pop()!.replace(/\.[^.]+$/, "");
  const dir = file.split("/").slice(-2, -1)[0];
  // An index or __init__ module is imported by its folder's name
  const name = (stem === "index" || stem === "__init__") && dir ? dir : stem;
  // (with or without an extension: './constant.js')
  return [`/${name}'`, `/${name}"`, `/${name}\``, `/${name}.`, `.${name} import`, `.${name}'`, `.${name}"`, `import ${name}`];
}

/**
 * Usages at the call sites of wrappers that hold a provider version: graphRequest.get(...) in pageUtils.ts, where
 * graphRequest (facebook/graphRequest.ts, re-exported by facebook/utils.ts) sets version 7.0 before calling fbgraph.
 * One usage per calling file and version, at the first call; the fix stays where the value is set.
 */
export function traceWrapperCalls(map: CallMap, usages: Usage[], lineText: (file: string, line: number) => string | undefined, isTest: (file: string) => boolean, candidates: (any: string[], all?: string[]) => string[], keepOrigin?: (u: Usage) => boolean): Usage[] {
  const out: Usage[] = [];
  const have = new Set(usages.filter((u) => u.apiVersion).map((u) => `${u.file}|${u.provider}|${u.apiVersion!.split(": ").pop()}`));
  let frontier: Carrier[] = [];
  const seenCarriers = new Set<string>();
  const valueCarriers: Carrier[] = [];
  for (const u of usages) {
    if (!u.apiVersion || u.doc || u.inTest || isTest(u.file) || (keepOrigin && !keepOrigin(u))) continue;
    const idx = map.get(u.file);
    const enc = idx ? map.enclosing(u.file, u.line) : undefined;
    if (idx && (!enc || (enc.def.kind === "value" && !enc.member)) && u.apiVersion.startsWith("url: ")) {
      // A module-level constant holding a versioned provider URL (export const accessTokenEndpoint = 'https://…/v13.0/…')
      const def = idx.defs.find((d) => d.kind === "value" && d.start <= u.line && u.line <= d.end && !d.inst);
      if (def && (idx.lang === "py" || idx.exports.some((e) => e.local === def.name))) valueCarriers.push({ file: u.file, def, origin: u, path: [`${u.file}:${u.line}`], hop: 1 });
      continue;
    }
    if (/^const: /.test(u.apiVersion) || !idx || !enc) continue;
    // In an object or class, only a method carries it
    if ((enc.def.kind === "object" || enc.def.kind === "class") && !enc.member) continue;
    frontier.push({ file: u.file, def: enc.def, members: enc.member ? reaching(map.callsOf(u.file), enc.def, enc.member) : undefined, origin: u, path: [`${u.file}:${u.line}`], hop: 1 });
  }
  // Module-level instances of a carrying class (stripe_service = StripeService()) carry it too
  const withInstances = (cs: Carrier[]) => {
    const extra: Carrier[] = [];
    for (const c of cs) {
      if (c.def.kind !== "class") continue;
      const idx = map.get(c.file)!;
      for (const d of idx.defs) if (d.inst === c.def.name || d.inst === `new ${c.def.name}`) extra.push({ ...c, def: { ...d, members: c.def.members } });
    }
    return [...cs, ...extra];
  };
  // Uses of those constants in the files that import them: the first line naming the import near a call
  for (const c of valueCarriers) {
    const version = c.origin.apiVersion!.split(": ").pop()!;
    // In its own file: a URL setting given the constant (return { baseURL: WHATSAPP_BASE_URL, … })
    {
      const key = `${c.file}|${c.origin.provider}|${version}|${c.def.name}`;
      for (let ln = c.def.end + 1; ln <= 200000 && !have.has(key); ln++) {
        const t = lineText(c.file, ln);
        if (t === undefined) break;
        if (t.length > 2000 || !URL_KEY(c.def.name).test(t) || usages.some((u) => u.file === c.file && u.line === ln)) continue;
        have.add(key);
        out.push({
          provider: c.origin.provider, kind: c.origin.kind, lang: c.origin.lang,
          file: c.file, line: ln, apiVersion: c.origin.apiVersion, ...(c.origin.op ? { op: c.origin.op } : {}),
          confidence: "likely", snippet: t.trim().slice(0, 200), reason: `version ${version} set in ${c.path[0]} → ${c.def.name}`,
        });
      }
    }
    for (const g of candidates([c.def.name])) {
      if (g === c.file || isTest(g)) continue;
      const gi = map.get(g);
      if (!gi) continue;
      const locals = gi.imports.filter((im) => im.name !== "*" && (() => {
        const r = map.resolveLocal(g, im.local);
        return !!r && r.file === c.file && r.def.name === c.def.name && r.def.start === c.def.start;
      })()).map((im) => im.local);
      // through a namespace or module import: lib.API_BASE_URL
      for (const im of gi.imports) if ((im.name === "*" || im.name === "default") && im.local !== "*" && map.moduleOfLocal(g, im.local) === c.file) locals.push(`${im.local}.${c.def.name}`);
      if (!locals.length) continue;
      // Per constant: each one names its own endpoint (authorizationEndpoint, accessTokenEndpoint)
      const key = `${g}|${c.origin.provider}|${version}|${c.def.name}`;
      if (have.has(key) || usages.some((u) => u.file === g && u.provider === c.origin.provider && u.apiVersion?.endsWith(version) && u.reason?.includes(c.def.name))) continue;
      const callLines = new Set(map.get(g)?.callLines ?? map.callsOf(g).map((x) => x.line));
      const importLines = new Set(gi.imports.map((x) => x.line));
      // The first use near a call; and each URL setting given it (requestDefaults: { baseURL: WHATSAPP_BASE_URL },
      // an operation's routing url): each configures its own requests
      const ats: number[] = [];
      let nearCall = false;
      const useRe = new RegExp(`(?<![\\w$.])(?:${locals.map((l) => l.replace(/[.$]/g, "\\$&")).join("|")})(?![\\w$])`);
      const urlRes = locals.map((l) => URL_KEY(l));
      for (let ln = 1; ln <= 200000 && ats.length < 20; ln++) {
        const t = lineText(g, ln);
        if (t === undefined) break;
        if (t.length > 2000 || !useRe.test(t) || importLines.has(ln) || /^\s*(?:import\b|from\b|export\s*\{|\}\s*from|#|\/\/|\*)/.test(t)) continue;
        if (urlRes.some((re) => re.test(t))) ats.push(ln);
        else if (!nearCall && [0, 1, 2, 3].some((k) => callLines.has(ln - k))) {
          nearCall = true;
          ats.push(ln);
        }
      }
        if (!ats.length) continue;
      have.add(key);
      for (const at of ats) out.push({
        provider: c.origin.provider, kind: c.origin.kind, lang: gi.lang === "py" ? "py" : /\.[cm]?jsx?$/.test(g) ? "js" : "ts",
        file: g, line: at, apiVersion: c.origin.apiVersion, ...(c.origin.op ? { op: c.origin.op } : {}),
        confidence: "likely", snippet: (lineText(g, at) ?? "").trim().slice(0, 200), reason: `version ${version} set in ${c.path[0]} → ${c.def.name} → ${g}:${at}`,
      });
    }
  }
  for (let hop = 1; hop <= MAX_HOPS && frontier.length; hop++) {
    const next: Carrier[] = [];
    for (const c of withInstances(frontier)) {
      const version = c.origin.apiVersion!.split(": ").pop()!;
      // In its own file: another definition calling it by name (export const helpers = { getBaseUrl: (a) =>
      // getBaseUrl(shopOf(a)) }) carries it on, so files using helpers.getBaseUrl are reached
      if (!c.members && (c.def.kind === "function" || c.def.kind === "value")) {
        for (const call of map.callsOf(c.file)) {
          if (call.callee !== c.def.name || (call.line >= c.def.start && call.line <= c.def.end)) continue;
          const enc = map.enclosing(c.file, call.line);
          if (!enc || enc.def.start === c.def.start || ((enc.def.kind === "object" || enc.def.kind === "class") && !enc.member)) continue;
          const k = `${c.file}|${c.origin.provider}|${version}|${c.file}#${enc.def.name}.${enc.member ?? ""}`;
          if (have.has(k)) continue;
          have.add(k);
          next.push({ file: c.file, def: enc.def, members: enc.member ? reaching(map.callsOf(c.file), enc.def, enc.member) : undefined, origin: c.origin, path: [...c.path, `${c.file}:${call.line}`], hop: hop + 1 });
        }
      }
      // Only files whose text names the carrier (or the module, for namespace imports) can call it
      // A caller names the carrier (import { x }, ns.x(…)); only a default export can be called under another name
      const isDefault = !!map.get(c.file)?.exports.some((e) => e.name === "default" && e.local === c.def.name);
      // (a default export is imported by its module's path; the word "default" names nothing)
      const isDefaultDef = isDefault || c.def.name === "default";
      // Only an exported definition (JS/TS) can be called from another file
      const ci = map.get(c.file);
      const exported = !ci || ci.lang === "py" || ci.exports.some((e) => e.local === c.def.name || (e.local === undefined && e.name === c.def.name)) || isDefault;
      for (const g of exported ? candidates(isDefaultDef ? modulePaths(c.file) : [c.def.name]) : []) {
        if (g === c.file || isTest(g)) continue;
        const gi = map.get(g);
        if (!gi) continue;
        // Local names in g that stand for the carrier: imported names that resolve to it, and namespace.member
        const locals: string[] = [];
        for (const im of gi.imports) {
          if (im.name === "*") {
            if (map.resolveSpec(g, im.spec) === c.file) locals.push(`${im.local}.${c.def.name}`);
            continue;
          }
          const r = map.resolveLocal(g, im.local);
          if (r && r.file === c.file && r.def.name === c.def.name && r.def.start === c.def.start) locals.push(im.local);
        }
        if (!locals.length) continue;
        // Instances made in g: const s = new Local() / s = Local()
        const inst = c.def.kind === "class" ? gi.defs.filter((d) => d.inst && locals.some((l) => d.inst === l || d.inst === `new ${l}`)).map((d) => d.name) : [];
        const callOk = (callee: string) => {
          for (const l of [...locals, ...inst]) {
            const isInst = inst.includes(l) || (c.def.kind === "value" && !!c.def.inst);
            if (!c.members) {
              if (callee === l || callee === `new ${l}`) return l;
              continue;
            }
            const m = callee.startsWith(`${l}.`) ? callee.slice(l.length + 1) : undefined;
            if (m && !m.includes(".") && c.members.has(m) && (c.def.kind !== "class" || isInst || true)) return `${l}.${m}`;
          }
          return undefined;
        };
        const call = map.callsOf(g).find((x) => !!callOk(x.callee));
        if (!call) continue;
        // One usage per calling file, version and carrier: a file's other request with the same version (a literal
        // URL elsewhere in it) doesn't stand for this one; a usage already on this line does
        // (deeper hops: one per calling file and version, so a chain of helpers doesn't flag every caller)
        const key = hop === 1 ? `${g}|${c.origin.provider}|${version}|${c.file}#${c.def.name}` : `${g}|${c.origin.provider}|${version}`;
        if (have.has(key) || (hop > 1 && have.has(`${g}|${c.origin.provider}|${version}`)) || usages.some((x) => x.file === g && x.line === call.line && x.provider === c.origin.provider && x.apiVersion?.endsWith(version))) continue;
        have.add(`${g}|${c.origin.provider}|${version}`);
        have.add(key);
        const via = callOk(call.callee)!;
        const path = [...c.path, via, `${g}:${call.line}`];
        const snippet = (lineText(g, call.line) ?? "").trim().slice(0, 200);
        const u: Usage = {
          provider: c.origin.provider, kind: c.origin.kind, lang: gi.lang === "py" ? "py" : g.endsWith(".js") || g.endsWith(".jsx") || g.endsWith(".mjs") || g.endsWith(".cjs") ? "js" : "ts",
          file: g, line: call.line, apiVersion: c.origin.apiVersion, ...(c.origin.op ? { op: c.origin.op } : {}),
          confidence: "likely", snippet, reason: `version ${version} set in ${path.join(" → ")}`, wrapperOrigin: c.path[0],
        };
        out.push(u);
        // This call's own function, when exported, carries it one hop further
        const enc = map.enclosing(g, call.line);
        if (enc && hop < MAX_HOPS && !((enc.def.kind === "object" || enc.def.kind === "class") && !enc.member)) {
          next.push({ file: g, def: enc.def, members: enc.member ? reaching(map.callsOf(g), enc.def, enc.member) : undefined, origin: c.origin, path: [...c.path, via, `${g}:${call.line}`], hop: hop + 1 });
        }
      }
    }
    collectGarbage();
    // One carrier per function, member, version and provider: other origins reaching it add nothing a trace can
    // report (its usages are one per file and version), only work
    frontier = next.filter((c) => {
      const k = `${c.file}|${c.def.start}|${c.def.name}|${[...(c.members ?? [])].sort().join(",")}|${c.origin.provider}|${c.origin.apiVersion!.split(": ").pop()}`;
      if (seenCarriers.has(k)) return false;
      seenCarriers.add(k);
      return true;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tracing parameters: a wrapper that forwards its parameters into a provider call (def create_payment_intent(self,
// **params): … stripe.PaymentIntent.create_async(**params)) sends what its callers put in them. The callers are found
// through the call map (imports, re-exports, module-level instances), and each key they set is reported where it's
// written, with the path.

/** Keys a name gets in a function before `row`: name = {…} / name: T = {…}, name["k"] = …, name.k = …, name.update({…}) */
function keysOfLocal(lines: string[], name: string, from: number, row: number): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const open = new RegExp(`^\\s*(?:(?:const|let|var)\\s+)?${esc}\\s*(?::[^=]+)?=\\s*(?:\\{|dict\\(|[\\w.]*\\b[A-Z]\\w*(?:Params|Options)\\()`);
  const sub = new RegExp(`\\b${esc}\\[\\s*["']([A-Za-z_]\\w*)["']\\s*\\]\\s*=(?!=)|\\b${esc}\\.([A-Za-z_]\\w*)\\s*=(?!=)`, "g");
  for (let r = Math.max(0, from); r < row && r < lines.length; r++) {
    const l = lines[r];
    if (l.length > 2000) continue;
    for (const m of l.matchAll(sub)) out.push({ key: m[1] ?? m[2], line: r + 1 });
    if (!open.test(l) && !new RegExp(`\\b${esc}\\.update\\(\\s*\\{`).test(l)) continue;
    // Top-level keys of the literal opening here: "k": / 'k': / k: / k=
    let depth = 0;
    for (let k = r; k < Math.min(lines.length, r + 120); k++) {
      const t = (k === r ? l.slice(l.search(/[{(]/)) : lines[k]).replace(/(["'`])(?:\\.|(?!\1)[^\\])*?\1/g, (s) => (/^["'][A-Za-z_]\w*["']$/.test(s) ? s : " ".repeat(s.length)));
      const at: number[] = [];
      let done = false;
      for (let j = 0; j < t.length; j++) {
        at[j] = depth;
        if ("{[(".includes(t[j])) depth++;
        else if ("}])".includes(t[j]) && --depth === 0) {
          done = true;
          break;
        }
      }
      for (const m of t.matchAll(/(?:^|[{,(\s])["']?([A-Za-z_]\w*)["']?\s*(?::(?!:)|=(?!=))/g)) {
        const i = m.index! + m[0].indexOf(m[1]);
        if (at[i] === 1) out.push({ key: m[1], line: k + 1 });
      }
      if (done) break;
    }
  }
  return out;
}

/** Local names in file g that stand for definition `def` of `file` (imports through re-exports, namespace.member) */
export function localsFor(map: CallMap, g: string, file: string, def: CmDef): string[] {
  const gi = map.get(g);
  if (!gi) return [];
  const out: string[] = [];
  for (const im of gi.imports) {
    if (im.name === "*") {
      if (map.resolveSpec(g, im.spec) === file) out.push(`${im.local}.${def.name}`);
      continue;
    }
    const r = map.resolveLocal(g, im.local);
    if (r && r.file === file && r.def.name === def.name && r.def.start === def.start) out.push(im.local);
  }
  return out;
}

interface ParamWrapper {
  file: string;
  /** The def that callers name: a function, an object, a class, or a module-level instance of the class */
  def: CmDef;
  member?: string;
  /** How callers' arguments reach the provider call: by keyword spread (**params, ...options) or by position */
  spread: boolean;
  index: number;
  origin: Usage;
  path: string[];
}

/**
 * Keys that callers of a forwarding wrapper set, reported where each is written:
 * payment_intent_params["payment_method_types"] = … in checkout/service.py, passed as **payment_intent_params to
 * stripe_service.create_payment_intent (integrations/stripe/service.py), which spreads its **params into
 * stripe.PaymentIntent.create_async. Callers are linked through the call map, never by name alone.
 */
export function traceParamCalls(map: CallMap, usages: Usage[], lineText: (file: string, line: number) => string | undefined, isTest: (file: string) => boolean, candidates: (any: string[], all?: string[]) => string[]): Usage[] {
  const out: Usage[] = [];
  const have = new Set(usages.flatMap((u) => (u.op && u.params ? u.params.map((p) => `${u.file}|${u.line}|${u.op}|${p}`) : [])));
  const linesOf = (rel: string) => {
    const ls: string[] = [];
    for (let ln = 1; ln <= 200000; ln++) {
      const t = lineText(rel, ln);
      if (t === undefined) break;
      ls.push(t);
    }
    return ls;
  };
  const cachedLines = new Map<string, string[]>();
  const lines = (rel: string) => {
    if (!cachedLines.has(rel)) cachedLines.set(rel, linesOf(rel));
    return cachedLines.get(rel)!;
  };
  let wrappers: ParamWrapper[] = [];
  for (const u of usages) {
    if (!u.op || (u.kind !== "sdk" && u.kind !== "http") || u.doc || u.inTest || isTest(u.file)) continue;
    const idx = map.get(u.file);
    const enc = idx ? map.enclosing(u.file, u.line) : undefined;
    if (!idx || !enc) continue;
    const params = enc.member ? enc.def.members?.find((m) => m.name === enc.member)?.params : enc.def.params;
    if (!params?.length) continue;
    // The provider call: a call starting on the usage's line (or just above) that passes on one of the parameters
    for (const c of map.callsOf(u.file).filter((x) => x.line >= u.line - 1 && x.line <= u.line + 1)) {
      const sp = (c.spreads ?? []).find((n) => params.includes(`**${n}`) || params.includes(`...${n}`) || params.includes(n));
      const pos = (c.args ?? []).find((n) => n && params.includes(n) && !(c.keys ?? []).length);
      const name = sp ?? pos;
      if (!name) continue;
      const pi = params.findIndex((p) => p === name || p === `**${name}` || p === `...${name}`);
      const spread = params[pi].startsWith("**") || params[pi].startsWith("...");
      // In an object or class, callers reach it through a member; its own module-level instances count too
      const defs = [enc.def, ...(enc.def.kind === "class" ? idx.defs.filter((d) => d.inst === enc.def.name || d.inst === `new ${enc.def.name}`) : [])];
      for (const d of defs) wrappers.push({ file: u.file, def: d, member: enc.member, spread, index: spread ? -1 : pi, origin: u, path: [`${u.file}:${u.line}`] });
      break;
    }
  }
  for (let hop = 1; hop <= MAX_HOPS && wrappers.length; hop++) {
    const next: ParamWrapper[] = [];
    for (const w of wrappers) {
      for (const g of candidates(callerNames(map, w.file, w.def), w.member ? [w.member] : undefined)) {
        if (isTest(g)) continue;
        const gi = map.get(g);
        if (!gi) continue;
        const locals = g === w.file ? [] : localsFor(map, g, w.file, w.def);
        // Instances made in g of an imported class: s = StripeService() / const s = new Client()
        const inst = w.def.kind === "class" ? gi.defs.filter((d) => d.inst && locals.some((l) => d.inst === l || d.inst === `new ${l}`)).map((d) => d.name) : [];
        const names = [...locals, ...inst].map((l) => (w.member ? `${l}.${w.member}` : l));
        if (!names.length) continue;
        for (const call of map.callsOf(g).filter((c) => names.includes(c.callee))) {
          const ls = lines(g);
          const enc = map.enclosing(g, call.line);
          const from = enc ? (enc.member ? enc.def.members!.find((m) => m.name === enc.member)!.start : enc.def.start) - 1 : Math.max(0, call.line - 200);
          let keys: { key: string; line: number }[] = [];
          if (w.spread) {
            // f(**p) / f(...p) / f(key=…) / f({ key: … }) when the wrapper takes the keys themselves
            for (const s of call.spreads ?? []) keys.push(...keysOfLocal(ls, s, from, call.line - 1));
            for (const k of call.keys ?? []) {
              const at = ls.slice(call.line - 1, call.line + 60).findIndex((t) => new RegExp(`(?:^|[\\s,({])["']?${k}["']?\\s*(?::(?!:)|=(?!=))`).test(t));
              if (at >= 0) keys.push({ key: k, line: call.line + at });
            }
          } else {
            const a = call.args?.[w.index];
            if (a) keys.push(...keysOfLocal(ls, a, from, call.line - 1));
            else if (w.index === 0 && call.keys?.length) {
              for (const k of call.keys) {
                const at = ls.slice(call.line - 1, call.line + 60).findIndex((t) => new RegExp(`(?:^|[\\s,({])["']?${k}["']?\\s*:(?!:)`).test(t));
                if (at >= 0) keys.push({ key: k, line: call.line + at });
              }
            }
          }
          const via = `${names.find((n) => n === call.callee)}`;
          for (const k of keys) {
            const id = `${g}|${k.line}|${w.origin.op}|${k.key}`;
            if (have.has(id)) continue;
            have.add(id);
            out.push({
              provider: w.origin.provider, kind: w.origin.kind, lang: gi.lang === "py" ? "py" : /\.[cm]?jsx?$/.test(g) ? "js" : "ts",
              file: g, line: k.line, op: w.origin.op, ...(w.origin.sdkCall ? { sdkCall: w.origin.sdkCall } : {}), params: [k.key], confidence: "possible",
              snippet: (ls[k.line - 1] ?? "").trim().slice(0, 200),
              reason: `${k.key} set in ${g}:${k.line} → ${via} → ${[...w.path].reverse().join(" → ")}, which sends it`,
            });
          }
          // The caller passes on its own parameter: its function is a wrapper too, one hop further
          if (enc && hop < MAX_HOPS) {
            const cps = enc.member ? enc.def.members?.find((m) => m.name === enc.member)?.params : enc.def.params;
            const fwd = (call.spreads ?? []).find((n) => cps?.includes(`**${n}`) || cps?.includes(`...${n}`) || cps?.includes(n)) ?? (call.args ?? []).find((n) => n && cps?.includes(n));
            if (fwd && cps) {
              const pi = cps.findIndex((p) => p === fwd || p === `**${fwd}` || p === `...${fwd}`);
              const spread = cps[pi].startsWith("**") || cps[pi].startsWith("...");
              next.push({ file: g, def: enc.def, member: enc.member, spread, index: spread ? -1 : pi, origin: w.origin, path: [...w.path, `${via} (${g}:${call.line})`] });
            }
          }
        }
      }
    }
    wrappers = next;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// AI SDK wrappers: a repo function that hands its own `model` (and sampling settings) to generateText / streamText
// (typebot's runChatCompletion({ model, temperature, … })). Its callers choose the provider by the model they pass
// (createAnthropic({ apiKey })(name)); each setting they pass that the wrapper forwards is reported where it's set.

const AI_CALL = /\b(generateText|streamText|generateObject|streamObject)\s*\(\s*\{/g;

interface AiWrapper {
  file: string;
  def: CmDef;
  fn: string;
  line: number;
  /** Settings it forwards (AI SDK names), or all of them (a spread of its parameters) */
  keys: Set<string> | "all";
}

export function traceAiSdkWrappers(map: CallMap, usages: Usage[], text: (rel: string) => string | undefined, isTest: (file: string) => boolean, candidates: (any: string[], all?: string[]) => string[]): Usage[] {
  const wrappers: AiWrapper[] = [];
  for (const g of candidates(["generateText", "streamText", "generateObject", "streamObject"])) {
    if (isTest(g) || !/\.[cm]?[jt]sx?$/.test(g)) continue;
    const src = text(g);
    if (!src || src.length > 2_000_000) continue;
    const blanked = blankCode(src);
    const lines = src.split("\n");
    for (const m of src.matchAll(AI_CALL)) {
      const open = m.index! + m[0].length - 1;
      const end = closeAt(blanked, open);
      if (end <= open) continue;
      const line = src.slice(0, open).split("\n").length;
      const enc = map.enclosing(g, line);
      if (!enc || enc.member || enc.def.kind === "class" || enc.def.kind === "object") continue;
      const keys = topKeys(src, blanked, open, end);
      const model = keys.find((k) => k.key === "model");
      // The function's own parameters: its header, up to the line opening its body
      const header = lines.slice(enc.def.start - 1, Math.min(line, enc.def.start + 15)).join("\n");
      const hdr = header.slice(0, Math.max(0, header.search(/=>|\)\s*(?::[^{]*)?\{/)) + 2);
      const fromParams = (v: string) => {
        const root = /^([A-Za-z_$][\w$]*)/.exec(v)?.[1];
        if (!root || !new RegExp(`(?<![\\w$.])${root}(?![\\w$])`).test(hdr)) return false;
        // Not a local of the same name made before the call
        const body = lines.slice(enc.def.start, line - 1).join("\n");
        return !new RegExp(`\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b)?${root}\\b`).test(body);
      };
      const spread = keys.some((k) => k.spread && fromParams(k.value));
      if (!(model && fromParams(model.value)) && !spread) continue;
      const fwd = spread ? "all" : new Set(keys.filter((k) => PARAM_NAMES[k.key] && fromParams(k.value)).map((k) => k.key));
      if (fwd !== "all" && !fwd.size) continue;
      wrappers.push({ file: g, def: enc.def, fn: m[1], line, keys: fwd });
    }
  }
  const out: Usage[] = [];
  const have = new Set(usages.filter((u) => u.params?.length).map((u) => `${u.file}|${u.line}|${u.params![0]}`));
  for (const w of wrappers) {
    for (const c of candidates(callerNames(map, w.file, w.def))) {
      if (c === w.file || isTest(c)) continue;
      const locals = localsFor(map, c, w.file, w.def);
      if (!locals.length) continue;
      const src = text(c);
      if (!src || src.length > 2_000_000) continue;
      const factories = aiSdkFactories(src);
      if (![...factories.values()].length) continue;
      const blanked = blankCode(src);
      const lines = src.split("\n");
      for (const l of locals) {
        for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${l.replace(/[$]/g, "\\$")}\\s*\\(\\s*\\{`, "g"))) {
          const open = m.index! + m[0].length - 1;
          const end = closeAt(blanked, open);
          if (end <= open) continue;
          const keys = topKeys(src, blanked, open, end);
          const model = keys.find((k) => k.key === "model");
          const f = model ? /^([A-Za-z_$][\w$]*)\s*(?:\.\w+)?\s*\(/.exec(model.value)?.[1] : undefined;
          const prov = f ? factories.get(f) : undefined;
          if (!prov || !PROVIDER_OPS[prov]) continue;
          const id = /\(\s*["'`]([\w.:@/-]+)["'`]\s*\)\s*$/.exec(model!.value)?.[1];
          for (const k of keys) {
            const wire = PARAM_NAMES[k.key];
            if (!wire || (w.keys !== "all" && !w.keys.has(k.key))) continue;
            const line = src.slice(0, k.at).split("\n").length;
            if (have.has(`${c}|${line}|${wire}`)) continue;
            have.add(`${c}|${line}|${wire}`);
            out.push({
              provider: prov, kind: "sdk", lang: c.endsWith(".js") || c.endsWith(".mjs") || c.endsWith(".cjs") ? "js" : "ts", file: c, line,
              op: PROVIDER_OPS[prov].op, sdkCall: w.fn, params: [wire], confidence: "likely", snippet: (lines[line - 1] ?? "").trim().slice(0, 200),
              reason: `${k.key} passed to ${w.def.name} (${w.file}:${w.line}), which sends it in an AI SDK ${w.fn} call to ${prov}`,
              ...(prov === "anthropic" ? { aiSdk: id ? { model: id } : {} } : {}),
            });
          }
        }
      }
    }
  }
  return out;
}
