import { test } from "node:test";
import assert from "node:assert/strict";
import { parseReleaseYear, extractMovieDetails, needsDetailsFetch } from "../lib/tmdb.js";

test("parseReleaseYear: takes the year off a TMDb release date", () => {
  assert.equal(parseReleaseYear("1999-03-30"), "1999");
  assert.equal(parseReleaseYear("2026-01-01"), "2026");
});

test("parseReleaseYear: missing or malformed dates become 'unknown', never a partial string", () => {
  assert.equal(parseReleaseYear(""), "unknown");
  assert.equal(parseReleaseYear(null), "unknown");
  assert.equal(parseReleaseYear(undefined), "unknown");
  assert.equal(parseReleaseYear("n/a"), "unknown");
  assert.equal(parseReleaseYear("19"), "unknown");
});

test("extractMovieDetails: reads the IMDb id and the primary release year", () => {
  const details = extractMovieDetails({ imdb_id: "tt0133093", release_date: "1999-03-30", title: "The Matrix" });
  assert.deepEqual(details, { imdbId: "tt0133093", releaseYear: "1999" });
});

test("extractMovieDetails: a movie without an IMDb id or date degrades cleanly", () => {
  assert.deepEqual(extractMovieDetails({ imdb_id: "", release_date: "" }), { imdbId: null, releaseYear: "unknown" });
  assert.deepEqual(extractMovieDetails({}), { imdbId: null, releaseYear: "unknown" });
  assert.deepEqual(extractMovieDetails(null), { imdbId: null, releaseYear: "unknown" });
});

test("needsDetailsFetch: true until the movie has actually been fetched", () => {
  assert.equal(needsDetailsFetch(undefined), true, "never looked up");
  assert.equal(needsDetailsFetch({ imdbId: "tt1", releaseYear: null }), true, "migrated from the id-only cache");
  assert.equal(needsDetailsFetch({ imdbId: "tt1", releaseYear: "1999", detailsCheckedAt: "2026-09-07T00:00:00.000Z" }), false);
});

test("needsDetailsFetch: a fetched movie with no IMDb id isn't looked up forever", () => {
  assert.equal(needsDetailsFetch({ imdbId: null, releaseYear: "1999", detailsCheckedAt: "2026-09-07T00:00:00.000Z" }), false);
});
