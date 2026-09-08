// Pure, network-free logic for the primary source (TMDb).

/**
 * Extracts the year from a TMDb release date, or "unknown" when there is
 * none. TMDb dates are ISO-ish ("1999-03-30"), and an unreleased or
 * incompletely catalogued film can carry "" or null.
 */
export function parseReleaseYear(releaseDate) {
  const year = String(releaseDate || "").slice(0, 4);
  return /^\d{4}$/.test(year) ? year : "unknown";
}

/**
 * Pulls the primary-source facts out of a `/movie/{id}` response: the IMDb
 * id (needed by OMDb, the RT slug lookup and Trakt) and the release year.
 *
 * The year deliberately comes from THIS endpoint rather than from
 * `/discover/movie`. Discover's `release_date` is scoped to the request's
 * `region` (`DE` here), so it reports the *German* release - which is why
 * the table could show a different year than themoviedb.org does. The
 * movie-details endpoint returns TMDb's **primary release date**, which is
 * exactly what the website prints in parentheses after the title.
 *
 * Note that the primary release date is not always the earliest date
 * anywhere in the world: a festival premiere can predate it. Matching the
 * website is the goal here, so primary release date is the right field.
 */
export function extractMovieDetails(data) {
  return {
    imdbId: data?.imdb_id || null,
    releaseYear: parseReleaseYear(data?.release_date),
  };
}

/** True if a cached details entry still needs to be fetched from TMDb. */
export function needsDetailsFetch(entry) {
  return !entry || !entry.detailsCheckedAt;
}
