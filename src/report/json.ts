import { roleFor } from "../scan/roles.js";
import type { ApiMap, Finding } from "../types.js";

/**
 * The --json report. (option a, "Keep them, but as notes"): findings in test files are notes, in their
 * own `alsoInTests` list; `findings` is everything else.
 */
export function jsonReport(map: ApiMap, findings: Finding[]): { map: ApiMap; findings: Finding[]; alsoInTests: Finding[] } {
  const note = (f: Finding) => roleFor(f.usage) === "note";
  return { map, findings: findings.filter((f) => !note(f)), alsoInTests: findings.filter(note) };
}
