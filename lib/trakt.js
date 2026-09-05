// Pure, network-free logic around Trakt API responses - separated from
// server.js so it's testable without a real HTTP call, a real client ID,
// or real OAuth tokens.

/**
 * Extracts a Set of IMDb IDs from a page of `/sync/watched/movies` results.
 * Each item looks like: { movie: { ids: { imdb: "tt0133093", ... }, ... }, plays, last_watched_at, ... }
 * Items without an IMDb ID are skipped (can't be matched against our catalog,
 * which is keyed off IMDb IDs fetched via OMDb).
 */
export function extractWatchedImdbIds(items) {
  const ids = new Set();
  for (const item of items || []) {
    const imdb = item?.movie?.ids?.imdb;
    if (imdb) ids.add(imdb);
  }
  return ids;
}

/** True if a device-token poll response means "keep polling, not authorized yet". */
export function isDeviceAuthorizationPending(httpStatus) {
  return httpStatus === 400;
}

/** True if a device-token poll response means the flow is over and won't succeed - stop polling. */
export function isDeviceAuthorizationTerminal(httpStatus) {
  return [404, 409, 410, 418].includes(httpStatus);
}

/** True if a device-token poll response means "slow down" (Trakt asked for a longer interval). */
export function isDeviceAuthorizationSlowDown(httpStatus) {
  return httpStatus === 429;
}

/** True if an authenticated Trakt API response indicates the token itself is invalid/expired. */
export function isTraktAuthError(httpStatus) {
  return httpStatus === 401 || httpStatus === 403;
}

/**
 * True if a stored access token is due for a refresh - deliberately refreshes
 * a bit *before* actual expiry (default: 1 day of headroom) so a sync in
 * progress doesn't get interrupted mid-run by an expiring token.
 */
export function isTokenDueForRefresh(expiresAtIso, now = Date.now(), headroomMs = 24 * 60 * 60 * 1000) {
  if (!expiresAtIso) return true;
  const expiresAt = new Date(expiresAtIso).getTime();
  if (Number.isNaN(expiresAt)) return true;
  return now >= expiresAt - headroomMs;
}
