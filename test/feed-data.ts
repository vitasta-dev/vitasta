/**
 * Where tests read the feed. The feed is a separate, private repo, and it changes every day, so tests never read the
 * live feed:
 *
 *  - TEST_FEED: a frozen copy (test/feed-snapshot, the feed's data/*.json at a known commit). Tests that need feed
 *    records use it, so a daily refresh can't break them. It isn't in the public export, and there these tests skip.
 *    Refresh it on purpose (scripts/refresh-test-feed.sh) and review what moved.
 *  - LIVE_FEED: $VITASTA_FEED_DATA, else the sibling ../feed checkout. Only the drift report (test/feed-drift.test.ts)
 *    reads it, and only when VITASTA_FEED_DRIFT=1; CI runs it as a step that can't fail the build.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const TEST_FEED = resolve(import.meta.dirname, "feed-snapshot");
export const haveTestFeed = existsSync(resolve(TEST_FEED, "azure.json"));

export const LIVE_FEED = process.env.VITASTA_FEED_DATA ?? resolve(import.meta.dirname, "../../feed/data");
export const haveLiveFeed = existsSync(resolve(LIVE_FEED, "azure.json"));
