// Pure, network-free logic around OMDb responses - deliberately separated
// from server.js so it's testable without a real HTTP call and without an
// API key.

export class OmdbLimitError extends Error {}
export class OmdbAuthError extends Error {}

/**
 * Detects an invalid/revoked OMDb API key. OMDb reports this via HTTP 401
 * with Error text "Invalid API key!" - the *same* HTTP status it uses for an
 * exhausted daily limit, so this must be checked (and excluded) before
 * falling back to isOmdbLimitResponse's generic "401 = limit" assumption,
 * otherwise a bad key gets silently retried forever as if it were a
 * temporary limit that will eventually reset (it won't).
 */
export function isOmdbAuthError(httpStatus, data) {
  return httpStatus === 401 && typeof data?.Error === "string" && /invalid api key/i.test(data.Error);
}

/**
 * Detects whether an OMDb response signals an exhausted daily limit. OMDb
 * usually reports this via HTTP 401 and/or an Error text like
 * "Request limit reached!". Must be checked *after* isOmdbAuthError - both
 * conditions can present as plain HTTP 401.
 */
export function isOmdbLimitResponse(httpStatus, data) {
  if (isOmdbAuthError(httpStatus, data)) return false;
  if (data && typeof data.Error === "string" && /limit/i.test(data.Error)) return true;
  if (httpStatus === 401) return true;
  return false;
}

/**
 * True if a previously checked rating is old enough to need re-checking.
 * `checkedAtIso` being falsy (never checked yet) is deliberately NOT "stale"
 * - that's a first-time gap, a different priority tier from a refresh (see
 * selectPendingOmdbIds below).
 */
export function isRatingStale(checkedAtIso, now, refreshIntervalMs) {
  if (!checkedAtIso) return false;
  const checkedAt = new Date(checkedAtIso).getTime();
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt >= refreshIntervalMs;
}

/**
 * Splits OMDb cache entries due for a check into two priority tiers:
 * `neverChecked` (rt still "TODO" - a genuine first-time gap) and
 * `dueForRefresh` (previously rated, now stale - a nice-to-have background
 * re-check, not a gap in coverage). Keeping the two counts separate lets the
 * engine tell whether a quota-hit still blocks real coverage or only delays
 * an optional refresh of already-known ratings (see server.js's use of this
 * to decide between the "waiting_for_limit_reset" and "stale_refresh_pending"
 * statuses).
 */
export function splitPendingOmdbIds(entries) {
  const neverChecked = [];
  const dueForRefresh = [];
  for (const [id, entry] of Object.entries(entries || {})) {
    if (entry.rt === "TODO") neverChecked.push(id);
    else if (entry.needsRefresh) dueForRefresh.push(id);
  }
  return { neverChecked, dueForRefresh };
}

/**
 * Picks which OMDb cache entries are due for a check, ordered so movies
 * that have NEVER been rated come before ones merely due for a stale
 * refresh - see splitPendingOmdbIds for why the priority is this way
 * around.
 */
export function selectPendingOmdbIds(entries) {
  const { neverChecked, dueForRefresh } = splitPendingOmdbIds(entries);
  return [...neverChecked, ...dueForRefresh];
}

/**
 * Extracts the RT and Metacritic rating from an (already JSON-parsed) OMDb
 * response. Returns `null` for both if OMDb has no rating on file for it,
 * or if the movie wasn't found.
 */
export function parseOmdbPayload(httpOk, data) {
  if (!httpOk || !data || data.Response === "False") {
    return { rt: null, metacritic: null };
  }

  const rtRating = (data.Ratings || []).find((x) => x.Source === "Rotten Tomatoes");
  const rtParsed = rtRating ? parseInt(String(rtRating.Value).replace("%", ""), 10) : NaN;

  const metaRaw = data.Metascore;
  const metaParsed = metaRaw && metaRaw !== "N/A" ? parseInt(metaRaw, 10) : NaN;

  return {
    rt: Number.isNaN(rtParsed) ? null : rtParsed,
    metacritic: Number.isNaN(metaParsed) ? null : metaParsed,
  };
}
