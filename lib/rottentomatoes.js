// Pure, network-free parsing of a rottentomatoes.com movie page.
//
// UNLIKE every other data source in this app, this one is a SCRAPER, not a
// documented API - Rotten Tomatoes has no public API any more, so there is
// no stable contract here and no version guarantee. It is therefore built
// to FAIL SOFT on purpose: every strategy below is attempted in turn, and
// if all of them come up empty the caller gets `null` scores, which the
// engine treats exactly like "OMDb has no rating on file" rather than as an
// error. When RT next changes its markup, the symptom should be missing
// ratings, never a crashed engine.
//
// The strategies are ordered newest-markup-first, since that's what a
// current page is most likely to use; the older ones are kept as fallbacks
// because RT has historically rolled markup changes out gradually.

/** Builds the page URL for a Rotten Tomatoes id (the `m/<slug>` form from Wikidata's P1258). */
export function buildRtUrl(rtId) {
  if (!rtId) return null;
  const slug = String(rtId).replace(/^\/+/, "");
  return `https://www.rottentomatoes.com/${slug}`;
}

/**
 * For a NON-OK response from an RT page: true if it means "ask again later"
 * (RT throttling/blocking us, or an outage) rather than "there is no such
 * page". The distinction matters because a transient failure must NOT be
 * recorded as "checked, no rating available" - that would stick until the
 * refresh TTL expires, turning a brief outage into a week of wrong "N/A"s.
 */
export function isRtTransientFailure(httpStatus) {
  return httpStatus !== 404;
}

/** Coerces "93%", "93", 93 or "" into a 0-100 integer, or null if it isn't one. */
export function parseScoreValue(raw) {
  if (raw === null || raw === undefined) return null;
  const match = String(raw).match(/(\d{1,3})/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (Number.isNaN(value) || value < 0 || value > 100) return null;
  return value;
}

/** Strategy 1: the `media-scorecard-json` blob current RT pages embed. */
function fromScorecardJson(html) {
  const match = html.match(/<script[^>]+id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    return null; // malformed/partial blob - fall through to the next strategy
  }
  const tomatometer = parseScoreValue(data?.criticsScore?.score ?? data?.criticsScore?.scorePercent);
  const audienceScore = parseScoreValue(data?.audienceScore?.score ?? data?.audienceScore?.scorePercent);
  if (tomatometer === null && audienceScore === null) return null;
  return { tomatometer, audienceScore };
}

/** Strategy 2: the `<rt-text slot="criticsScore">93%</rt-text>` web-component markup. */
function fromRtTextSlots(html) {
  const pick = (slot) => {
    const re = new RegExp(`<rt-text[^>]+slot="${slot}"[^>]*>([^<]*)<\\/rt-text>`, "i");
    const m = html.match(re);
    return m ? parseScoreValue(m[1]) : null;
  };
  const tomatometer = pick("criticsScore");
  const audienceScore = pick("audienceScore");
  if (tomatometer === null && audienceScore === null) return null;
  return { tomatometer, audienceScore };
}

/** Strategy 3: the older `<score-board tomatometerscore="93" audiencescore="88">` element. */
function fromScoreBoardAttributes(html) {
  const board = html.match(/<score-board[^>]*>/i);
  if (!board) return null;
  const attr = (name) => {
    const m = board[0].match(new RegExp(`${name}="([^"]*)"`, "i"));
    return m ? parseScoreValue(m[1]) : null;
  };
  const tomatometer = attr("tomatometerscore");
  const audienceScore = attr("audiencescore");
  if (tomatometer === null && audienceScore === null) return null;
  return { tomatometer, audienceScore };
}

/** Strategy 4: last resort - the raw `"criticsScore":{"score":93}` shape anywhere in the page's inline state. */
function fromInlineStateJson(html) {
  const critics = html.match(/"criticsScore"\s*:\s*\{[^}]*?"score"\s*:\s*"?(\d{1,3})"?/i);
  const audience = html.match(/"audienceScore"\s*:\s*\{[^}]*?"score"\s*:\s*"?(\d{1,3})"?/i);
  const tomatometer = critics ? parseScoreValue(critics[1]) : null;
  const audienceScore = audience ? parseScoreValue(audience[1]) : null;
  if (tomatometer === null && audienceScore === null) return null;
  return { tomatometer, audienceScore };
}

/**
 * Extracts the tomatometer (critics) and audience score from a Rotten
 * Tomatoes movie page. Returns `{ tomatometer: null, audienceScore: null }`
 * when nothing matched - deliberately not an exception, see the file header.
 */
export function parseRtPage(html) {
  const empty = { tomatometer: null, audienceScore: null };
  if (!html || typeof html !== "string") return empty;

  for (const strategy of [fromScorecardJson, fromRtTextSlots, fromScoreBoardAttributes, fromInlineStateJson]) {
    const result = strategy(html);
    if (result) return { tomatometer: result.tomatometer ?? null, audienceScore: result.audienceScore ?? null };
  }
  return empty;
}
