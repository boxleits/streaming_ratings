// Pure, network-free parsing of a metacritic.com movie page.
//
// Like lib/rottentomatoes.js - and for the same reason - this is a SCRAPER,
// not an API: Metacritic has no public one, and OMDb (which does) hands out
// only 1000 requests a day, which is what this source exists to get around.
// So the same rules apply: every strategy below is attempted in turn, and if
// all of them come up empty the caller gets `null`, which the engine treats
// as "no Metascore on file" rather than as an error. When Metacritic next
// changes its markup, the symptom should be missing scores, never a crashed
// engine.
//
// The one trap specific to Metacritic: a movie page shows TWO scores, the
// critics' Metascore (0-100, an integer) and the user score (0-10, with a
// decimal). Only the first is what the "Meta" column means, so every
// strategy below is written to identify the critics' score specifically and
// to reject anything that looks like a user score, rather than taking the
// first number it finds.

/** Wikidata's P1712 gives ids like "movie/the-matrix"; both that and a bare slug are accepted. */
export function buildMetacriticUrl(metacriticId) {
  if (!metacriticId) return null;
  const id = String(metacriticId).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!id) return null;
  return `https://www.metacritic.com/${id}/`;
}

/**
 * For a NON-OK response from a Metacritic page: true if it means "ask again
 * later" (throttling, a block, an outage) rather than "there is no such
 * page". Same distinction as for RT: a transient failure must not be
 * recorded as "checked, no score available", which would stick until the
 * refresh TTL expires.
 */
export function isMetacriticTransientFailure(httpStatus) {
  return httpStatus !== 404;
}

/**
 * Coerces "73", 73 or " 73 " into a 0-100 integer, or null.
 *
 * Deliberately strict where lib/rottentomatoes.js's parseScoreValue is
 * permissive: a value carrying a decimal point ("7.3") is the USER score,
 * not the Metascore, and must be rejected rather than truncated to 7.
 */
export function parseMetascoreValue(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const value = parseInt(text, 10);
  if (Number.isNaN(value) || value < 0 || value > 100) return null;
  return value;
}

/** Strategy 1: the `__NEXT_DATA__` blob current (Fandom-era) Metacritic pages embed. */
function fromNextDataJson(html) {
  const match = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    return null; // malformed/partial blob - fall through to the next strategy
  }
  // The item sits at a path that has moved between releases, so search the
  // tree for the critics' score container instead of hard-coding a path.
  return findCriticScoreInTree(data);
}

/**
 * Walks a parsed JSON tree for the critics' score. Accepts only keys that
 * name the critics' score explicitly (`criticScoreSummary`, `metaScore`,
 * `metascore`), never a generic `score`, so the user score sitting one
 * object away can't be picked up by mistake.
 */
function findCriticScoreInTree(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return null;

  for (const [key, value] of Object.entries(node)) {
    const lower = key.toLowerCase();
    if (lower === "criticscoresummary" && value && typeof value === "object") {
      const score = parseMetascoreValue(value.score ?? value.metaScore ?? value.value);
      if (score !== null) return score;
    }
    if (lower === "metascore") {
      const score = parseMetascoreValue(typeof value === "object" && value ? value.score ?? value.value : value);
      if (score !== null) return score;
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      const found = findCriticScoreInTree(value, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Strategy 2: a `title="Metascore 73"`-style attribute, which the score badge carries. */
function fromMetascoreTitleAttribute(html) {
  const match = html.match(/title="\s*Metascore\s*:?\s*(\d{1,3})\s*"/i);
  return match ? parseMetascoreValue(match[1]) : null;
}

/**
 * Strategy 3: the `c-siteReviewScore` badge markup. The page carries one per
 * score, so only an INTEGER value is accepted - the user score badge right
 * below it holds a decimal ("7.3") and is skipped by that alone.
 */
function fromSiteReviewScoreBadge(html) {
  const re = /<div[^>]*class="[^"]*c-siteReviewScore[^"]*"[^>]*>\s*<span[^>]*>\s*([^<]*?)\s*<\/span>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const score = parseMetascoreValue(match[1]);
    if (score !== null) return score;
  }
  return null;
}

/** Strategy 4: the pre-2022 markup, `<div class="metascore_w ...">73</div>`. */
function fromLegacyMetascoreSpan(html) {
  const match = html.match(/<(?:div|span)[^>]*class="[^"]*metascore_w[^"]*"[^>]*>\s*(\d{1,3})\s*</i);
  return match ? parseMetascoreValue(match[1]) : null;
}

/**
 * Strategy 5: JSON-LD `aggregateRating`, accepted ONLY when it declares
 * `bestRating: 100`. That check is what makes it safe: the user-score
 * variant of the same block declares `bestRating: 10`, so a page exposing
 * only that one yields null here instead of a 7 masquerading as a Metascore.
 */
function fromJsonLdAggregateRating(html) {
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    let data;
    try {
      data = JSON.parse(match[1]);
    } catch (err) {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    for (const candidate of candidates) {
      const rating = candidate?.aggregateRating;
      if (!rating) continue;
      if (parseMetascoreValue(rating.bestRating) !== 100) continue;
      const score = parseMetascoreValue(rating.ratingValue);
      if (score !== null) return score;
    }
  }
  return null;
}

/**
 * Extracts the critics' Metascore from a Metacritic movie page, or null when
 * nothing matched - deliberately not an exception, see the file header.
 */
export function parseMetacriticPage(html) {
  if (!html || typeof html !== "string") return null;

  for (const strategy of [
    fromNextDataJson,
    fromMetascoreTitleAttribute,
    fromJsonLdAggregateRating,
    fromSiteReviewScoreBadge,
    fromLegacyMetascoreSpan,
  ]) {
    const score = strategy(html);
    if (score !== null && score !== undefined) return score;
  }
  return null;
}
