import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

let gcFn: (() => void) | null | undefined;
/** A full collection, where the runtime allows it (V8's --expose-gc set at run time); otherwise nothing */
export function collectGarbage(): void {
  if (gcFn === undefined) {
    gcFn = null;
    try {
      const g = (globalThis as { gc?: () => void }).gc;
      if (typeof g === "function") gcFn = g;
      else {
        setFlagsFromString("--expose-gc");
        const fn = runInNewContext("gc") as unknown;
        if (typeof fn === "function") gcFn = fn as () => void;
      }
    } catch {
      gcFn = null;
    }
  }
  gcFn?.();
}
