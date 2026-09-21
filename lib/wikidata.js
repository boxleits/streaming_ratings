// Pure, network-free logic for the Wikidata half of the two scrapers'
// lookups: Wikidata is used purely as an IMDb-id -> site-slug *mapping*
// table (property P1258 for Rotten Tomatoes, P1712 for Metacritic), because
// both sites' URLs are slug-based and there's no way to derive that slug
// from an IMDb id reliably (title normalization guesses break on remakes,
// re-releases, punctuation and disambiguation suffixes).
//
// Deliberately batched: one SPARQL query resolves hundreds of ids at once,
// so this step never becomes a per-movie request the way the page fetches
// themselves have to be.

/** Wikidata entity/property ids used below, named so the queries stay readable. */
const P_IMDB_ID = "P345";
const P_ROTTEN_TOMATOES_ID = "P1258";
const P_METACRITIC_ID = "P1712";

/**
 * Builds a SPARQL query resolving a batch of IMDb ids to the ids held under
 * one property. Ids are filtered to the strict `tt<digits>` form first -
 * they're interpolated into the query, so anything else is dropped rather
 * than escaped, which keeps the query injection-proof by construction (an id
 * can never contain a quote or brace to break out with).
 */
function buildIdQuery(imdbIds, property) {
  const safeIds = [...new Set(imdbIds || [])].filter((id) => /^tt\d+$/.test(id));
  if (safeIds.length === 0) return null;
  const values = safeIds.map((id) => `"${id}"`).join(" ");
  return `SELECT ?imdb ?siteId WHERE {
  VALUES ?imdb { ${values} }
  ?item wdt:${P_IMDB_ID} ?imdb ;
        wdt:${property} ?siteId .
}`;
}

/**
 * Turns a SPARQL JSON result (the W3C `results.bindings` shape) into a plain
 * `{ imdbId: siteId }` map, keeping only ids under `prefix`. Tolerates a
 * missing/short-circuited response instead of throwing - a failed mapping
 * lookup must never take the rating engine down with it.
 */
function parseIdBindings(sparqlJson, prefix) {
  const map = {};
  const bindings = sparqlJson?.results?.bindings;
  if (!Array.isArray(bindings)) return map;
  for (const row of bindings) {
    const imdb = row?.imdb?.value;
    // ?siteId is the current variable name; ?rtId is what this query used to
    // bind, kept readable here so a response captured either way still parses.
    const siteId = row?.siteId?.value ?? row?.rtId?.value;
    if (!imdb || !siteId) continue;
    if (!siteId.startsWith(prefix)) continue;
    // Wikidata can carry several statements for one film (e.g. a legacy and
    // a current slug). First one wins - they're equivalent often enough,
    // and a wrong guess just yields a 404 that's handled as "no score".
    if (!map[imdb]) map[imdb] = siteId;
  }
  return map;
}

/** IMDb ids -> Rotten Tomatoes ids (P1258). */
export function buildRtIdQuery(imdbIds) {
  return buildIdQuery(imdbIds, P_ROTTEN_TOMATOES_ID);
}

/**
 * Only `m/...` (movie) ids are kept: P1258 also holds `tv/...` ids for
 * series, which would resolve to a page with no tomatometer for a movie
 * catalog.
 */
export function parseRtIdBindings(sparqlJson) {
  return parseIdBindings(sparqlJson, "m/");
}

/** IMDb ids -> Metacritic ids (P1712). */
export function buildMetacriticIdQuery(imdbIds) {
  return buildIdQuery(imdbIds, P_METACRITIC_ID);
}

/**
 * Only `movie/...` ids are kept: P1712 also holds `game/...`, `tv/...` and
 * `music/...` ids, whose pages carry a Metascore for something that isn't
 * the film we asked about.
 */
export function parseMetacriticIdBindings(sparqlJson) {
  return parseIdBindings(sparqlJson, "movie/");
}
