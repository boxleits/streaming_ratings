import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOmdbPayload, isOmdbLimitResponse } from "../lib/omdb.js";

test("parseOmdbPayload: reads RT and Metacritic from a normal response", () => {
  const data = {
    Response: "True",
    Metascore: "74",
    Ratings: [
      { Source: "Internet Movie Database", Value: "7.5/10" },
      { Source: "Rotten Tomatoes", Value: "91%" },
      { Source: "Metacritic", Value: "74/100" },
    ],
  };
  const result = parseOmdbPayload(true, data);
  assert.equal(result.rt, 91);
  assert.equal(result.metacritic, 74);
});

test("parseOmdbPayload: RT missing from Ratings array -> null (not 0 or undefined)", () => {
  const data = {
    Response: "True",
    Metascore: "N/A",
    Ratings: [{ Source: "Internet Movie Database", Value: "6.0/10" }],
  };
  const result = parseOmdbPayload(true, data);
  assert.equal(result.rt, null);
  assert.equal(result.metacritic, null);
});

test('parseOmdbPayload: Response="False" (movie not found) -> both null', () => {
  const result = parseOmdbPayload(true, { Response: "False", Error: "Movie not found!" });
  assert.equal(result.rt, null);
  assert.equal(result.metacritic, null);
});

test("parseOmdbPayload: httpOk=false -> both null, even with data present", () => {
  const result = parseOmdbPayload(false, { Response: "True", Metascore: "80", Ratings: [] });
  assert.equal(result.rt, null);
  assert.equal(result.metacritic, null);
});

test("isOmdbLimitResponse: detects daily limit via Error text", () => {
  assert.equal(isOmdbLimitResponse(200, { Response: "False", Error: "Request limit reached!" }), true);
});

test("isOmdbLimitResponse: detects daily limit via HTTP 401", () => {
  assert.equal(isOmdbLimitResponse(401, null), true);
});

test("isOmdbLimitResponse: a normal 'not found' is NOT a limit error", () => {
  assert.equal(isOmdbLimitResponse(200, { Response: "False", Error: "Movie not found!" }), false);
});

test("isOmdbLimitResponse: a normal successful response is not a limit error", () => {
  assert.equal(isOmdbLimitResponse(200, { Response: "True" }), false);
});
