import { test } from "node:test";
import assert from "node:assert/strict";
import { isRatingStale, splitPendingIds, selectPendingIds, markStale, mergeRatingView } from "../lib/ratings.js";

test("isRatingStale: never checked (falsy checkedAt) is not stale - it's a different priority tier", () => {
  assert.equal(isRatingStale(null, Date.now(), 1000), false);
  assert.equal(isRatingStale(undefined, Date.now(), 1000), false);
});

test("isRatingStale: true once the refresh interval has elapsed since the last check", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();
  const checkedTwoHoursAgo = "2026-08-24T10:00:00.000Z";
  const oneHourMs = 60 * 60 * 1000;
  assert.equal(isRatingStale(checkedTwoHoursAgo, now, oneHourMs), true);
  assert.equal(isRatingStale(checkedTwoHoursAgo, now, 3 * oneHourMs), false);
});

test("isRatingStale: unparseable checkedAt fails safe -> stale", () => {
  assert.equal(isRatingStale("not-a-date", Date.now(), 1000), true);
});

test("splitPendingIds: never-checked entries come before stale ones, fresh ones are excluded", () => {
  const entries = {
    // Inserted so the stale one would come first on a plain key scan.
    "1": { tomatometer: 91, checkedAt: "2026-08-01T00:00:00.000Z", needsRefresh: true },
    "2": { tomatometer: null, checkedAt: null },
    "3": { tomatometer: null, checkedAt: null },
    "4": { tomatometer: 50, checkedAt: "2026-08-24T00:00:00.000Z" },
  };
  const { neverChecked, dueForRefresh } = splitPendingIds(entries);
  assert.deepEqual(neverChecked, ["2", "3"]);
  assert.deepEqual(dueForRefresh, ["1"]);
  assert.deepEqual(selectPendingIds(entries), ["2", "3", "1"]);
});

test("splitPendingIds: works unchanged for either source's entry shape", () => {
  const omdbShaped = { "1": { rt: 80, metacritic: 70, checkedAt: null } };
  const rtShaped = { "1": { tomatometer: 80, checkedAt: null } };
  assert.deepEqual(selectPendingIds(omdbShaped), ["1"]);
  assert.deepEqual(selectPendingIds(rtShaped), ["1"]);
});

test("splitPendingIds: tolerates a missing/empty/holey entries map", () => {
  assert.deepEqual(selectPendingIds(null), []);
  assert.deepEqual(selectPendingIds({}), []);
  assert.deepEqual(selectPendingIds({ "1": null }), []);
});

test("markStale: flags aged entries without clearing their stored values", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();
  const entries = {
    "1": { tomatometer: 91, checkedAt: "2026-08-01T00:00:00.000Z" }, // old
    "2": { tomatometer: 50, checkedAt: "2026-08-24T11:00:00.000Z" }, // fresh
    "3": { tomatometer: null, checkedAt: null }, // never checked
  };
  const changed = markStale(entries, now, 24 * 60 * 60 * 1000);
  assert.equal(changed, 1);
  assert.equal(entries["1"].needsRefresh, true);
  assert.equal(entries["1"].tomatometer, 91, "value stays visible until a fresh one replaces it");
  assert.equal(entries["2"].needsRefresh, undefined);
  assert.equal(entries["3"].needsRefresh, undefined, "never-checked is not 'stale'");
});

test("markStale: an already-flagged entry isn't counted twice", () => {
  const entries = { "1": { checkedAt: "2026-08-01T00:00:00.000Z", needsRefresh: true } };
  assert.equal(markStale(entries, new Date("2026-08-24T12:00:00.000Z").getTime(), 1000), 0);
});

