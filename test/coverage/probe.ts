import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { scanRepo } from "../../src/scan/index.js";
import type { Cell } from "./cells.js";

/** What the API module finds for a cell: the op, the param on that op, the version */
export async function probe(cell: Cell): Promise<{ op?: boolean; param?: boolean; version?: boolean }> {
  const d = await mkdtemp(join(tmpdir(), "vitasta-cell-"));
  for (const [f, t] of Object.entries(cell.files)) {
    await mkdir(dirname(join(d, f)), { recursive: true });
    await writeFile(join(d, f), t);
  }
  // API-shaped findings (versions, operations, params), whichever module: an AI provider's version header is one too
  // Op and param cells look at every call (an AI provider's call carries its model too); version cells at non-model places
  const us = (await scanRepo(d)).usages.filter((u) => (!u.model || !!cell.want.op) && (!cell.want.file || u.file === cell.want.file));
  const w = cell.want;
  return {
    ...(w.op ? { op: us.some((u) => u.op === w.op) } : {}),
    ...(w.param ? { param: us.some((u) => u.op === w.op && u.params?.includes(w.param!)) } : {}),
    // A version counts when it would fail a check (a catalog or a comment doesn't)
    ...(w.version ? { version: us.some((u) => u.apiVersion?.endsWith(w.version!) && u.role === "breaks") } : {}),
  };
}
