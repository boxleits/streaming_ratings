import { test } from "node:test";
import assert from "node:assert/strict";
import { isWikidataRetryable, parseRetryAfterMs } from "../lib/wikidata.js";

// The query building/parsing for each scraper is tested next to that
// scraper (tests/rottentomatoes.test.js, tests/metacritic.test.js). What
// lives here is the part both share: how to react when the SPARQL endpoint
// itself says no.

test("isWikidataRetryable: 429 is a wait, not a failure - it's the one both scrapers actually hit", () => {
  assert.equal(isWikidataRetryable(429), true);
});

test("isWikidataRetryable: server-side trouble is retryable", () => {
  assert.equal(isWikidataRetryable(500), true);
  assert.equal(isWikidataRetryable(502), true);
  assert.equal(isWikidataRetryable(503), true);
  assert.equal(isWikidataRetryable(408), true);
});

test("isWikidataRetryable: a refusal or a bad query is NOT worth hammering", () => {
  assert.equal(isWikidataRetryable(400), false);
  assert.equal(isWikidataRetryable(403), false);
  assert.equal(isWikidataRetryable(404), false);
});

test("parseRetryAfterMs: reads delta-seconds", () => {
  assert.equal(parseRetryAfterMs("300"), 300_000);
});

test("parseRetryAfterMs: reads an HTTP date, relative to now", () => {
  const now = new Date("2026-09-21T20:00:00.000Z").getTime();
  const ms = parseRetryAfterMs("Mon, 21 Sep 2026 20:05:00 GMT", now);
  assert.equal(ms, 300_000);
});

test("parseRetryAfterMs: absent or unparseable -> null, so the caller uses its own interval", () => {
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(undefined), null);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs("soon"), null);
});

test("parseRetryAfterMs: never returns a value that would hammer the endpoint", () => {
  // A zero/past value is honoured as "you may retry", but not immediately.
  assert.equal(parseRetryAfterMs("0"), 60_000);
  assert.equal(parseRetryAfterMs("5"), 60_000);
  const now = new Date("2026-09-21T20:00:00.000Z").getTime();
  assert.equal(parseRetryAfterMs("Mon, 21 Sep 2026 19:00:00 GMT", now), 60_000);
});

test("parseRetryAfterMs: an absurd value can't pin a source down for days", () => {
  assert.equal(parseRetryAfterMs(String(60 * 60 * 24 * 30)), 6 * 3600 * 1000);
});
