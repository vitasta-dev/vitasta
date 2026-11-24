import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";
const require = createRequire(import.meta.url);
const GRAMMARS = {
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
let ready;
const languages = new Map();
const parsers = new Map();
async function init() {
    ready ??= Parser.init();
    await ready;
}
/** Parse source code with the right tree-sitter grammar for the file. */
export async function parse(lang, file, source) {
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
    if (!tree)
        throw new Error(`tree-sitter could not parse ${file}`);
    return tree;
}
/** Load the grammars for these languages now, so parseLoaded can run without waiting */
export async function preload(langs) {
    await init();
    for (const key of langs) {
        if (languages.has(key))
            continue;
        languages.set(key, await Language.load(require.resolve(GRAMMARS[key])));
    }
}
/** Parse with a grammar already loaded (see preload); undefined when it isn't */
export function parseLoaded(lang, file, source) {
    const key = lang === "ts" && file.endsWith(".tsx") ? "tsx" : lang;
    let parser = parsers.get(key);
    if (!parser) {
        const language = languages.get(key);
        if (!language)
            return undefined;
        parser = new Parser();
        parser.setLanguage(language);
        parsers.set(key, parser);
    }
    return parser.parse(source) ?? undefined;
}
/** All descendants of the given node types, skipping nulls. */
export function nodesOfType(root, types) {
    return root.descendantsOfType(types).filter((n) => n !== null);
}
export function named(node) {
    return node.namedChildren.filter((n) => n !== null);
}
export function lineOf(node) {
    return node.startPosition.row + 1;
}
let lastSource;
let lastLines = [];
/** The lines of a file, split once for all the usages in it (files are scanned one at a time) */
export function linesOf(source) {
    if (source !== lastSource) {
        lastSource = source;
        lastLines = source.split("\n");
    }
    return lastLines;
}
export function snippetOf(source, node) {
    const line = linesOf(source)[node.startPosition.row] ?? "";
    return line.trim().slice(0, 200);
}
