import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMetacriticUrl, parseMetascoreValue, parseMetacriticPage, isMetacriticTransientFailure } from "../lib/metacritic.js";
import { buildMetacriticIdQuery, parseMetacriticIdBindings } from "../lib/wikidata.js";

test("buildMetacriticUrl: builds a page URL from Wikidata's movie/<slug> id form", () => {
  assert.equal(buildMetacriticUrl("movie/the-matrix"), "https://www.metacritic.com/movie/the-matrix/");
  assert.equal(buildMetacriticUrl("/movie/the-matrix/"), "https://www.metacritic.com/movie/the-matrix/");
  assert.equal(buildMetacriticUrl(null), null);
  assert.equal(buildMetacriticUrl(""), null);
});

test("parseMetascoreValue: accepts a plain 0-100 integer", () => {
  assert.equal(parseMetascoreValue("73"), 73);
  assert.equal(parseMetascoreValue(73), 73);
  assert.equal(parseMetascoreValue(" 0 "), 0);
  assert.equal(parseMetascoreValue(100), 100);
});

test("parseMetascoreValue: rejects a decimal - that is the 0-10 USER score, not the Metascore", () => {
  assert.equal(parseMetascoreValue("7.3"), null);
  assert.equal(parseMetascoreValue(7.3), null);
});

test("parseMetascoreValue: rejects non-scores instead of returning NaN/garbage", () => {
  assert.equal(parseMetascoreValue(""), null);
  assert.equal(parseMetascoreValue("tbd"), null);
  assert.equal(parseMetascoreValue(null), null);
  assert.equal(parseMetascoreValue(undefined), null);
  assert.equal(parseMetascoreValue("101"), null, "out of the 0-100 range");
});

test("parseMetacriticPage: reads the critics' score from the __NEXT_DATA__ blob (current markup)", () => {
  const html = `<html><head>
    <script id="__NEXT_DATA__" type="application/json">
      {"props":{"pageProps":{"components":[{"criticScoreSummary":{"score":73,"reviewCount":48},
       "userScoreSummary":{"score":8.1}}]}}}
    </script></head><body></body></html>`;
  assert.equal(parseMetacriticPage(html), 73);
});

test("parseMetacriticPage: a user score sitting next to the critics' score is never mistaken for it", () => {
  // The decisive case for this scraper: both numbers are on every page, and
  // only one of them belongs in the "Meta" column.
  const html = `<script id="__NEXT_DATA__" type="application/json">
      {"props":{"userScoreSummary":{"score":9},"item":{"criticScoreSummary":{"score":41}}}}
    </script>`;
  assert.equal(parseMetacriticPage(html), 41);
});

test("parseMetacriticPage: falls back to the score badge's title attribute", () => {
  const html = `<div class="c-productScoreInfo"><div title="Metascore 88"><span>88</span></div></div>`;
  assert.equal(parseMetacriticPage(html), 88);
});

test("parseMetacriticPage: falls back to JSON-LD, but only where it declares a 0-100 scale", () => {
  const critics = `<script type="application/ld+json">
    {"@type":"Movie","aggregateRating":{"ratingValue":62,"bestRating":100,"ratingCount":30}}
  </script>`;
  assert.equal(parseMetacriticPage(critics), 62);

  const userScoreOnly = `<script type="application/ld+json">
    {"@type":"Movie","aggregateRating":{"ratingValue":6,"bestRating":10,"ratingCount":900}}
  </script>`;
  assert.equal(parseMetacriticPage(userScoreOnly), null, "a 0-10 rating is the user score and must not fill the Meta column");
});

test("parseMetacriticPage: falls back to the c-siteReviewScore badge, taking the integer one", () => {
  const html = `
    <div class="c-siteReviewScore c-siteReviewScore_green"><span>54</span></div>
    <div class="c-siteReviewScore c-siteReviewScore_user"><span>7.8</span></div>`;
  assert.equal(parseMetacriticPage(html), 54);
});

test("parseMetacriticPage: falls back to the pre-2022 metascore_w markup", () => {
  const html = `<div class="metascore_w larger movie positive">67</div><div class="metascore_w user">7.4</div>`;
  assert.equal(parseMetacriticPage(html), 67);
});

test("parseMetacriticPage: a page with no recognizable score fails soft (null, no throw)", () => {
  assert.equal(parseMetacriticPage("<html><body>404 not found</body></html>"), null);
  assert.equal(parseMetacriticPage(""), null);
  assert.equal(parseMetacriticPage(null), null);
});

test("parseMetacriticPage: a malformed __NEXT_DATA__ blob falls through instead of throwing", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">{"truncated":</script>
    <div class="metascore_w">45</div>`;
  assert.equal(parseMetacriticPage(html), 45);
});

test("isMetacriticTransientFailure: only a 404 is a definitive 'no such page'", () => {
  assert.equal(isMetacriticTransientFailure(404), false);
  assert.equal(isMetacriticTransientFailure(403), true, "a block must be retried, not recorded as 'no score'");
  assert.equal(isMetacriticTransientFailure(429), true);
  assert.equal(isMetacriticTransientFailure(500), true);
});

test("buildMetacriticIdQuery: asks Wikidata for P1712, batched into one VALUES clause", () => {
  const query = buildMetacriticIdQuery(["tt0133093", "tt1375666"]);
  assert.match(query, /wdt:P1712/);
  assert.match(query, /VALUES \?imdb \{ "tt0133093" "tt1375666" \}/);
});

test("buildMetacriticIdQuery: drops anything that isn't a strict tt<digits> id (injection-proof by construction)", () => {
  const query = buildMetacriticIdQuery(['tt1 " } INJECTED {', "not-an-id", "tt0133093"]);
  assert.match(query, /VALUES \?imdb \{ "tt0133093" \}/);
  assert.equal(buildMetacriticIdQuery(["nope"]), null);
  assert.equal(buildMetacriticIdQuery([]), null);
  assert.equal(buildMetacriticIdQuery(null), null);
});

test("parseMetacriticIdBindings: keeps movie/ ids and drops game/tv/music ones", () => {
  const sparql = {
    results: {
      bindings: [
        { imdb: { value: "tt0133093" }, siteId: { value: "movie/the-matrix" } },
        { imdb: { value: "tt0944947" }, siteId: { value: "tv/game-of-thrones" } },
        { imdb: { value: "tt1074638" }, siteId: { value: "game/skyfall" } },
      ],
    },
  };
  assert.deepEqual(parseMetacriticIdBindings(sparql), { tt0133093: "movie/the-matrix" });
});

test("parseMetacriticIdBindings: tolerates an empty/short-circuited response instead of throwing", () => {
  assert.deepEqual(parseMetacriticIdBindings(null), {});
  assert.deepEqual(parseMetacriticIdBindings({}), {});
  assert.deepEqual(parseMetacriticIdBindings({ results: { bindings: [] } }), {});
});
