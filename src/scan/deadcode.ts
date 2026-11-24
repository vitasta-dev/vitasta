/**
 * Dead-code precision: a provider call inside a function or method that nothing in the repo refers to.
 *
 * A usage whose nearest named enclosing function (a) is private to its file, class or package, and (b) has a name
 * that appears nowhere else in the repo's source files (its own body excluded), gets `dead: true` and one step lower
 * confidence. A dead usage is still reported but never fails a check (src/check.ts canBlock).
 *
 * Conservative on purpose. Live, whatever else holds:
 *  - exported or public things (a library's API, a handler, a route, a framework entry point): never candidates; only
 *    what the language marks private is: TS/JS non-exported functions and `private` / `#` members, Python `_x`
 *    names and nested functions, Java/C#/PHP `private` methods, Go unexported names, Ruby `private` methods
 *  - anything with a decorator, annotation or attribute (@Scheduled, [HttpPost], #[Route], @app.task): a framework
 *    may call it
 *  - a name that appears anywhere else, in any source file of the repo (tests included), even in a string or comment
 *  - files that call by computed name (reflection, send, call_user_func, getattr …), partial classes, Unity-style
 *    engine callbacks, script files with no module syntax (globals called from HTML)
 *  - main / init / constructors / magic methods / Go Test* and Benchmark*
 * Test files are left to their role (a note); only app code is marked.
 *
 * Go: exported functions, methods and types are candidates too when the package is not a library (package main, an
 * internal/ path, or a repo with a main package and no pkg/ folder). A method belongs to its receiver type: the type
 * is dead when every mention of it, and of the constructors that return it (func NewX(...) *X), sits inside the
 * type's own declaration, methods and constructors; then each method is dead. `var _ Iface = (*T)(nil)`, a
 * registration call, another package's use and any test mention all name the type outside that cluster and keep it live.
 *
 * Two more kinds of dead place:
 *  - a whole class nothing refers to by name (TS/JS, Python, PHP, Ruby, Java, C#): no other place in the repo names it (no `new X`, `X::`, `X.`, import, config or string mention). Only plain units are candidates:
 *    not exported (TS/JS), not public (Java/C#), no base class or interface (a framework discovers those by
 *    convention: Rails controllers, ASP.NET controllers, Django class-based views), no decorator/annotation/attribute,
 *    no `__main__` guard, and in Python/PHP/Ruby only in a repo that doesn't publish a library (its public classes
 *    are its API), and not in a repo with a single file of that language (a script or sample). A module-level function
 *    is left alone beyond the non-exported and private ones above: scripts and notebooks import those. A framework that names the class in a route file, a config file or a string keeps it live.
 *  - code after a top-level stop: PHP `die()` / `exit`, Python `sys.exit()` / `raise SystemExit`, Ruby `exit`, Node
 *    `process.exit()` directly in the file's top level (not inside an if or a function) before the usage: it never runs.
 */
import { readFile } from "node:fs/promises";
import type { Lang, Usage } from "../types.js";
import type { Node, Tree } from "./parser.js";
import { named } from "./parser.js";
import { dirname, relative } from "node:path";
import { readFileSync } from "node:fs";
import { textFiles } from "./envdefaults.js";

export interface DeadSource {
  abs: string;
  rel: string;
  lang: Lang;
  source: string;
  doc?: boolean;
  shifted?: boolean;
}
export interface DeadDeps {
  /** Every source file of the repo (path on disk, relative path), also the ones that name no provider */
  files: { path: string; rel: string }[];
  /** The kept sources: the text the usages were found in */
  sources: DeadSource[];
  /** Parse one file, run `use` on its tree and free it */
  withTree: (p: DeadSource, use: (tree: Tree) => void) => Promise<void>;
  /** The repo's manifests (absolute paths) and root: a published library's public classes are its API */
  manifests?: string[];
  root?: string;
}

interface Def {
  name: string;
  /** 0-based start and end index in the file text */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** A whole class or module-level function, not a private method */
  unit?: "class" | "function";
  /** PHP names are case-insensitive */
  fold?: boolean;
  /** Go: an exported function, or the receiver type of an exported method (its whole cluster is judged) */
  go?: "func" | "type";
}

