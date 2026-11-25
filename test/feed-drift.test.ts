/**
 * Drift report: the checks the frozen test feed passes, run on the live feed. A new model in the daily refresh shows
 * here first; it never fails the build (CI runs this as a separate step that can't fail, with VITASTA_FEED_DRIFT=1).
 * To act on it: teach the scanner the new IDs (src/data/model-words.json, src/providers.ts), then refresh the test
 * feed (scripts/refresh-test-feed.sh) so the blocking tests cover them too.
 */
import { describe, expect, it } from "vitest";
import { haveLiveFeed, LIVE_FEED } from "./feed-data.js";
import { modelWordGaps, partnerModelGaps } from "./feed-checks.js";

describe.skipIf(process.env.VITASTA_FEED_DRIFT !== "1")(`live feed drift (${LIVE_FEED})`, () => {
  it("there is a live feed", () => expect(haveLiveFeed, `no feed data at ${LIVE_FEED}`).toBe(true));
  it.skipIf(!haveLiveFeed)("every model ID is made of public words", () => expect(modelWordGaps(LIVE_FEED, "all")).toEqual([]));
  it.skipIf(!haveLiveFeed)("every Azure and Bedrock model ID is known, with its provider", () => expect(partnerModelGaps(LIVE_FEED, "all")).toEqual([]));
});
