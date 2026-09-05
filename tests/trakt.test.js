import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractWatchedImdbIds,
  isDeviceAuthorizationPending,
  isDeviceAuthorizationTerminal,
  isDeviceAuthorizationSlowDown,
  isTraktAuthError,
  isTokenDueForRefresh,
} from "../lib/trakt.js";

test("extractWatchedImdbIds: pulls the IMDb id out of each watched item", () => {
  const items = [
    { movie: { title: "The Matrix", ids: { trakt: 1, imdb: "tt0133093" } }, plays: 3 },
    { movie: { title: "Inception", ids: { trakt: 2, imdb: "tt1375666" } }, plays: 1 },
  ];
  const ids = extractWatchedImdbIds(items);
  assert.equal(ids.size, 2);
  assert.ok(ids.has("tt0133093"));
  assert.ok(ids.has("tt1375666"));
});

test("extractWatchedImdbIds: skips items without an IMDb id instead of throwing", () => {
  const items = [
    { movie: { title: "No IMDb id", ids: { trakt: 3 } } },
    { movie: { title: "Has one", ids: { imdb: "tt0000001" } } },
  ];
  const ids = extractWatchedImdbIds(items);
  assert.deepEqual([...ids], ["tt0000001"]);
});

test("extractWatchedImdbIds: tolerates null/undefined/empty input", () => {
  assert.equal(extractWatchedImdbIds(null).size, 0);
  assert.equal(extractWatchedImdbIds(undefined).size, 0);
  assert.equal(extractWatchedImdbIds([]).size, 0);
});

test("device authorization status classification", () => {
  assert.equal(isDeviceAuthorizationPending(400), true);
  assert.equal(isDeviceAuthorizationPending(200), false);

  assert.equal(isDeviceAuthorizationTerminal(404), true);
  assert.equal(isDeviceAuthorizationTerminal(409), true);
  assert.equal(isDeviceAuthorizationTerminal(410), true);
  assert.equal(isDeviceAuthorizationTerminal(418), true);
  assert.equal(isDeviceAuthorizationTerminal(400), false);
  assert.equal(isDeviceAuthorizationTerminal(200), false);

  assert.equal(isDeviceAuthorizationSlowDown(429), true);
  assert.equal(isDeviceAuthorizationSlowDown(400), false);
});

test("isTraktAuthError: flags 401/403 as an invalid/expired token, nothing else", () => {
  assert.equal(isTraktAuthError(401), true);
  assert.equal(isTraktAuthError(403), true);
  assert.equal(isTraktAuthError(404), false);
  assert.equal(isTraktAuthError(200), false);
});

test("isTokenDueForRefresh: true once within the headroom window before expiry", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();
  const expiresIn2Days = "2026-08-26T12:00:00.000Z";
  const expiresInAnHour = "2026-08-24T13:00:00.000Z";

  assert.equal(isTokenDueForRefresh(expiresIn2Days, now), false, "2 days out, well outside the 1-day headroom");
  assert.equal(isTokenDueForRefresh(expiresInAnHour, now), true, "1 hour out, inside the 1-day headroom");
});

test("isTokenDueForRefresh: true for missing or unparseable expiry (fail safe -> refresh)", () => {
  assert.equal(isTokenDueForRefresh(null), true);
  assert.equal(isTokenDueForRefresh(undefined), true);
  assert.equal(isTokenDueForRefresh("not-a-date"), true);
});

test("isTokenDueForRefresh: custom headroom is respected", () => {
  const now = new Date("2026-08-24T12:00:00.000Z").getTime();
  const expiresIn2Days = "2026-08-26T12:00:00.000Z";
  // With a 3-day headroom, something 2 days out already counts as due.
  assert.equal(isTokenDueForRefresh(expiresIn2Days, now, 3 * 24 * 60 * 60 * 1000), true);
});