/** Files that call by a computed name: nothing in them can be shown unused */
const DYNAMIC: Partial<Record<Lang, RegExp>> = {
  ts: /\b(Reflect\.|eval\()|\[\s*(?:`|\w+\s*\+)|\bthis\[/,
  js: /\b(Reflect\.|eval\()|\[\s*(?:`|\w+\s*\+)|\bthis\[|\bwindow\[|\bglobalThis\[/,
  py: /\b(getattr|setattr|globals|locals|eval|exec|__getattr__|importlib)\s*\(|__getattribute__|__dict__/,
  java: /\b(getDeclaredMethods?|getMethods?|Method\b|invoke\s*\(|MethodHandle|Class\.forName)\b/,
  cs: /\b(GetMethods?|MethodInfo|Invoke\s*\(|Reflection|MonoBehaviour|BackgroundService|SendMessage|StartCoroutine|Activator)\b|\bpartial\s+class\b/,
  go: /\breflect\.|MethodByName|go:linkname|^\/\/export\b/m,
  rb: /\b(public_send|__send__|send|method_missing|define_method|instance_method|respond_to_missing\?|const_get|class_eval|instance_eval)\b|\.method\(/,
  php: /\b(call_user_func(_array)?|method_exists|ReflectionMethod|ReflectionClass|__call|__callStatic)\b|->\s*\$\w+\s*\(|::\s*\$\w+\s*\(|\$\$\w+/,
};

const MODULE_SYNTAX = /^\s*(import\s|export\s|import\{)|\brequire\(|\bmodule\.exports\b|\bexports\./m;

const text = (n: Node | null | undefined) => n?.text ?? "";
const PRIVATE_ENTRY = /^(main|init|setup|teardown|constructor|__\w+__|__\w+|Main|Dispose|Finalize|ToString|Equals|GetHashCode|Test\w*|Benchmark\w*|Example\w*|Fuzz\w*)$/;

/** The places that would make this usage dead if nothing referred to them: its private method, and its whole class or function */
function candidatesOf(lang: Lang, rel: string, fileText: string, leaf: Node, library: boolean): Def[] {
  if (DYNAMIC[lang]?.test(fileText)) return [];
  const out: Def[] = [];
  for (let n: Node | null = leaf; n; n = n.parent) {
    const d = defAt(lang, rel, fileText, n);
    if (d === undefined) continue;
    if (d !== "live") out.push(d);
    break;
  }
  const unit = unitAt(lang, rel, fileText, leaf, library);
  if (unit) out.push(unit);
  return out;
}

const mk = (name: string, n: Node): Def => ({ name, start: n.startIndex, end: n.endIndex, startLine: n.startPosition.row + 1, endLine: n.endPosition.row + 1 });

/**
 * undefined: this node isn't a named definition (keep climbing); "live": a named definition that isn't a candidate
 * (stop: the call is in code something may reach); a Def: a private, undecorated, named definition
 */
function defAt(lang: Lang, rel: string, fileText: string, n: Node): Def | "live" | undefined {
  switch (lang) {
    case "ts":
    case "js": {
      if (n.type === "method_definition") {
        const name = text(n.childForFieldName("name"));
        if (!name) return "live";
        const priv = n.childForFieldName("name")?.type === "private_property_identifier" || named(n).some((c) => c.type === "accessibility_modifier" && c.text === "private");
        const decorated = named(n).some((c) => c.type === "decorator") || n.previousNamedSibling?.type === "decorator";
        if (!priv || decorated || PRIVATE_ENTRY.test(name)) return "live";
        return mk(name.replace(/^#/, ""), n);
      }
      let name = "";
      if (n.type === "function_declaration" || n.type === "generator_function_declaration") name = text(n.childForFieldName("name"));
      else if ((n.type === "arrow_function" || n.type === "function_expression" || n.type === "function") && n.parent?.type === "variable_declarator" && n.parent.parent?.parent?.type === "program") {
        name = text(n.parent.childForFieldName("name"));
      } else return undefined;
      if (!name) return undefined;
      const top = n.type === "function_declaration" ? n.parent : n.parent?.parent?.parent;
      const atTop = top?.type === "program";
      if (atTop && (!MODULE_SYNTAX.test(fileText) || n.parent?.type === "export_statement")) return "live";
      if (n.type === "function_declaration" && n.parent?.type === "export_statement") return "live";
      if (PRIVATE_ENTRY.test(name)) return "live";
      return mk(name, n);
    }
    case "py": {
      if (n.type !== "function_definition") return undefined;
      const name = text(n.childForFieldName("name"));
      if (!name || n.parent?.type === "decorated_definition" || PRIVATE_ENTRY.test(name)) return "live";
      let nested = false;
      for (let p = n.parent; p; p = p.parent) if (p.type === "function_definition") nested = true;
      let inClass = false;
      for (let p = n.parent; p && !inClass; p = p.parent) {
        if (p.type === "class_definition") inClass = true;
        else if (p.type === "function_definition") break;
      }
      // a nested function that is only defined; a `_private` module function or method
      if (!nested && !name.startsWith("_")) return "live";
      void inClass;
      return mk(name, n);
    }
    case "java": {
      if (n.type !== "method_declaration") return undefined;
      const name = text(n.childForFieldName("name"));
      const mods = named(n).find((c) => c.type === "modifiers");
      if (!name || !mods || !/\bprivate\b/.test(mods.text) || /@/.test(mods.text) || PRIVATE_ENTRY.test(name)) return "live";
      return mk(name, n);
    }
    case "cs": {
      if (n.type === "local_function_statement") {
        const name = text(n.childForFieldName("name"));
        return name ? mk(name, n) : "live";
      }
      if (n.type !== "method_declaration") return undefined;
      const name = text(n.childForFieldName("name"));
      const mods = named(n).filter((c) => c.type === "modifier").map((c) => c.text);
      if (!name || named(n).some((c) => c.type === "attribute_list" || c.type === "explicit_interface_specifier") || n.text.includes("[Obsolete")) return "live";
      if (mods.some((m) => /^(public|protected|internal|override|virtual|abstract|extern|partial|async void)$/.test(m))) return "live";
      if (n.childForFieldName("name")?.text.includes(".") || PRIVATE_ENTRY.test(name)) return "live";
      return mk(name, n);
    }
    case "go": {
      if (n.type !== "function_declaration" && n.type !== "method_declaration") return undefined;
      const name = text(n.childForFieldName("name"));
      if (!name || /^[A-Z]/.test(name) || PRIVATE_ENTRY.test(name) || /_test\.go$/.test(rel)) return "live";
      return mk(name, n);
    }
    case "rb": {
      if (n.type !== "method" && n.type !== "singleton_method") return undefined;
      const name = text(n.childForFieldName("name"));
      if (!name || PRIVATE_ENTRY.test(name)) return "live";
      // `private def x` or a bare `private` / `protected` line before it in the same body
      const p = n.parent;
      if (p?.type === "argument_list" && p.parent?.type === "call" && text(p.parent.childForFieldName("method")) === "private") return mk(name, n);
      if (n.type === "method" && p) {
        let mode = "public";
        for (const s of named(p)) {
          if (s.startIndex >= n.startIndex) break;
          if (s.type === "identifier" && /^(private|public|protected)$/.test(s.text)) mode = s.text;
        }
        if (mode === "private") return mk(name, n);
      }
      return "live";
    }
    case "php": {
      if (n.type !== "method_declaration") return undefined;
      const name = text(n.childForFieldName("name"));
      const vis = named(n).find((c) => c.type === "visibility_modifier");
      if (!name || vis?.text !== "private" || n.childForFieldName("attributes") || named(n).some((c) => c.type === "attribute_list") || PRIVATE_ENTRY.test(name)) return "live";
      return mk(name, n);
    }
    default:
      return "live";
  }
}

const ENTRY_UNIT = /^(Main|Program|Startup|App|Application|main|index|handler|lambda_handler)$/;
/** A decorator, annotation or attribute anywhere in a unit (@Scheduled, [HttpPost], #[Route], @app.task): a framework may call it */
const MARKERS: Partial<Record<Lang, RegExp>> = {
  ts: /^\s*@\w+/m, js: /^\s*@\w+/m, py: /^\s*@\w+/m, java: /(^|\s)@[A-Z]\w*/, cs: /^\s*\[[A-Z]\w*[\](]/m, php: /#\[/, rb: /\b(before_|after_|around_|helper_method|scope\b|validates?\b|has_many|belongs_to)/,
};
const marked = (lang: Lang, n: Node) => !!MARKERS[lang]?.test(n.text);
const hasChild = (n: Node, types: string[]) => named(n).some((c) => types.includes(c.type));

/** The whole class or module-level function around a usage, when it's plain enough to be shown unreferenced */
function unitAt(lang: Lang, rel: string, fileText: string, leaf: Node, library: boolean): Def | undefined {
  const outer = (types: string[], fnTypes: string[] = []): Node | undefined => {
    let found: Node | undefined;
    for (let n: Node | null = leaf; n; n = n.parent) {
      if (types.includes(n.type) || fnTypes.includes(n.type)) found = n;
    }
    return found;
  };
  switch (lang) {
    case "ts":
    case "js": {
      const c = outer(["class_declaration", "abstract_class_declaration"]);
      if (!c || c.parent?.type !== "program" || !MODULE_SYNTAX.test(fileText)) return undefined;
      if (hasChild(c, ["class_heritage", "decorator"]) || c.previousNamedSibling?.type === "decorator") return undefined;
      const name = text(c.childForFieldName("name"));
      return name && !ENTRY_UNIT.test(name) && !marked(lang, c) ? { ...mk(name, c), unit: "class" } : undefined;
    }
    case "py": {
      if (library || /__name__\s*==\s*["']__main__["']/.test(fileText)) return undefined;
      // the outermost class, directly in the module and not decorated (a route, a task, a command). A public module
      // function is left alone: scripts, notebooks and other repos import those
      let top: Node | undefined;
      for (let n: Node | null = leaf; n; n = n.parent) if ((n.type === "class_definition" || n.type === "function_definition") && n.parent?.type === "module") top = n;
      if (!top || top.type !== "class_definition") return undefined;
      const name = text(top.childForFieldName("name"));
      if (!name || ENTRY_UNIT.test(name) || PRIVATE_ENTRY.test(name)) return undefined;
      if (top.type === "class_definition") {
        const bases = text(top.childForFieldName("superclasses")).replace(/[()\s]/g, "");
        if (bases && bases !== "object") return undefined;
      }
      if (marked(lang, top)) return undefined;
      return { ...mk(name, top), unit: top.type === "class_definition" ? "class" : "function" };
    }
    case "php": {
      if (library) return undefined;
      let top: Node | undefined;
      for (let n: Node | null = leaf; n; n = n.parent) if ((n.type === "class_declaration") && ["program", "namespace_definition", "compound_statement"].includes(n.parent?.type ?? "") && n.parent?.parent?.type !== "function_definition") top = n;
      if (!top || (top.parent?.type === "compound_statement" && top.parent.parent?.type !== "namespace_definition")) return undefined;
      if (top.type === "class_declaration" && hasChild(top, ["base_clause", "class_interface_clause", "attribute_list"])) return undefined;
      if (top.childForFieldName("attributes")) return undefined;
      const name = text(top.childForFieldName("name"));
      if (!name || ENTRY_UNIT.test(name) || PRIVATE_ENTRY.test(name)) return undefined;
      if (marked(lang, top)) return undefined;
      return { ...mk(name, top), unit: top.type === "class_declaration" ? "class" : "function", fold: true };
    }
    case "rb": {
      if (library) return undefined;
      let top: Node | undefined;
      for (let n: Node | null = leaf; n; n = n.parent) if (n.type === "class" && ["program", "module"].includes(n.parent?.type ?? "") || (n.type === "class" && n.parent?.type === "body_statement" && n.parent.parent?.type === "module")) top = n;
      if (!top || top.childForFieldName("superclass")) return undefined;
      const name = text(top.childForFieldName("name")).split("::").pop()!;
      return name && !ENTRY_UNIT.test(name) && !marked(lang, top) ? { ...mk(name, top), unit: "class" } : undefined;
    }
    case "java": {
      const c = outer(["class_declaration"]);
      if (!c || c.parent?.type !== "program") return undefined;
      const mods = named(c).find((x) => x.type === "modifiers")?.text ?? "";
      if (/\bpublic\b|@/.test(mods) || hasChild(c, ["superclass", "super_interfaces"]) || /static\s+void\s+main\s*\(/.test(c.text)) return undefined;
      const name = text(c.childForFieldName("name"));
      return name && !ENTRY_UNIT.test(name) && !marked(lang, c) ? { ...mk(name, c), unit: "class" } : undefined;
    }
    case "cs": {
      const c = outer(["class_declaration"]);
      if (!c || !["compilation_unit", "declaration_list", "file_scoped_namespace_declaration"].includes(c.parent?.type ?? "")) return undefined;
      if (c.parent?.type === "declaration_list" && c.parent.parent?.type === "class_declaration") return undefined;
      const mods = named(c).filter((x) => x.type === "modifier").map((x) => x.text);
      if (mods.some((m) => /^(public|partial|static|abstract)$/.test(m)) || hasChild(c, ["attribute_list", "base_list"]) || /static\s+(?:async\s+)?(?:void|int|Task)\s+Main\s*\(/.test(c.text)) return undefined;
      const name = text(c.childForFieldName("name"));
      return name && !ENTRY_UNIT.test(name) && !marked(lang, c) ? { ...mk(name, c), unit: "class" } : undefined;
    }
    default:
      return undefined;
  }
}

/** The end line (1-based) of the first statement directly in the file's top level that stops the program, if any */
function stopAt(lang: Lang, root: Node): number | undefined {
  for (const n of named(root)) {
    let stops = false;
    const call = n.type === "expression_statement" ? named(n)[0] : undefined;
    const callee = text(call?.childForFieldName("function")).replace(/\s+/g, "");
    if (lang === "php") stops = n.type === "exit_statement" || (call?.type === "function_call_expression" && /^(die|exit)$/i.test(callee)) || (n.type === "expression_statement" && call?.type === "exit_statement");
    else if (lang === "py") stops = (call?.type === "call" && /^(sys\.exit|exit|quit|os\._exit)$/.test(callee)) || (n.type === "raise_statement" && /^raise\s+SystemExit\b/.test(n.text));
    else if (lang === "rb") stops = (n.type === "identifier" && /^(exit|abort)$/.test(n.text)) || (n.type === "call" && /^(exit|abort|exit!)$/.test(text(n.childForFieldName("method"))) && !n.childForFieldName("receiver"));
    else if (lang === "ts" || lang === "js") stops = call?.type === "call_expression" && /^process\.exit$/.test(callee);
    if (stops) return n.endPosition.row + 1;
  }
  return undefined;
}

/** Directories of manifests that publish a library: the public classes of Python, PHP and Ruby code under them are its API */
function libraryDirs(manifests: string[] | undefined, root: string | undefined): string[] {
  if (!manifests || root === undefined) return [];
  const dirs: string[] = [];
  for (const abs of manifests.slice(0, 400)) {
    const base = abs.split("/").pop() ?? "";
    let isLib = false;
    if (/\.gemspec$/.test(base) || base === "setup.py" || base === "setup.cfg") isLib = true;
    else if (base === "composer.json" || base === "pyproject.toml") {
      try {
        const t = readFileSync(abs, "utf8").slice(0, 100_000);
        isLib = base === "composer.json" ? /"type"\s*:\s*"library"/.test(t) : /^\s*\[(?:project|tool\.poetry)\]/m.test(t) && /^\s*name\s*=/m.test(t);
      } catch { /* unreadable: not a library */ }
    }
    if (isLib) dirs.push(relative(root, dirname(abs)));
  }
  return dirs;
}

/** Count how often each wanted name appears as a whole word in a text; `fold` names (PHP) match in any case */
function countWords(textIn: string, wanted: Set<string>, into: Map<string, number>, fold?: Set<string>): void {
  for (const m of textIn.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (wanted.has(m[0])) into.set(m[0], (into.get(m[0]) ?? 0) + 1);
    if (fold) {
      const l = m[0].toLowerCase();
      if (fold.has(l)) into.set(`~${l}`, (into.get(`~${l}`) ?? 0) + 1);
    }
  }
}

const MAX_READ_BYTES = 80_000_000;

/**
 * Loaded by convention, not by name: somewhere in the repo class names are built from strings, or plugins are found
 * through entry points. Then no class of that language can be shown unreferenced.
 */
const LOADS_BY_CONVENTION: Partial<Record<Lang, RegExp>> = {
  // app()->make("App\\Services\\" . $name), new $class, class_exists($c), container->get($id) with a built id, PSR-4 plugin scans
  php: /\bnew\s+\(?\\?\$\w|->\s*(?:make|get|resolve|build|bound)\(\s*(?:["'][^"']*["']\s*\.|\$\w)|\b(?:app|resolve)\(\s*(?:["'][^"']*["']\s*\.|\$\w)|\bclass_exists\(\s*\$|\$\w+\s*::\s*class\b|\bReflectionClass\(\s*\$|\bcall_user_func(?:_array)?\(\s*\[?\s*\$|\bget_declared_classes\b|\bspl_autoload_register\b/,
  // importlib / __import__ / pkgutil / entry points (code, pyproject [project.entry-points], setup.cfg, setup.py)
  py: /\b(?:importlib\.import_module|import_module|__import__|pkgutil\.(?:iter_modules|walk_packages)|iter_entry_points|entry_points|load_entry_point|pkg_resources)\b|\[(?:project\.entry-points|project\.scripts|options\.entry_points|tool\.poetry\.(?:plugins|scripts))\b|\bentry_points\s*=/,
  rb: /\b(?:const_get|safe_constantize|constantize|Kernel\.const_get|autoload|Zeitwerk|ObjectSpace\.each_object)\b/,
  java: /\b(?:Class\.forName|ServiceLoader|getDeclaredConstructor|loadClass)\b/,
  cs: /\b(?:Activator\.CreateInstance|Assembly\.GetTypes|GetType\(\s*[^)"]|Type\.GetType)\b/,
};
const LANG_OF_EXT: [RegExp, Lang][] = [[/\.py$/, "py"], [/\.php$/, "php"], [/\.(rb|rake)$/, "rb"], [/\.java$/, "java"], [/\.cs$/, "cs"]];


/** The brace-balanced end of the block opening at `open` in Go text (strings, runes and comments skipped) */
function goClose(src: string, open: number): number {
  let d = 0;
  for (let i = open; i < Math.min(src.length, open + 400_000); i++) {
    const c = src[i];
    if (c === '"' || c === "`" || c === "'") {
      const q = c;
      for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\" && q !== "`") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j; continue; }
    if (c === "/" && src[i + 1] === "*") { const j = src.indexOf("*/", i + 2); i = j < 0 ? src.length : j + 1; continue; }
    if (c === "{") d++;
    else if (c === "}" && --d === 0) return i;
  }
  return -1;
}

/** Go: the exported function, or the receiver type of the method, around a usage */
function goUnitAt(rel: string, leaf: Node): Def | undefined {
  if (/_test\.go$/.test(rel)) return undefined;
  for (let n: Node | null = leaf; n; n = n.parent) {
    if (n.type === "method_declaration") {
      const recv = text(n.childForFieldName("receiver"));
      const t = /([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*$/.exec(recv)?.[1];
      return t ? { ...mk(t, n), unit: "class", go: "type" } : undefined;
    }
    if (n.type === "function_declaration") {
      const name = text(n.childForFieldName("name"));
      return name && /^[A-Z]/.test(name) && !PRIVATE_ENTRY.test(name) ? { ...mk(name, n), unit: "function", go: "func" } : undefined;
    }
  }
  return undefined;
}

/** Not a Go library: package main, an internal/ path, or a repo with a main package and no pkg/ folder */
function goIsApp(rel: string, texts: Map<string, string>): boolean {
  if (/(^|\/)internal\//.test(rel)) return true;
  if (/^\s*package\s+main\b/m.test(texts.get(rel) ?? "")) return true;
  const rels = [...texts.keys()];
  const hasMain = rels.some((r) => /^\s*package\s+main\b/m.test(texts.get(r) ?? ""));
  const hasPkg = rels.some((r) => /(^|\/)pkg\//.test(r));
  return hasMain && !hasPkg && !/(^|\/)pkg\//.test(rel);
}

/** Is Go type T, with its methods and constructors, mentioned anywhere but in that cluster? */
function goTypeDead(t: string, texts: Map<string, string>, totalOf: (name: string) => number): boolean {
  const re = new RegExp(`(?<![\\w$])${t}(?![\\w$])`, "g");
  const ranges: { file: string; a: number; b: number }[] = [];
  const ctors = new Set<string>();
  const comment = (src: string, at: number) => {
    // the doc comment lines right above a declaration belong to it
    let a = at;
    for (;;) {
      const prev = src.lastIndexOf("\n", a - 2);
      const line = src.slice(prev + 1, a - 1);
      if (/^\s*\/\//.test(line) && prev >= 0) a = prev + 1;
      else return a;
    }
  };
  for (const [file, src] of texts) {
    if (/_test\.go$/.test(file)) continue;
    for (const m of src.matchAll(new RegExp(`^type\\s+${t}\\b`, "gm"))) {
      const nl = src.indexOf("\n", m.index!);
      const brace = src.slice(m.index!, nl < 0 ? undefined : nl).includes("{") ? src.indexOf("{", m.index!) : -1;
      const end = brace >= 0 ? goClose(src, brace) : nl;
      ranges.push({ file, a: comment(src, m.index!), b: end < 0 ? src.length : end });
    }
    for (const m of src.matchAll(new RegExp(`^func\\s*\\(\\s*\\w*\\s*\\*?${t}(?:\\[[^\\]]*\\])?\\s*\\)\\s*\\w+[^{\\n]*\\{`, "gm"))) {
      const end = goClose(src, m.index! + m[0].length - 1);
      ranges.push({ file, a: comment(src, m.index!), b: end < 0 ? src.length : end });
    }
    // constructors: func NewT(...) *T / T / (*T, error)
    for (const m of src.matchAll(new RegExp(`^func\\s+([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\([^)]*\\)\\s*\\(?\\s*\\*?${t}\\b[^{\\n]*\\{`, "gm"))) {
      ctors.add(m[1]);
      const end = goClose(src, m.index! + m[0].length - 1);
      ranges.push({ file, a: comment(src, m.index!), b: end < 0 ? src.length : end });
    }
  }
  if (!ranges.length) return false;
  const inRanges = (word: RegExp) => ranges.reduce((n, r) => n + (texts.get(r.file)!.slice(r.a, r.b).match(word)?.length ?? 0), 0);
  if (totalOf(t) - inRanges(re) > 0) return false;
  for (const c of ctors) {
    const cre = new RegExp(`(?<![\\w$])${c}(?![\\w$])`, "g");
    let all = 0;
    for (const src of texts.values()) all += src.match(cre)?.length ?? 0;
    if (all - inRanges(cre) > 0) return false;
  }
  return true;
}

export async function markDeadCode(usages: Usage[], deps: DeadDeps): Promise<void> {
  const byFile = new Map<string, Usage[]>();
  for (const u of usages) {
    if (u.inTest || u.doc || u.dead || u.recorded || u.listed) continue;
    (byFile.get(u.file) ?? byFile.set(u.file, []).get(u.file)!).push(u);
  }
  if (!byFile.size) return;
  const libs = libraryDirs(deps.manifests, deps.root);
  const dead = (u: Usage, why: string) => {
    u.dead = true;
    u.confidence = u.confidence === "certain" ? "likely" : "possible";
    u.reason = u.reason ? `${u.reason}; ${why}` : why;
  };
  const candidates: { u: Usage; def: Def }[] = [];
  for (const [rel, us] of byFile) {
    const src = deps.sources.find((s) => s.rel === rel && !s.doc && !s.shifted);
    if (!src || !["ts", "js", "py", "java", "cs", "go", "rb", "php"].includes(src.lang)) continue;
    const lines = src.source.split("\n");
    // (a lone Python / PHP / Ruby file is a script or a sample, not a wired-up app)
    const ext = src.lang === "py" ? /\.py$/ : src.lang === "php" ? /\.php$/ : src.lang === "rb" ? /\.(rb|rake)$/ : undefined;
    const library = libs.some((d) => d === "" || rel.startsWith(d + "/")) || (!!ext && deps.files.filter((f) => ext.test(f.rel)).length < 2);
    await deps.withTree(src, (tree) => {
      const stop = stopAt(src.lang, tree.rootNode);
      for (const u of us) {
        // after a top-level exit / die: never runs
        if (stop !== undefined && u.line > stop) {
          dead(u, `after a top-level stop at line ${stop} of this file: it never runs`);
          continue;
        }
        const lineText = lines[u.line - 1] ?? "";
        const col = Math.max(0, lineText.search(/\S/));
        const leaf = tree.rootNode.descendantForPosition({ row: Math.max(0, u.line - 1), column: col });
        if (!leaf) continue;
        for (const def of candidatesOf(src.lang, rel, src.source, leaf, library)) candidates.push({ u, def });
        if (src.lang === "go" && !DYNAMIC.go!.test(src.source)) {
          const g = goUnitAt(rel, leaf);
          if (g) candidates.push({ u, def: g });
        }
      }
    });
  }
  if (!candidates.length) return;
  const wanted = new Set(candidates.filter((c) => !c.def.fold).map((c) => c.def.name));
  const fold = new Set(candidates.filter((c) => c.def.fold).map((c) => c.def.name.toLowerCase()));
  const total = new Map<string, number>();
  const byConvention = new Set<Lang>();
  const goTexts = new Map<string, string>();
  const unitLang = (rel: string): Lang => LANG_OF_EXT.find(([re]) => re.test(rel))?.[1] ?? "ts";
  let bytes = 0;
  // every source file, and the config and script files that can name a class or a handler by string
  for (const f of [...deps.files, ...(candidates.some((c) => c.def.unit) && deps.root !== undefined ? await textFiles(deps.root) : [])]) {
    let t: string;
    try {
      t = await readFile(f.path, "utf8");
    } catch {
      continue;
    }
    bytes += t.length;
    if (bytes > MAX_READ_BYTES) return; // too big to be sure: mark nothing
    countWords(t, wanted, total, fold);
    if (f.rel.endsWith(".go")) goTexts.set(f.rel, t);
    // (python entry points also sit in pyproject / setup.cfg, which are text files)
    const l = LANG_OF_EXT.find(([re]) => re.test(f.rel))?.[1] ?? (/(?:pyproject\.toml|setup\.cfg|setup\.py)$/.test(f.rel) ? "py" : undefined);
    if (l && !byConvention.has(l) && LOADS_BY_CONVENTION[l]!.test(t)) byConvention.add(l);
  }
  for (const { u, def } of candidates) {
    if (u.dead) continue;
    if (def.unit && byConvention.has(unitLang(u.file))) continue;
    if (def.go === "type") {
      if (goIsApp(u.file, goTexts) && goTypeDead(def.name, goTexts, (n) => total.get(n) ?? 0)) dead(u, `inside a method of type ${def.name}, which nothing in the repo refers to (nor to its constructors)`);
      continue;
    }
    if (def.go === "func" && !goIsApp(u.file, goTexts)) continue;
    const src = deps.sources.find((s) => s.rel === u.file && !s.doc && !s.shifted)!;
    const own = new Map<string, number>();
    countWords(src.source.slice(def.start, def.end), new Set(def.fold ? [] : [def.name]), own, def.fold ? new Set([def.name.toLowerCase()]) : undefined);
    const key = def.fold ? `~${def.name.toLowerCase()}` : def.name;
    if ((total.get(key) ?? 0) - (own.get(key) ?? 0) > 0) continue;
    dead(u, def.unit ? `inside ${def.unit} ${def.name}, which nothing in the repo refers to` : `inside ${def.name}(), which nothing in the repo calls or exports`);
  }
}
