import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
let gcFn;
/** A full collection, where the runtime allows it (V8's --expose-gc set at run time); otherwise nothing */
export function collectGarbage() {
    if (gcFn === undefined) {
        gcFn = null;
        try {
            const g = globalThis.gc;
            if (typeof g === "function")
                gcFn = g;
            else {
                setFlagsFromString("--expose-gc");
                const fn = runInNewContext("gc");
                if (typeof fn === "function")
                    gcFn = fn;
            }
        }
        catch {
            gcFn = null;
        }
    }
    gcFn?.();
}
