// For tests written before 24 Nov: the setting classifier's own view. Model ids
// that were dropped then (outside a setting position, weak candidates with no provider in the repo, data files of many
// ids) are now reported as catalog entries in the "also" tier; these tests check what counts as a setting, so they
// see the scan without those. test/report-where-it-exists.test.ts covers the catalog entries themselves.
import { scanRepo as scanAll } from "../../src/scan/index.js";

export const NEW_CATALOG = /^(?:a model id outside a request or setting|a model id with no request to its provider|one of \d+ model ids in a data file)/;
export async function scanRepo(...a: Parameters<typeof scanAll>): ReturnType<typeof scanAll> {
  const m = await scanAll(...a);
  return { ...m, usages: m.usages.filter((u) => !(u.context === "catalog" && NEW_CATALOG.test(u.contextReason ?? ""))) };
}
