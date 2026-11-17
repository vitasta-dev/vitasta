/**
 * Labelling page: shows one place at a time and records whether it's a real use. With the keyboard, about 50
 * places take 20 minutes.
 *
 *   npx tsx bench/label.ts --by <your name> [--port 4173]
 *
 * Reads every queue in bench/queue/, skips places that already have a label, and appends answers to
 * bench/labels/labels.jsonl (commit that file). Runs on 127.0.0.1 only; code is shown as text, never as HTML.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { arg } from "./corpus.js";
import { LABELS, loadLabels, QUEUE, readJsonl, type Label } from "./lib.js";
import type { QueueItem } from "./sample.js";

const by = arg("--by");
if (!by || !/^[\w .-]{1,40}$/.test(by)) throw new Error("--by <your name> is required");
const port = Number(arg("--port", "4173"));
const token = randomBytes(16).toString("hex");

async function queue(): Promise<QueueItem[]> {
  const files = (await readdir(QUEUE).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
  const labels = await loadLabels();
  const items: QueueItem[] = [];
  const seen = new Set<string>();
  for (const f of files) for (const it of await readJsonl<QueueItem>(join(QUEUE, f))) if (!labels.has(it.key) && !seen.has(it.key)) (seen.add(it.key), items.push(it));
  return items;
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vitasta labelling</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--mut:#78716c;--card:#fff;--line:#e7e5e4;--hi:#fef3c7;--ok:#15803d;--no:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--mut:#a8a29e;--card:#292524;--line:#44403c;--hi:#713f12;--ok:#4ade80;--no:#f87171}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px}
.top{display:flex;justify-content:space-between;color:var(--mut);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:12px}
.q{font-size:18px;font-weight:600;margin:4px 0 8px}
code,pre{font-family:ui-monospace,Menlo,monospace}
pre{overflow:auto;font-size:12.5px;line-height:1.45;margin:0;padding:10px;border-radius:8px;border:1px solid var(--line)}
pre span{display:block;white-space:pre}
pre span.hit{background:var(--hi)}
.meta{color:var(--mut);font-size:13px;margin-bottom:8px;word-break:break-all}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
button{font:inherit;padding:10px 16px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.ok{border-color:var(--ok);color:var(--ok)}button.no{border-color:var(--no);color:var(--no)}
details{margin-top:12px;color:var(--mut);font-size:13px}
a{color:inherit}
</style>
<main>
<div class="top"><span id="progress"></span><span>keys: <b>1</b> real · <b>2</b> not · <b>3</b> unsure · <b>s</b> skip · <b>u</b> undo</span></div>
<div class="card" id="card">Loading…</div>
<details><summary>What counts as real?</summary>
<p><b>Real:</b> code that calls this API, or that sets this model or version as the one to use: a model parameter, a model variable or config value, an allowed-models list or picker, a factory call. Test files count as real (they're marked separately).</p>
<p><b>Not:</b> comments, docs, labels and sentences, price/limit/capability tables, dictionary keys, comparisons ("if model == …"), migration maps, lists of every known model.</p>
<p><b>Unsure:</b> you can't tell from the code shown. Open the link for more.</p></details>
</main>
<script>
const TOKEN = ${JSON.stringify(token)};
let items = [], i = 0, history = [];
const el = (t, cls, text) => { const e = document.createElement(t); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function render() {
  const card = document.getElementById("card");
  card.replaceChildren();
  document.getElementById("progress").textContent = items.length ? (i + 1) + " of " + items.length + " left in this session" : "";
  const it = items[i];
  if (!it) { card.textContent = "All done. Commit bench/labels/labels.jsonl."; return; }
  const q = it.kind === "precision"
    ? "Is this a real use of " + it.thing + "?"
    : "Is " + it.thing + " used here as a real model setting or API call?";
  card.append(el("div", "q", q));
  const link = el("a", null, it.repo + " · " + it.file + ":" + it.line);
  link.href = "https://github.com/" + it.repo + "/blob/" + it.sha + "/" + it.file.split("/").map(encodeURIComponent).join("/") + "#L" + it.line;
  link.target = "_blank"; link.rel = "noopener noreferrer";
  const meta = el("div", "meta"); meta.append(link);
  if (it.claim) meta.append(el("div", null, "Scanner says: " + it.claim + (it.rule ? " [" + it.rule + "]" : "")));
  if (it.inTest) meta.append(el("div", null, "In a test, example or fixture file"));
  card.append(meta);
  const pre = el("pre");
  for (const line of it.context.split("\\n")) pre.append(el("span", line.slice(4, 6) === " >" ? "hit" : null, line));
  card.append(pre);
  const btns = el("div", "btns");
  for (const [k, label, cls] of [["1", "Real", "ok"], ["2", "Not", "no"], ["3", "Unsure", ""], ["s", "Skip", ""]]) {
    const b = el("button", cls, k + " · " + label); b.onclick = () => act(k); btns.append(b);
  }
  card.append(btns);
  pre.querySelector(".hit")?.scrollIntoView({ block: "center" });
}
async function act(k) {
  const it = items[i];
  if (k === "u") { if (!history.length) return; i = history.pop(); render(); return; }
  if (!it) return;
  const label = { "1": "real", "2": "not", "3": "unsure" }[k];
  if (label) {
    const r = await fetch("/label", { method: "POST", headers: { "content-type": "application/json", "x-token": TOKEN }, body: JSON.stringify({ key: it.key, label, set: it.set }) });
    if (!r.ok) { alert("Saving failed: " + r.status); return; }
  } else if (k !== "s") return;
  history.push(i); i++; render();
}
document.addEventListener("keydown", (e) => { if (!e.metaKey && !e.ctrlKey) act(e.key.toLowerCase()); });
fetch("/items", { headers: { "x-token": TOKEN } }).then((r) => r.json()).then((d) => { items = d; render(); });
</script>`;

const server = createServer(async (req, res) => {
  // Only this page may read or write: a per-run token stops other sites from posting to localhost
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return void res.writeHead(403).end();
  if (req.method === "GET" && req.url === "/") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }).end(PAGE);
  if (req.headers["x-token"] !== token) return void res.writeHead(403).end();
  if (req.method === "GET" && req.url === "/items") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await queue()));
  if (req.method === "POST" && req.url === "/label") {
    let body = "";
    for await (const c of req) if ((body += c).length > 4096) return void res.writeHead(413).end();
    let b: any;
    try {
      b = JSON.parse(body);
    } catch {
      return void res.writeHead(400).end();
    }
    if (!b || typeof b.key !== "string" || !["real", "not", "unsure"].includes(b.label) || typeof b.set !== "string") return void res.writeHead(400).end();
    const l: Label = { key: b.key, label: b.label, by: by!, at: new Date().toISOString(), set: b.set };
    await mkdir(dirname(LABELS), { recursive: true });
    await appendFile(LABELS, JSON.stringify(l) + "\n");
    return void res.writeHead(204).end();
  }
  res.writeHead(404).end();
});
server.listen(port, "127.0.0.1", async () => console.log(`${(await queue()).length} places to label → http://127.0.0.1:${port}`));
