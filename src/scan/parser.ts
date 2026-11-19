import { createRequire } from "node:module";
import { Language, Parser, type Node, type Tree } from "web-tree-sitter";
import type { Lang } from "../types.js";

const require = createRequire(import.meta.url);

const GRAMMARS: Record<Lang | "tsx", string> = {
  ts: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  js: "tree-sitter-typescript/tree-sitter-tsx.wasm", // the TSX grammar parses plain JS/JSX too
  py: "tree-sitter-python/tree-sitter-python.wasm",
  java: "tree-sitter-java/tree-sitter-java.wasm",
  go: "tree-sitter-go/tree-sitter-go.wasm",
  rb: "tree-sitter-ruby/tree-sitter-ruby.wasm",
  php: "tree-sitter-php/tree-sitter-php.wasm",
  cs: "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
};

let ready: Promise<void> | undefined;
const languages = new Map<string, Language>();
const parsers = new Map<string, Parser>();

async function init(): Promise<void> {
  ready ??= Parser.init();
  await ready;
}

/** Parse source code with the right tree-sitter grammar for the file. */
export async function parse(lang: Lang, file: string, source: string): Promise<Tree> {
  await init();
  const key = lang === "ts" && file.endsWith(".tsx") ? "tsx" : lang;
  let parser = parsers.get(key);
  if (!parser) {
    let language = languages.get(key);
    if (!language) {
      language = await Language.load(require.resolve(GRAMMARS[key]));
      languages.set(key, language);
    }
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(key, parser);
  }
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter could not parse ${file}`);
  return tree;
}

/** All descendants of the given node types, skipping nulls. */
export function nodesOfType(root: Node, types: string | string[]): Node[] {
  return root.descendantsOfType(types).filter((n): n is Node => n !== null);
}

export function named(node: Node): Node[] {
  return node.namedChildren.filter((n): n is Node => n !== null);
}

export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

let lastSource: string | undefined;
let lastLines: string[] = [];
/** The lines of a file, split once for all the usages in it (files are scanned one at a time) */
export function linesOf(source: string): string[] {
  if (source !== lastSource) {
    lastSource = source;
    lastLines = source.split("\n");
  }
  return lastLines;
}

export function snippetOf(source: string, node: Node): string {
  const line = linesOf(source)[node.startPosition.row] ?? "";
  return line.trim().slice(0, 200);
}

export type { Node, Tree };
