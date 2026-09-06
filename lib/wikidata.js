// Pure, network-free logic for the Wikidata half of the Rotten Tomatoes
// lookup: Wikidata is used purely as an IMDb-id -> Rotten Tomatoes-slug
// *mapping* table (property P1258), because rottentomatoes.com URLs are
// slug-based and there's no way to derive that slug from an IMDb id
// reliably (title normalization guesses break on remakes, re-releases,
// punctuation and disambiguation suffixes).
//
// Deliberately batched: one SPARQL query resolves hundreds of ids at once,
// so this step never becomes a per-movie request the way the RT page fetch
// itself has to be.

/** Wikidata entity/property ids used below, named so the query stays readable. */
const P_IMDB_ID = "P345";
const P_ROTTEN_TOMATOES_ID = "P1258";

/**
 * Builds a SPARQL query resolving a batch of IMDb ids to their Rotten
 * Tomatoes ids. Ids are filtered to the strict `tt<digits>` form first -
 * they're interpolated into the query, so anything else is dropped rather
 * than escaped, which keeps the query injection-proof by construction
 * (an id can never contain a quote or brace to break out with).
 */
export function buildRtIdQuery(imdbIds) {
  const safeIds = [...new Set(imdbIds || [])].filter((id) => /^tt\d+$/.test(id));
  if (safeIds.length === 0) return null;
  const values = safeIds.map((id) => `"${id}"`).join(" ");
  return `SELECT ?imdb ?rtId WHERE {
  VALUES ?imdb { ${values} }
  ?item wdt:${P_IMDB_ID} ?imdb ;
        wdt:${P_ROTTEN_TOMATOES_ID} ?rtId .
}`;
}

/**
 * Turns a SPARQL JSON result (the W3C `results.bindings` shape) into a
 * plain `{ imdbId: rtId }` map. Tolerates a missing/short-circuited
 * response instead of throwing - a failed mapping lookup must never take
 * the rating engine down with it.
 *
 * Only `m/...` (movie) ids are kept: P1258 also holds `tv/...` ids for
 * series, which would resolve to a page with no tomatometer for a movie
 * catalog.
 */
export function parseRtIdBindings(sparqlJson) {
  const map = {};
  const bindings = sparqlJson?.results?.bindings;
  if (!Array.isArray(bindings)) return map;
  for (const row of bindings) {
    const imdb = row?.imdb?.value;
    const rtId = row?.rtId?.value;
    if (!imdb || !rtId) continue;
    if (!rtId.startsWith("m/")) continue;
    // Wikidata can carry several statements for one film (e.g. a legacy and
    // a current slug). First one wins - they're equivalent often enough,
    // and a wrong guess just yields a 404 that's handled as "no score".
    if (!map[imdb]) map[imdb] = rtId;
  }
  return map;
}
