// Source-agnostic rating logic, shared by every secondary data source.
//
// The app has ONE primary source (TMDb: which movies exist, and their IMDb
// ids) and SEVERAL independent secondary sources that annotate those movies
// with ratings - currently the Rotten Tomatoes scraper (tomatometer), the
// Metacritic scraper (Metascore) and OMDb, which supplies both figures
// second-hand for whatever the scrapers didn't resolve. The secondaries are
// deliberately peers: each keeps its own cache, its own refresh interval,
// its own status and its own manual trigger, and none of them can block,
// stall or invalidate another. This module holds the parts that are
// identical for all of them - scheduling (what's due for a check) and the
// merge into a single view - so no source has to know about the others.
//
// Every secondary's cache entry shares this minimal shape:
//   { checkedAt: isoString | null, needsRefresh?: boolean, ...source fields }
// `checkedAt` being falsy means "never checked" (a coverage gap);
// `needsRefresh` means "checked before, now stale" (a background nicety).

/**
 * True if a previously checked value is old enough to need re-checking.
 * A falsy `checkedAtIso` (never checked) is deliberately NOT "stale" - that's
 * a first-time gap, a different priority tier (see splitPendingIds).
 */
export function isRatingStale(checkedAtIso, now, refreshIntervalMs) {
  if (!checkedAtIso) return false;
  const checkedAt = new Date(checkedAtIso).getTime();
  if (Number.isNaN(checkedAt)) return true;
  return now - checkedAt >= refreshIntervalMs;
}

/**
 * Splits a source's entries into its two work tiers: `neverChecked` (a real
 * coverage gap) and `dueForRefresh` (a value exists, it's just old). Callers
 * process the former first, so a constrained source (a daily quota, a
 * politeness delay) spends its budget filling gaps before re-confirming
 * values the UI is already showing.
 */
export function splitPendingIds(entries) {
  const neverChecked = [];
  const dueForRefresh = [];
  for (const [id, entry] of Object.entries(entries || {})) {
    if (!entry) continue;
    if (!entry.checkedAt) neverChecked.push(id);
    else if (entry.needsRefresh) dueForRefresh.push(id);
  }
  return { neverChecked, dueForRefresh };
}

/** The ids from splitPendingIds in processing order: gaps first, refreshes after. */
export function selectPendingIds(entries) {
  const { neverChecked, dueForRefresh } = splitPendingIds(entries);
  return [...neverChecked, ...dueForRefresh];
}

/**
 * Marks entries whose value has aged past `refreshIntervalMs`. Deliberately
 * does NOT clear the stored value: the table keeps showing the last known
 * rating until a fresh one replaces it, instead of regressing to "TODO" for
 * however long the source takes to come back around.
 *
 * Returns how many entries changed, so the caller can decide whether to
 * persist.
 */
export function markStale(entries, now, refreshIntervalMs) {
  let changed = 0;
  for (const entry of Object.values(entries || {})) {
    if (!entry || entry.needsRefresh) continue;
    if (isRatingStale(entry.checkedAt, now, refreshIntervalMs)) {
      entry.needsRefresh = true;
      changed++;
    }
  }
  return changed;
}

/**
 * Merges the independent sources into the single pair of values the table
 * shows. Each scraper wins its OWN column whenever it has actually been
 * checked - it reads the score off the site itself, whereas OMDb's copy is
 * second-hand and missing for many titles - but a movie a scraper hasn't
 * reached (or that has no page there) still falls back to OMDb's figure, so
 * enabling a scraper never removes data. With both scrapers enabled, OMDb
 * becomes optional: it fills gaps, nothing depends on it.
 *
 * "TODO" means no source has checked yet; `null` means checked, no rating
 * on file.
 */
export function mergeRatingView(omdbEntry, rtEntry, mcEntry) {
  const omdb = omdbEntry || {};
  const rt = rtEntry || {};
  const mc = mcEntry || {};

  let rtValue;
  if (rt.checkedAt) rtValue = rt.tomatometer ?? omdb.rt ?? null;
  else rtValue = omdb.checkedAt ? omdb.rt : "TODO";

  let metacriticValue;
  if (mc.checkedAt) metacriticValue = mc.metascore ?? omdb.metacritic ?? null;
  else metacriticValue = omdb.checkedAt ? omdb.metacritic : "TODO";

  return {
    rt: rtValue === undefined ? "TODO" : rtValue,
    metacritic: metacriticValue === undefined ? "TODO" : metacriticValue,
    // Per-source timestamps, so the UI can say which source last looked and
    // when, rather than pretending there's one shared "checked" moment.
    rtCheckedAt: rt.checkedAt || null,
    mcCheckedAt: mc.checkedAt || null,
    omdbCheckedAt: omdb.checkedAt || null,
    ratingNeedsRefresh: Boolean(rt.needsRefresh || mc.needsRefresh || omdb.needsRefresh),
  };
}
