// Pure, network-free logic around OMDb responses - deliberately separated
// from server.js so it's testable without a real HTTP call and without an
// API key.

export class OmdbLimitError extends Error {}

/**
 * Detects whether an OMDb response signals an exhausted daily limit. OMDb
 * usually reports this via HTTP 401 and/or an Error text like
 * "Request limit reached!".
 */
export function isOmdbLimitResponse(httpStatus, data) {
  if (data && typeof data.Error === "string" && /limit/i.test(data.Error)) return true;
  if (httpStatus === 401) return true;
  return false;
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
