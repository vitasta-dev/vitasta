import { describe, expect, it } from "vitest";
import { statusOf, verbOf, whenOf } from "../src/feed/dates.js";
import { findImpacts } from "../src/feed/match.js";
import type { ApiMap, ChangeRecord } from "../src/types.js";

const rec = (extra: Partial<ChangeRecord>): ChangeRecord => ({
  id: "r", provider: "openai", type: "model_retirement", title: "t", selector: { models: ["m"] }, effective: "2026-11-30", trigger: "date", sources: [{ url: "https://example.com", checked: "2026-11-18" }], ...extra,
});
// Azure gpt-chat-latest as Microsoft's page lists it (read 18 Nov 2026)
const chatLatest = rec({
  selector: { models: ["gpt-chat-latest"], hosts: ["azure"] },
  effective: "2026-11-17",
  modelVersions: [
    { version: "2026-05-05", effective: "2026-11-17" }, { version: "2026-06-24", effective: "2026-11-17" },
    { version: "2026-05-28", effective: "2026-12-08" }, { version: "2026-08-06", effective: "2027-01-12" }, { version: "2026-10-07", effective: "2027-05-18" },
  ],
});

describe("what a date means", () => {
  it("versions on different dates: partly retired, not broken, until the last one", () => {
    expect(statusOf(chatLatest, "2026-11-18", 30).status).toBe("urgent");
    expect(verbOf(chatLatest, "2026-11-18")).toBe("is partly retired (some versions)");
    expect(whenOf(chatLatest, "2026-11-18")).toBe("versions 2026-05-05 and 2026-06-24 retired on 2026-11-17; other versions run until 2027-05-18 at the latest (181 days). Check which version your deployment uses");
    // The last version's day itself is "retires today", a warning; broken only from the next day
    expect(statusOf(chatLatest, "2027-05-18", 30).status).toBe("urgent");
    expect(statusOf(chatLatest, "2027-05-19", 30).status).toBe("broken");
    expect(verbOf(chatLatest, "2027-05-19")).toBe("is retired");
    expect(whenOf(chatLatest, "2027-05-19")).toBe("since 2027-05-18 (1 day ago)");
    // Before any version goes: the next date, and when all are gone
    expect(statusOf(chatLatest, "2026-09-01", 30).status).toBe("upcoming");
    expect(whenOf(chatLatest, "2026-09-01")).toBe("on 2026-11-17 (77 days left); all versions by 2027-05-18");
  });

  it("shutdown, earliest, auto-route and read-only", () => {
    expect([statusOf(rec({}), "2026-12-01", 30).status, verbOf(rec({}), "2026-12-01")]).toEqual(["broken", "is retired"]);
    expect([statusOf(rec({}), "2026-11-18", 30).status, verbOf(rec({}), "2026-11-18")]).toEqual(["urgent", "is being retired"]);
    const early = rec({ earliest: true });
    expect([statusOf(early, "2026-12-01", 30).status, verbOf(early, "2026-12-01")]).toEqual(["urgent", "can be retired"]);
    expect(whenOf(early, "2026-11-18")).toBe("not before 2026-11-30 (12 days left at the earliest)");
    const route = rec({ dateKind: "auto-route", routesTo: "gpt-5.1" });
    expect(verbOf(route, "2026-11-18")).toBe("will silently change to gpt-5.1");
    expect(whenOf(route, "2026-11-18")).toBe("on 2026-11-30 (12 days left), calls start going to gpt-5.1 without any change on your side");
    expect([statusOf(route, "2026-12-05", 30).status, verbOf(route, "2026-12-05")]).toEqual(["urgent", "now runs as gpt-5.1"]);
    const ro = rec({ type: "endpoint_shutdown", dateKind: "read-only", selector: { ops: ["POST /v1/evals"] } });
    expect([statusOf(ro, "2026-12-05", 30).status, verbOf(ro, "2026-12-05")]).toEqual(["broken", "is read-only"]);
    expect(whenOf(ro, "2026-11-18")).toBe("on 2026-11-30 (12 days left), creating and changing stop");
  });

  it("the matcher uses it: Azure gpt-chat-latest in code is a warning, not broken", () => {
    const map: ApiMap = { root: "/r", scannedAt: "2026-11-18T00:00:00Z", filesScanned: 1, sdks: [], usages: [{ provider: "openai", kind: "sdk", lang: "py", file: "a.py", line: 3, model: "gpt-chat-latest", host: "azure", confidence: "certain", snippet: "" }] };
    expect(findImpacts(map, [chatLatest], "2026-11-18").map((f) => f.status)).toEqual(["urgent"]);
  });

  it("one clock (UTC), the day itself is 'today', and titles never state a firm date for an earliest one", async () => {
    const { todayUtc, shortWhenOf } = await import("../src/feed/dates.js");
    // 20:00 on 29 Nov in New York is already 30 Nov in UTC; 00:30 on 1 Dec in India is still 30 Nov in UTC
    expect(todayUtc(new Date("2026-11-29T20:00:00-05:00"))).toBe("2026-11-30");
    expect(todayUtc(new Date("2026-12-01T00:30:00+05:30"))).toBe("2026-11-30");
    expect([statusOf(rec({}), "2026-11-30", 30).status, verbOf(rec({}), "2026-11-30"), whenOf(rec({}), "2026-11-30")]).toEqual(["urgent", "is being retired", "today (2026-11-30)"]);
    expect(shortWhenOf(rec({}), "2026-11-18")).toBe("retires 2026-11-30");
    expect(shortWhenOf(rec({}), "2026-11-30")).toBe("retires today");
    expect(shortWhenOf(rec({}), "2026-12-01")).toBe("retired");
    expect(shortWhenOf(rec({ earliest: true }), "2026-11-18")).toBe("may retire from 2026-11-30");
    expect(shortWhenOf(rec({ earliest: true }), "2026-12-05")).toBe("may retire any day");
    expect(shortWhenOf(chatLatest, "2026-11-18")).toBe("some versions retired; all by 2027-05-18");
    expect(shortWhenOf(rec({ dateKind: "auto-route", routesTo: "gpt-5.1" }), "2026-11-18")).toBe("switches to gpt-5.1 on 2026-11-30");
  });
});
