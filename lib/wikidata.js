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

/**
 * True if a non-OK response from the SPARQL endpoint is worth retrying
 * shortly rather than treating as a lasting failure.
 *
 * 429 matters most here: WDQS enforces a per-client query budget, and a
 * catalog-sized first run (several hundred ids, several batches, two
 * scrapers asking one after the other) is exactly the shape of traffic that
 * runs into it. That is a "wait a moment", not a "this endpoint is gone" -
 * treating the two alike is what turns one throttled batch into a source
 * that reports itself unreachable for half an hour.
 */
export function isWikidataRetryable(httpStatus) {
  if (httpStatus === 429 || httpStatus === 408) return true;
  return httpStatus >= 500 && httpStatus <= 599;
}

/**
 * Reads a `Retry-After` header - either delta-seconds ("60") or an HTTP
 * date - into milliseconds from `nowMs`. Returns null when absent or
 * unparseable, and clamps to a sane range so a hostile or broken value
 * can't pin a source down for days (or make it retry instantly).
 */
export function parseRetryAfterMs(headerValue, nowMs = Date.now()) {
  if (headerValue === null || headerValue === undefined) return null;
  const raw = String(headerValue).trim();
  if (!raw) return null;

  let ms;
  if (/^\d+$/.test(raw)) {
    ms = parseInt(raw, 10) * 1000;
  } else {
    const date = new Date(raw).getTime();
    if (Number.isNaN(date)) return null;
    ms = date - nowMs;
  }
  if (!Number.isFinite(ms)) return null;

  const MIN_MS = 60 * 1000; // never hammer, whatever the header says
  const MAX_MS = 6 * 3600 * 1000;
  if (ms <= 0) return MIN_MS;
  return Math.min(Math.max(ms, MIN_MS), MAX_MS);
}
