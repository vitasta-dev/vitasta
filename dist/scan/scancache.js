/**
 * Call map pilot: a per-file scan cache, so a rescan after a small change parses only what changed.
 *
 * Keyed by each file's git blob hash (sha1 of "blob <bytes>\0<content>": what `git ls-files -s` shows for a clean
 * file), computed from the content the scan reads anyway. That also covers edits not committed yet, and a checkout
 * with no git data or a shallow one, and never asks git to run anything from the repo (status can run its filters).
 * Where the repo has git data, the commit scanned is stored, and the files changed since it are counted with
 * `git diff --name-status <last>..HEAD` (external diff and textconv off), for the scan's own report.
 *
 * What's kept: per file, the call map index (structure only), the clients a JS/TS file exports, and that file's own
 * findings with the code line (snippet) removed; snippets are read back from the file on use. Never code text.
 * Entries are packed in gzip blocks of a few hundred (in the order the scan writes them, which is the order it reads
 * them next time) in one pack file, with a small index (hash of the key → block and slot; no file paths),
 * under a folder for the scanner build, feed and repo configuration. Only the index is read at the start; an entry is
 * read when the scan needs it, a block at a time. Each scan writes a new pack holding the entries it used, then swaps
 * it in: the old pack, and folders of other builds, are removed. The cache folder
 * is 0700 and its files 0600. It can be deleted at any time: a missing or unreadable entry is a miss.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
const SCHEMA = 3;
/** Past this, no more entries are written this scan (a huge repo scans the rest in full each time) */
const MAX_CACHE_BYTES = 100_000_000;
/** An entry bigger than this, compressed or not, isn't cached */
const MAX_ENTRY_BYTES = 20_000_000;
/** Entries per gzip block, and its size before packing */
const BLOCK_ENTRIES = 256;
const BLOCK_BYTES = 512_000;
const MAX_BLOCK_OUT = 64_000_000;
export const blobHash = (content) => {
    const buf = Buffer.from(content, "utf8");
    return createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
};
let buildHash;
/** A hash of the scanner's own code (this folder and its parent), so a new build never reads an old cache */
function scannerBuild() {
    if (buildHash)
        return buildHash;
    const h = createHash("sha256");
    const here = dirname(fileURLToPath(import.meta.url));
    const walk = (d, depth) => {
        let names = [];
        try {
            names = readdirSync(d).sort();
        }
        catch {
            return;
        }
        for (const n of names) {
            const p = join(d, n);
            let st;
            try {
                st = statSync(p);
            }
            catch {
                continue;
            }
            if (st.isDirectory() && depth < 3 && n !== "node_modules")
                walk(p, depth + 1);
            else if (st.isFile() && /\.(ts|js|mjs|json)$/.test(n) && st.size < 20_000_000)
                h.update(n).update(readFileSync(p));
        }
    };
    walk(join(here, ".."), 0);
    buildHash = h.digest("hex");
    return buildHash;
}
export function fingerprint(parts) {
    const h = createHash("sha256").update(scannerBuild()).update(String(SCHEMA));
    h.update(JSON.stringify(parts, (_k, v) => (v instanceof RegExp ? `/${v.source}/${v.flags}` : typeof v === "function" ? String(v) : v)));
    return h.digest("hex");
}
/** git, with nothing from the repo's configuration that could run a program */
function git(root, args) {
    try {
        return execFileSync("git", ["-C", root, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=", ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 15_000,
            maxBuffer: 20_000_000,
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" },
        }).trim();
    }
    catch {
        return undefined;
    }
}
const SHA = /^[0-9a-f]{40,64}$/;
export class ScanCache {
    dir;
    objects;
    old;
    out;
    /** Entries waiting for their block: key hashes and JSON text */
    pending = [];
    pendingBytes = 0;
    queued = new Set();
    /** The last blocks read, unpacked */
    blocks = new Map();
    written = 0;
    failed = false;
    /** Hits and misses this scan, and files changed since the last scanned commit (git), for the report */
    hits = 0;
    misses = 0;
    changedSinceLast;
    head;
    constructor(dir, root, fp) {
        this.dir = dir;
        // One folder per scanner build, feed and configuration: a different one never reads these entries
        this.objects = join(dir, `objects-${fp.slice(0, 24)}`);
        let meta;
        try {
            const raw = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
            if (raw && raw.schema === SCHEMA)
                meta = raw;
        }
        catch {
            meta = undefined;
        }
        try {
            const idx = JSON.parse(readFileSync(join(this.objects, "index.json"), "utf8"));
            if (idx && idx.schema === SCHEMA && /^pack-[0-9a-f]{16}\.bin$/.test(idx.pack) && idx.at && typeof idx.at === "object") {
                const fd = openSync(join(this.objects, idx.pack), "r");
                this.old = { fd, at: idx.at, size: fstatSync(fd).size };
            }
        }
        catch {
            this.old = undefined;
        }
        // The commit scanned, and what changed since the last one (a shallow clone may not have it: then no count)
        if (existsSync(join(root, ".git"))) {
            const head = git(root, ["rev-parse", "--verify", "HEAD"]);
            if (head && SHA.test(head)) {
                this.head = head;
                const last = meta?.lastCommit;
                if (last && SHA.test(last)) {
                    const diff = last === head ? "" : git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", `${last}..${head}`]);
                    if (diff !== undefined)
                        this.changedSinceLast = diff ? diff.split("\n").length : 0;
                }
            }
        }
    }
    static hash(key) {
        return createHash("sha256").update(key).digest("hex").slice(0, 40);
    }
    /** The new pack, opened on first use */
    writer() {
        if (this.out || this.failed)
            return this.out;
        try {
            mkdirSync(this.objects, { recursive: true, mode: 0o700 });
            chmodSync(this.dir, 0o700);
            chmodSync(this.objects, 0o700);
            const name = `pack-${createHash("sha256").update(`${process.pid}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 16)}.bin`;
            this.out = { fd: openSync(join(this.objects, name), "wx", 0o600), name, at: {}, pos: 0 };
        }
        catch {
            this.failed = true;
        }
        return this.out;
    }
    queue(h, text) {
        if (this.queued.has(h) || this.failed)
            return;
        this.queued.add(h);
        this.pending.push({ h, text });
        this.pendingBytes += text.length;
        if (this.pending.length >= BLOCK_ENTRIES || this.pendingBytes >= BLOCK_BYTES)
            this.flush();
    }
    /** One gzip block for the entries waiting (one zlib call for hundreds of entries) */
    flush() {
        const items = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        if (!items.length)
            return;
        const w = this.writer();
        if (!w)
            return;
        try {
            const gz = gzipSync(JSON.stringify(items.map((x) => x.text)), { level: 6 });
            if (this.written + gz.length > MAX_CACHE_BYTES)
                return;
            writeSync(w.fd, gz, 0, gz.length, w.pos);
            items.forEach((x, i) => (w.at[x.h] = [w.pos, gz.length, i]));
            w.pos += gz.length;
            this.written += gz.length;
        }
        catch {
            this.failed = true;
        }
    }
    block(off, len) {
        const have = this.blocks.get(off);
        if (have)
            return have;
        const chunk = Buffer.alloc(len);
        readSync(this.old.fd, chunk, 0, len, off);
        const texts = JSON.parse(gunzipSync(chunk, { maxOutputLength: MAX_BLOCK_OUT }).toString("utf8"));
        if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string"))
            return undefined;
        this.blocks.set(off, texts);
        if (this.blocks.size > 2)
            this.blocks.delete(this.blocks.keys().next().value);
        return texts;
    }
    /** The entry, freshly read (the scan may change it); kept for the next scan */
    get(key) {
        const h = ScanCache.hash(key);
        const loc = this.old?.at[h];
        if (this.old && Array.isArray(loc) && loc.length === 3 && loc.every((x) => Number.isInteger(x) && x >= 0) && loc[1] > 0 && loc[1] <= MAX_BLOCK_OUT && loc[0] + loc[1] <= this.old.size) {
            try {
                const text = this.block(loc[0], loc[1])?.[loc[2]];
                const e = text ? JSON.parse(text) : undefined;
                if (text && e && Array.isArray(e.usages)) {
                    this.queue(h, text);
                    this.hits++;
                    return e;
                }
            }
            catch {
                /* unreadable: a miss */
            }
        }
        this.misses++;
        return undefined;
    }
    /** Queued for the new pack (written a block at a time, so little stays in memory) */
    set(key, entry) {
        try {
            const text = JSON.stringify({ ...entry, usages: entry.usages.map(stripSnippet) });
            if (text.length > MAX_ENTRY_BYTES)
                return;
            const h = ScanCache.hash(key);
            // A set replaces a queued entry of the same key (one already in a block stays)
            if (this.queued.has(h)) {
                const at = this.pending.findIndex((x) => x.h === h);
                if (at >= 0)
                    this.pending[at] = { h, text };
                return;
            }
            this.queue(h, text);
        }
        catch {
            /* an entry that can't be written is no entry */
        }
    }
    /** Swap in the new pack and its index, with the commit scanned; old packs and other builds' folders go */
    save() {
        if (this.old) {
            try {
                closeSync(this.old.fd);
            }
            catch {
                /* closed */
            }
            this.old = undefined;
        }
        this.flush();
        const w = this.out;
        if (!w)
            return;
        this.out = undefined;
        try {
            closeSync(w.fd);
            const idx = { schema: SCHEMA, pack: w.name, at: w.at };
            const tmp = join(this.objects, `index.json.${process.pid}.tmp`);
            writeFileSync(tmp, JSON.stringify(idx), { mode: 0o600 });
            renameSync(tmp, join(this.objects, "index.json"));
            for (const name of readdirSync(this.objects))
                if (name !== w.name && name !== "index.json")
                    rmSync(join(this.objects, name), { recursive: true, force: true });
            for (const name of readdirSync(this.dir)) {
                const p = join(this.dir, name);
                if (name.startsWith("objects-") && p !== this.objects)
                    rmSync(p, { recursive: true, force: true });
                else if (name === "scan-cache.json")
                    unlinkSync(p);
            }
            const meta = { schema: SCHEMA, ...(this.head ? { lastCommit: this.head } : {}) };
            const mt = join(this.dir, `meta.json.${process.pid}.tmp`);
            writeFileSync(mt, JSON.stringify(meta), { mode: 0o600 });
            renameSync(mt, join(this.dir, "meta.json"));
        }
        catch {
            /* a cache that can't be saved is no cache next time */
        }
    }
}
/** A cached usage without its code line */
function stripSnippet(u) {
    const { snippet: _s, ...rest } = u;
    return { ...rest, snippet: "" };
}
/** Put the code lines back from the file's text (as the scan builds them: the line, trimmed, at most 200 characters) */
export function withSnippets(usages, source) {
    const lines = source.split("\n");
    return usages.map((u) => ({ ...u, snippet: (lines[u.line - 1] ?? "").trim().slice(0, 200) }));
}
