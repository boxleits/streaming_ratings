import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRtUrl, parseScoreValue, parseRtPage, isRtTransientFailure } from "../lib/rottentomatoes.js";
import { buildRtIdQuery, parseRtIdBindings } from "../lib/wikidata.js";

test("buildRtUrl: builds a page URL from Wikidata's m/<slug> id form", () => {
  assert.equal(buildRtUrl("m/the_matrix"), "https://www.rottentomatoes.com/m/the_matrix");
  assert.equal(buildRtUrl("/m/the_matrix"), "https://www.rottentomatoes.com/m/the_matrix");
  assert.equal(buildRtUrl(null), null);
});

test("parseScoreValue: accepts percent strings, bare numbers and numeric values", () => {
  assert.equal(parseScoreValue("93%"), 93);
  assert.equal(parseScoreValue("93"), 93);
  assert.equal(parseScoreValue(93), 93);
  assert.equal(parseScoreValue(0), 0);
});

test("parseScoreValue: rejects non-scores instead of returning NaN/garbage", () => {
  assert.equal(parseScoreValue(""), null);
  assert.equal(parseScoreValue("N/A"), null);
  assert.equal(parseScoreValue(null), null);
  assert.equal(parseScoreValue(undefined), null);
  assert.equal(parseScoreValue("101"), null, "out of the 0-100 range");
});

test("parseRtPage: reads scores from the media-scorecard-json blob (current markup)", () => {
  const html = `<html><head>
    <script id="media-scorecard-json" type="application/json">
      {"criticsScore":{"score":83,"ratingCount":190},"audienceScore":{"score":85}}
    </script></head><body></body></html>`;
  assert.deepEqual(parseRtPage(html), { tomatometer: 83, audienceScore: 85 });
});

test("parseRtPage: falls back to the rt-text slot markup", () => {
  const html = `<div>
    <rt-text slot="criticsScore" context="label">88%</rt-text>
    <rt-text slot="audienceScore" context="label">72%</rt-text>
  </div>`;
  assert.deepEqual(parseRtPage(html), { tomatometer: 88, audienceScore: 72 });
});

test("parseRtPage: falls back to the older score-board attributes", () => {
  const html = `<score-board tomatometerscore="61" audiencescore="49" tomatometerstate="fresh"></score-board>`;
  assert.deepEqual(parseRtPage(html), { tomatometer: 61, audienceScore: 49 });
});

test("parseRtPage: last-resort inline state JSON is used when no known container matched", () => {
  const html = `<script>window.__DATA__ = {"foo":1,"criticsScore":{"state":"certified","score":95},"audienceScore":{"score":90}}</script>`;
  assert.deepEqual(parseRtPage(html), { tomatometer: 95, audienceScore: 90 });
});

test("parseRtPage: a page with no recognizable score fails soft (nulls, no throw)", () => {
  assert.deepEqual(parseRtPage("<html><body>404 not found</body></html>"), {
    tomatometer: null,
    audienceScore: null,
  });
  assert.deepEqual(parseRtPage(""), { tomatometer: null, audienceScore: null });
  assert.deepEqual(parseRtPage(null), { tomatometer: null, audienceScore: null });
});

test("parseRtPage: a malformed scorecard blob falls through instead of throwing", () => {
  const html = `<script id="media-scorecard-json" type="application/json">{"criticsScore":{"score":7</script>
    <score-board tomatometerscore="77" audiencescore="70"></score-board>`;
  assert.deepEqual(parseRtPage(html), { tomatometer: 77, audienceScore: 70 });
});

test("parseRtPage: a critics-only page still returns the tomatometer", () => {
  const html = `<script id="media-scorecard-json" type="application/json">{"criticsScore":{"score":100},"audienceScore":{}}</script>`;
  assert.deepEqual(parseRtPage(html), { tomatometer: 100, audienceScore: null });
});

test("isRtTransientFailure: a 404 is definitive (no such page), everything else is retryable", () => {
  assert.equal(isRtTransientFailure(404), false, "no page for this slug - a real, cacheable 'no rating'");
  assert.equal(isRtTransientFailure(403), true, "RT blocking us");
  assert.equal(isRtTransientFailure(429), true, "RT throttling us");
  assert.equal(isRtTransientFailure(500), true);
  assert.equal(isRtTransientFailure(503), true);
});

test("buildRtIdQuery: batches many IMDb ids into a single VALUES clause", () => {
  const query = buildRtIdQuery(["tt0133093", "tt1375666"]);
  assert.match(query, /VALUES \?imdb \{ "tt0133093" "tt1375666" \}/);
  assert.match(query, /wdt:P345/);
  assert.match(query, /wdt:P1258/);
});

test("buildRtIdQuery: drops anything that isn't a strict tt<digits> id (injection-proof by construction)", () => {
  const query = buildRtIdQuery(['tt1 " } INJECTED {', "not-an-id", "tt0133093"]);
  assert.match(query, /VALUES \?imdb \{ "tt0133093" \}/);
  assert.doesNotMatch(query, /INJECTED/);
});

test("buildRtIdQuery: de-duplicates ids and returns null when nothing usable is left", () => {
  assert.match(buildRtIdQuery(["tt0133093", "tt0133093"]), /VALUES \?imdb \{ "tt0133093" \}/);
  assert.equal(buildRtIdQuery([]), null);
  assert.equal(buildRtIdQuery(null), null);
  assert.equal(buildRtIdQuery(["nope"]), null);
});

test("parseRtIdBindings: maps IMDb ids to RT ids from a SPARQL result", () => {
  const json = {
    results: {
      bindings: [
        { imdb: { value: "tt0133093" }, rtId: { value: "m/matrix" } },
        { imdb: { value: "tt1375666" }, rtId: { value: "m/inception" } },
      ],
    },
  };
  assert.deepEqual(parseRtIdBindings(json), { tt0133093: "m/matrix", tt1375666: "m/inception" });
});

test("parseRtIdBindings: skips tv/... ids, which have no movie tomatometer page", () => {
  const json = {
    results: { bindings: [{ imdb: { value: "tt0903747" }, rtId: { value: "tv/breaking_bad" } }] },
  };
  assert.deepEqual(parseRtIdBindings(json), {});
});

test("parseRtIdBindings: first statement wins when Wikidata carries several slugs", () => {
  const json = {
    results: {
      bindings: [
        { imdb: { value: "tt0133093" }, rtId: { value: "m/matrix" } },
        { imdb: { value: "tt0133093" }, rtId: { value: "m/the_matrix" } },
      ],
    },
  };
  assert.deepEqual(parseRtIdBindings(json), { tt0133093: "m/matrix" });
});

test("parseRtIdBindings: tolerates an empty/failed/malformed response", () => {
  assert.deepEqual(parseRtIdBindings(null), {});
  assert.deepEqual(parseRtIdBindings({}), {});
  assert.deepEqual(parseRtIdBindings({ results: {} }), {});
  assert.deepEqual(parseRtIdBindings({ results: { bindings: [{}] } }), {});
});