test("mergeRatingView: the RT scraper wins the RT column once it has checked", () => {
  const merged = mergeRatingView(
    { rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" },
    { tomatometer: 83, checkedAt: "2026-08-24T00:00:00.000Z" }
  );
  assert.equal(merged.rt, 83);
  assert.equal(merged.metacritic, 65);
  assert.equal(merged.rtCheckedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(merged.omdbCheckedAt, "2026-08-20T00:00:00.000Z");
});

test("mergeRatingView: RT checked but with no score falls back to OMDb's figure", () => {
  const merged = mergeRatingView(
    { rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" },
    { tomatometer: null, checkedAt: "2026-08-24T00:00:00.000Z" }
  );
  assert.equal(merged.rt, 70, "enabling the scraper must never remove data OMDb already had");
});

test("mergeRatingView: RT not checked yet leaves OMDb's value in place", () => {
  const merged = mergeRatingView({ rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" }, { checkedAt: null });
  assert.equal(merged.rt, 70);
});

test("mergeRatingView: neither source checked yet -> TODO, not a false N/A", () => {
  const merged = mergeRatingView({ rt: null, metacritic: null, checkedAt: null }, { tomatometer: null, checkedAt: null });
  assert.equal(merged.rt, "TODO");
  assert.equal(merged.metacritic, "TODO");
});

test("mergeRatingView: RT-only setup (no OMDb entry at all) still shows the tomatometer", () => {
  const merged = mergeRatingView(undefined, { tomatometer: 83, checkedAt: "2026-08-24T00:00:00.000Z" });
  assert.equal(merged.rt, 83);
  assert.equal(merged.metacritic, "TODO", "no OMDb source configured - not checked, rather than 'no rating'");
});

test("mergeRatingView: OMDb checked with no RT figure on file is N/A, not TODO", () => {
  const merged = mergeRatingView({ rt: null, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" }, { checkedAt: null });
  assert.equal(merged.rt, null);
  assert.equal(merged.metacritic, 65);
});

test("mergeRatingView: a refresh pending on either source is reported", () => {
  assert.equal(mergeRatingView({ checkedAt: "x", needsRefresh: true }, { checkedAt: "y" }).ratingNeedsRefresh, true);
  assert.equal(mergeRatingView({ checkedAt: "x" }, { checkedAt: "y", needsRefresh: true }).ratingNeedsRefresh, true);
  assert.equal(mergeRatingView({ checkedAt: "x" }, { checkedAt: "y" }).ratingNeedsRefresh, false);
});

test("mergeRatingView: tolerates both entries being absent", () => {
  const merged = mergeRatingView(undefined, undefined);
  assert.equal(merged.rt, "TODO");
  assert.equal(merged.metacritic, "TODO");
  assert.equal(merged.rtCheckedAt, null);
  assert.equal(merged.omdbCheckedAt, null);
});

test("mergeRatingView: the Metacritic scraper wins the Meta column once it has checked", () => {
  const merged = mergeRatingView(
    { rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" },
    { tomatometer: 83, checkedAt: "2026-08-24T00:00:00.000Z" },
    { metascore: 71, checkedAt: "2026-08-25T00:00:00.000Z" }
  );
  assert.equal(merged.metacritic, 71);
  assert.equal(merged.rt, 83);
  assert.equal(merged.mcCheckedAt, "2026-08-25T00:00:00.000Z");
});

test("mergeRatingView: Metacritic checked but with no score falls back to OMDb's figure", () => {
  const merged = mergeRatingView(
    { rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" },
    { checkedAt: null },
    { metascore: null, checkedAt: "2026-08-25T00:00:00.000Z" }
  );
  assert.equal(merged.metacritic, 65, "enabling the scraper must never remove data OMDb already had");
});

test("mergeRatingView: a genuine Metascore of 0 survives the fallback chain", () => {
  const merged = mergeRatingView(
    { rt: null, metacritic: 40, checkedAt: "2026-08-20T00:00:00.000Z" },
    { checkedAt: null },
    { metascore: 0, checkedAt: "2026-08-25T00:00:00.000Z" }
  );
  assert.equal(merged.metacritic, 0, "0 is a score, not a missing value");
});

test("mergeRatingView: scrapers-only setup (no OMDb at all) fills both columns", () => {
  const merged = mergeRatingView(
    undefined,
    { tomatometer: 83, checkedAt: "2026-08-24T00:00:00.000Z" },
    { metascore: 71, checkedAt: "2026-08-24T00:00:00.000Z" }
  );
  assert.equal(merged.rt, 83);
  assert.equal(merged.metacritic, 71, "this is what makes OMDb optional");
  assert.equal(merged.omdbCheckedAt, null);
});

test("mergeRatingView: Metacritic not checked yet leaves OMDb's value in place", () => {
  const merged = mergeRatingView(
    { rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" },
    { checkedAt: null },
    { metascore: null, checkedAt: null }
  );
  assert.equal(merged.metacritic, 65);
  assert.equal(merged.mcCheckedAt, null);
});

test("mergeRatingView: a refresh pending on the Metacritic source is reported too", () => {
  const merged = mergeRatingView({ checkedAt: "x" }, { checkedAt: "y" }, { checkedAt: "z", needsRefresh: true });
  assert.equal(merged.ratingNeedsRefresh, true);
});

test("mergeRatingView: an omitted Metacritic entry behaves exactly as before the source existed", () => {
  const merged = mergeRatingView({ rt: 70, metacritic: 65, checkedAt: "2026-08-20T00:00:00.000Z" }, { checkedAt: null });
  assert.equal(merged.metacritic, 65);
  assert.equal(merged.mcCheckedAt, null);
});
