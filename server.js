import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { OmdbLimitError, OmdbAuthError, isOmdbLimitResponse, isOmdbAuthError, parseOmdbPayload } from "./lib/omdb.js";
import { splitPendingIds, markStale, mergeRatingView } from "./lib/ratings.js";
import { extractMovieDetails, needsDetailsFetch } from "./lib/tmdb.js";
import { buildRtUrl, parseRtPage, isRtTransientFailure } from "./lib/rottentomatoes.js";
import { buildMetacriticUrl, parseMetacriticPage, isMetacriticTransientFailure } from "./lib/metacritic.js";
import {
  buildRtIdQuery,
  parseRtIdBindings,
  buildMetacriticIdQuery,
  parseMetacriticIdBindings,
  isWikidataRetryable,
  parseRetryAfterMs,
} from "./lib/wikidata.js";
import {
  extractWatchedImdbIds,
  isDeviceAuthorizationPending,
  isDeviceAuthorizationTerminal,
  isDeviceAuthorizationSlowDown,
  isTraktAuthError,
  isTokenDueForRefresh,
} from "./lib/trakt.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const OMDB_API_KEY = process.env.OMDB_API_KEY || "";
const OMDB_REQUEST_DELAY_MS = parseInt(process.env.OMDB_REQUEST_DELAY_MS || "150", 10);
const OMDB_RETRY_INTERVAL_MINUTES = parseFloat(process.env.OMDB_RETRY_INTERVAL_MINUTES || "30");
const TMDB_REFRESH_INTERVAL_HOURS = parseFloat(process.env.TMDB_REFRESH_INTERVAL_HOURS || "24");
// Per-movie detail lookups (IMDb id + primary release year) are throttled and
// batched: TMDb has no daily quota, but a first run over a large catalog
// shouldn't monopolise the engine loop either.
const TMDB_REQUEST_DELAY_MS = parseInt(process.env.TMDB_REQUEST_DELAY_MS || "60", 10);
const TMDB_DETAILS_BATCH_SIZE = parseInt(process.env.TMDB_DETAILS_BATCH_SIZE || "200", 10);
const OMDB_REFRESH_INTERVAL_HOURS = parseFloat(process.env.OMDB_REFRESH_INTERVAL_HOURS || "168");
const ENGINE_IDLE_MS = parseInt(process.env.ENGINE_IDLE_MS || "15000", 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "data");
const PROVIDER_NAME = process.env.PROVIDER_NAME || "Amazon Prime Video";
const DEBUG_MODE = /^(1|true|yes)$/i.test(process.env.DEBUG_MODE || "");

// The two scrapers: OPT-IN and off by default, because unlike every other
// source here they are not documented APIs (neither site has a public one)
// - they read the public movie page and can break whenever that site
// changes its markup. When enabled, each becomes the primary source for its
// own column; OMDb, if still configured, stays on as the fallback for
// anything a scraper couldn't resolve. Enabling BOTH makes OMDb - and with
// it its 1000-requests-a-day limit - optional entirely. See README.
const RT_SCRAPE_ENABLED = /^(1|true|yes)$/i.test(process.env.RT_SCRAPE_ENABLED || "");
const RT_REQUEST_DELAY_MS = parseInt(process.env.RT_REQUEST_DELAY_MS || "1500", 10);
// RT gets its OWN, much shorter staleness interval than OMDb on purpose:
// scraping has no daily quota, so there's no reason to make a fresh
// tomatometer wait out OMDB_REFRESH_INTERVAL_HOURS (a week by default) just
// because Metacritic has to.
const RT_REFRESH_INTERVAL_HOURS = parseFloat(process.env.RT_REFRESH_INTERVAL_HOURS || "24");
// RT's own back-off, separate from OMDB_RETRY_INTERVAL_MINUTES: the two
// sources fail for unrelated reasons (a daily quota vs. a website being
// unreachable) and shouldn't share a knob.
const RT_RETRY_INTERVAL_MINUTES = parseFloat(process.env.RT_RETRY_INTERVAL_MINUTES || "30");
// Sent on every scraper/wikidata.org request. Wikidata requires a
// descriptive one (it 403s generic clients); the scraped sites get the same
// courtesy so the traffic is at least honestly attributable.
const DEFAULT_SCRAPER_USER_AGENT =
  "prime-rt-finder/1.0 (self-hosted personal media dashboard; https://github.com/boxleits/streaming_ratings)";
const RT_USER_AGENT = process.env.RT_USER_AGENT || DEFAULT_SCRAPER_USER_AGENT;

// Metacritic scraping: the same deal as RT above, one column over. This is
// what makes OMDb optional - the Metascore was the last thing only OMDb
// could supply, and therefore the only reason to keep living with its daily
// limit. Every knob is its OWN, not shared with RT's: the two sites fail
// independently and there is no reason a Metacritic outage should change
// how often RT is scraped.
const MC_SCRAPE_ENABLED = /^(1|true|yes)$/i.test(process.env.MC_SCRAPE_ENABLED || "");
const MC_REQUEST_DELAY_MS = parseInt(process.env.MC_REQUEST_DELAY_MS || "1500", 10);
const MC_REFRESH_INTERVAL_HOURS = parseFloat(process.env.MC_REFRESH_INTERVAL_HOURS || "24");
const MC_RETRY_INTERVAL_MINUTES = parseFloat(process.env.MC_RETRY_INTERVAL_MINUTES || "30");
const MC_USER_AGENT = process.env.MC_USER_AGENT || DEFAULT_SCRAPER_USER_AGENT;

// Trakt is entirely optional: a single, server-wide account (not per-user -
// this app has no login system). If unset, the "Watched" column just stays
// "N/A" for everyone and the Trakt status row is hidden client-side.
const TRAKT_CLIENT_ID = process.env.TRAKT_CLIENT_ID || "";
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET || "";
const TRAKT_REFRESH_INTERVAL_HOURS = parseFloat(process.env.TRAKT_REFRESH_INTERVAL_HOURS || "24");
const TRAKT_CONFIGURED = Boolean(TRAKT_CLIENT_ID && TRAKT_CLIENT_SECRET);

// Languages the catalog is fetched in, in parallel, so each connected
// browser can display movie titles/genres in its own chosen UI language
// without a server round-trip. Key = short UI language code (matches
// public/js/i18n.js), value = TMDb locale code.
const SUPPORTED_LANGUAGES = { en: "en-US", de: "de-DE" };

const TMDB_BASE = "https://api.themoviedb.org/3";
const OMDB_BASE = "https://www.omdbapi.com/";
const TRAKT_BASE = "https://api.trakt.tv";
const WIKIDATA_SPARQL_BASE = "https://query.wikidata.org/sparql";
// How many IMDb ids go into one Wikidata SPARQL query. The point of the
// Wikidata step is that it's batched - the RT page fetch itself is
// unavoidably per-movie, but the id mapping needs only a handful of calls
// for an entire catalog.
const WIKIDATA_BATCH_SIZE = 200;
// Wait between consecutive SPARQL queries. query.wikidata.org enforces a
// per-client query budget, and a catalog-sized first run walks through
// several batches back to back - for two scrapers, one after the other. Go
// through it at a deliberate pace rather than finding the limit the hard
// way. (Each mapping is cached permanently, so this delay is paid once per
// catalog, not per refresh.)
const WIKIDATA_REQUEST_DELAY_MS = parseInt(process.env.WIKIDATA_REQUEST_DELAY_MS || "1200", 10);
// The one in-pass retry a single failed query gets. Deliberately short: a
// pass may pause briefly for a hiccup, but anything longer belongs in the
// source's own back-off timestamp, because sleeping inside a pass holds up
// every other source (see omdbPausedUntil/rtPausedUntil/mcPausedUntil).
const WIKIDATA_RETRY_PAUSE_MS = 2000;
const RT_REFRESH_INTERVAL_MS = RT_REFRESH_INTERVAL_HOURS * 3600 * 1000;
const RT_RETRY_INTERVAL_MS = RT_RETRY_INTERVAL_MINUTES * 60 * 1000;
const MC_REFRESH_INTERVAL_MS = MC_REFRESH_INTERVAL_HOURS * 3600 * 1000;
const MC_RETRY_INTERVAL_MS = MC_RETRY_INTERVAL_MINUTES * 60 * 1000;
const TMDB_REFRESH_INTERVAL_MS = TMDB_REFRESH_INTERVAL_HOURS * 3600 * 1000;
const OMDB_REFRESH_INTERVAL_MS = OMDB_REFRESH_INTERVAL_HOURS * 3600 * 1000;
const OMDB_RETRY_INTERVAL_MS = OMDB_RETRY_INTERVAL_MINUTES * 60 * 1000;
const TRAKT_REFRESH_INTERVAL_MS = TRAKT_REFRESH_INTERVAL_HOURS * 3600 * 1000;

const TMDB_CACHE_FILE = path.join(CACHE_DIR, "tmdb-cache.json");
const OMDB_CACHE_FILE = path.join(CACHE_DIR, "omdb-cache.json");
// Kept as two separate files on purpose: trakt-auth.json holds sensitive
// OAuth tokens (treat like a secret - it's already covered by the same
// CACHE_DIR gitignore/dockerignore exclusions as the other caches, but is
// worth calling out specifically). trakt-watched.json is just a list of
// IMDb ids, no more sensitive than the other caches.
const TRAKT_AUTH_FILE = path.join(CACHE_DIR, "trakt-auth.json");
const TRAKT_WATCHED_FILE = path.join(CACHE_DIR, "trakt-watched.json");
// IMDb id -> Rotten Tomatoes slug, resolved via Wikidata. Cached separately
// and permanently: the mapping is a stable fact about a film, so it never
// needs re-resolving even when the score itself is rechecked. A `null` value
// is a remembered "Wikidata has no RT id for this one", so we don't ask
// again on every pass.
const RT_SLUG_CACHE_FILE = path.join(CACHE_DIR, "rt-slug-cache.json");
// One file per source, so each can be inspected, reasoned about or deleted
// on its own - deleting rt-cache.json re-scrapes RT without touching a
// single OMDb request or Metacritic page, and so on for the others.
const RT_CACHE_FILE = path.join(CACHE_DIR, "rt-cache.json");
// The Metacritic pair, mirroring the RT one above: scores, and the
// permanently cached IMDb id -> "movie/<slug>" mapping from Wikidata.
const MC_CACHE_FILE = path.join(CACHE_DIR, "mc-cache.json");
const MC_SLUG_CACHE_FILE = path.join(CACHE_DIR, "mc-slug-cache.json");
// Per-movie primary-source facts from TMDb (IMDb id + primary release year),
// shared by both secondaries and Trakt. Superseded imdb-ids.json, which is
// migrated on startup.
const TMDB_DETAILS_CACHE_FILE = path.join(CACHE_DIR, "tmdb-details.json");
const LEGACY_IMDB_ID_CACHE_FILE = path.join(CACHE_DIR, "imdb-ids.json");

function debugLog(...args) {
  if (!DEBUG_MODE) return;
  console.log(`[DEBUG ${new Date().toISOString()}]`, ...args);
}

function maskUrl(url) {
  return url.replace(/([?&](?:api_key|apikey)=)[^&]+/gi, "$1***");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Allows the engine's idle wait to be interrupted immediately (e.g. when a
// manual sync is triggered via a button) instead of waiting up to
// ENGINE_IDLE_MS.
let wakeResolve = null;
function sleepOrWake(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeResolve = null;
      resolve();
    }, ms);
    wakeResolve = () => {
      clearTimeout(timer);
      wakeResolve = null;
      resolve();
    };
  });
}
function wakeEngine() {
  if (wakeResolve) wakeResolve();
}

// ---------------------------------------------------------------------------
// ONE primary source, several independent secondary ones.
//
//   TMDb (primary)   which movies exist, their titles/years/genres, and
//                    their IMDb ids. Everything else keys off this.
//     |
//     +-- RT   (secondary)  the tomatometer, scraped
//     +-- MC   (secondary)  the Metascore, scraped
//     +-- OMDb (secondary)  both figures second-hand, as a fallback
//
// The secondaries are PEERS, not layers: each owns its own cache file, its
// own refresh interval, its own status row and its own manual trigger, and
// each is processed by its own pass in the engine loop. None can stall,
// block or invalidate another - an exhausted OMDb quota does not hold up
// either scraper, and an unreachable RT does not hold up Metacritic.
// lib/ratings.js holds the parts that are the same for all of them
// (scheduling, staleness, the merge into one view); everything below is
// deliberately duplicated per source rather than shared, so they stay
// independent.
//
// The catalog switch happens ATOMICALLY (see refreshTmdbCatalog).
// ---------------------------------------------------------------------------
let tmdbCatalog = { movies: {}, lastRefresh: 0 };
// tmdbId -> { imdbId, releaseYear, detailsCheckedAt }. Primary-source facts,
// so they live with the catalog rather than inside either secondary's cache -
// OMDb, RT and Trakt all read them, none of them owns them.
let tmdbDetails = {};
let omdbRatings = { entries: {}, lastFullSync: null };
let rtScores = { entries: {}, lastFullSync: null };
let mcScores = { entries: {}, lastFullSync: null };
let forceTmdbRefresh = false;

function loadTmdbCache() {
  try {
    if (fs.existsSync(TMDB_CACHE_FILE)) {
      tmdbCatalog = JSON.parse(fs.readFileSync(TMDB_CACHE_FILE, "utf-8"));
      debugLog(`TMDb cache loaded: ${Object.keys(tmdbCatalog.movies).length} movies`);
    }
  } catch (err) {
    console.error("Could not load TMDb cache, starting empty:", err.message);
    tmdbCatalog = { movies: {}, lastRefresh: 0 };
  }
}
function saveTmdbCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(TMDB_CACHE_FILE, JSON.stringify(tmdbCatalog));
  } catch (err) {
    console.error("Could not save TMDb cache:", err.message);
  }
}

function loadOmdbCache() {
  try {
    if (fs.existsSync(OMDB_CACHE_FILE)) {
      omdbRatings = JSON.parse(fs.readFileSync(OMDB_CACHE_FILE, "utf-8"));
      debugLog(`OMDb cache loaded: ${Object.keys(omdbRatings.entries).length} entries`);
    }
  } catch (err) {
    console.error("Could not load OMDb cache, starting empty:", err.message);
    omdbRatings = { entries: {}, lastFullSync: null };
  }
}
function saveOmdbCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(OMDB_CACHE_FILE, JSON.stringify(omdbRatings));
  } catch (err) {
    console.error("Could not save OMDb cache:", err.message);
  }
}

function loadTmdbDetailsCache() {
  try {
    if (fs.existsSync(TMDB_DETAILS_CACHE_FILE)) {
      tmdbDetails = JSON.parse(fs.readFileSync(TMDB_DETAILS_CACHE_FILE, "utf-8"));
      debugLog(`TMDb details cache loaded: ${Object.keys(tmdbDetails).length} entries`);
      return;
    }
    // Older layout: a flat tmdbId -> imdbId map, with no release year. Keep
    // the ids (they're still valid) but leave detailsCheckedAt unset, so each
    // movie is re-fetched once to pick up its primary release year.
    if (fs.existsSync(LEGACY_IMDB_ID_CACHE_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_IMDB_ID_CACHE_FILE, "utf-8"));
      for (const [id, imdbId] of Object.entries(legacy)) tmdbDetails[id] = { imdbId, releaseYear: null };
      console.log(`Migrated ${Object.keys(tmdbDetails).length} IMDb id(s) into tmdb-details.json; release years will be filled in.`);
      saveTmdbDetailsCache();
    }
  } catch (err) {
    console.error("Could not load TMDb details cache, starting empty:", err.message);
    tmdbDetails = {};
  }
}
function saveTmdbDetailsCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(TMDB_DETAILS_CACHE_FILE, JSON.stringify(tmdbDetails));
  } catch (err) {
    console.error("Could not save TMDb details cache:", err.message);
  }
}

function loadRtCache() {
  try {
    if (fs.existsSync(RT_CACHE_FILE)) {
      rtScores = JSON.parse(fs.readFileSync(RT_CACHE_FILE, "utf-8"));
      debugLog(`RT cache loaded: ${Object.keys(rtScores.entries).length} entries`);
    }
  } catch (err) {
    console.error("Could not load RT cache, starting empty:", err.message);
    rtScores = { entries: {}, lastFullSync: null };
  }
}
function saveRtCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(RT_CACHE_FILE, JSON.stringify(rtScores));
  } catch (err) {
    console.error("Could not save RT cache:", err.message);
  }
}

function loadMcCache() {
  try {
    if (fs.existsSync(MC_CACHE_FILE)) {
      mcScores = JSON.parse(fs.readFileSync(MC_CACHE_FILE, "utf-8"));
      debugLog(`Metacritic cache loaded: ${Object.keys(mcScores.entries).length} entries`);
    }
  } catch (err) {
    console.error("Could not load Metacritic cache, starting empty:", err.message);
    mcScores = { entries: {}, lastFullSync: null };
  }
}
function saveMcCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(MC_CACHE_FILE, JSON.stringify(mcScores));
  } catch (err) {
    console.error("Could not save Metacritic cache:", err.message);
  }
}

/**
 * One-time migration from the pre-split cache, where a single omdb-cache.json
 * entry carried the IMDb id, both sources' ratings and both sources'
 * timestamps. Splits that apart into the three caches that own those facts
 * now. Runs only for fields that are actually present, so it is a no-op on
 * an already-migrated cache and safe to leave in place.
 */
function migrateLegacyOmdbCache() {
  let movedIds = 0;
  let movedRt = 0;
  let owedMetacritic = 0;

  for (const [id, entry] of Object.entries(omdbRatings.entries)) {
    if (!entry) continue;

    if (entry.imdbId !== undefined) {
      if (!(id in tmdbDetails)) tmdbDetails[id] = { imdbId: entry.imdbId, releaseYear: null };
      delete entry.imdbId;
      movedIds++;
    }

    // rtCheckedAt only ever existed if the scraper had run, so it marks the
    // stored `rt` as the scraper's value rather than OMDb's.
    if (entry.rtCheckedAt !== undefined) {
      if (!rtScores.entries[id]) {
        rtScores.entries[id] = {
          tomatometer: typeof entry.rt === "number" ? entry.rt : null,
          checkedAt: entry.rtCheckedAt,
          needsRefresh: Boolean(entry.rtNeedsRefresh),
        };
        movedRt++;
      }
      delete entry.rtCheckedAt;
      delete entry.rtNeedsRefresh;
    } else if (entry.rtNeedsRefresh !== undefined) {
      delete entry.rtNeedsRefresh;
    }

    // "OMDb still owes a Metacritic score" is just an ordinary refresh now
    // that the sources no longer wait on each other.
    if (entry.metacriticPending) {
      entry.needsRefresh = true;
      owedMetacritic++;
    }
    delete entry.metacriticPending;

    // The old format used rt/metacritic === "TODO" plus checkedAt: null for
    // "never checked"; the new one keys off checkedAt alone.
    if (entry.rt === "TODO") entry.rt = null;
    if (entry.metacritic === "TODO") entry.metacritic = null;
  }

  if (movedIds || movedRt || owedMetacritic) {
    console.log(
      `Migrated legacy cache: ${movedIds} IMDb id(s), ${movedRt} scraped RT score(s), ${owedMetacritic} pending Metacritic re-check(s).`
    );
    saveOmdbCache();
    saveTmdbDetailsCache();
    saveRtCache();
  }
}

// imdbId -> "m/<slug>" | null (null = Wikidata knows no RT id for it).
let rtSlugs = {};

function loadRtSlugCache() {
  try {
    if (fs.existsSync(RT_SLUG_CACHE_FILE)) {
      rtSlugs = JSON.parse(fs.readFileSync(RT_SLUG_CACHE_FILE, "utf-8"));
      debugLog(`RT slug cache loaded: ${Object.keys(rtSlugs).length} entries`);
    }
  } catch (err) {
    console.error("Could not load RT slug cache, starting empty:", err.message);
    rtSlugs = {};
  }
}
function saveRtSlugCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(RT_SLUG_CACHE_FILE, JSON.stringify(rtSlugs));
  } catch (err) {
    console.error("Could not save RT slug cache:", err.message);
  }
}

// imdbId -> "movie/<slug>" | null (null = Wikidata knows no Metacritic id
// for it). Separate from rtSlugs on purpose: the two mappings come from
// different Wikidata properties and one being absent says nothing about the
// other.
let mcSlugs = {};

function loadMcSlugCache() {
  try {
    if (fs.existsSync(MC_SLUG_CACHE_FILE)) {
      mcSlugs = JSON.parse(fs.readFileSync(MC_SLUG_CACHE_FILE, "utf-8"));
      debugLog(`Metacritic slug cache loaded: ${Object.keys(mcSlugs).length} entries`);
    }
  } catch (err) {
    console.error("Could not load Metacritic slug cache, starting empty:", err.message);
    mcSlugs = {};
  }
}
function saveMcSlugCache() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(MC_SLUG_CACHE_FILE, JSON.stringify(mcSlugs));
  } catch (err) {
    console.error("Could not save Metacritic slug cache:", err.message);
  }
}

/**
 * The primary source owns the id set: every catalog movie gets an entry in
 * every secondary cache, and entries for movies that left the catalog are
 * dropped. Run at startup as well as after a catalog refresh, so a cache
 * that predates a source (or a source enabled later) is reconciled without
 * waiting for the next TMDB_REFRESH_INTERVAL_HOURS.
 */
function reconcileSecondaryCaches() {
  let added = 0;
  for (const id of Object.keys(tmdbCatalog.movies)) {
    if (!omdbRatings.entries[id]) {
      omdbRatings.entries[id] = { rt: null, metacritic: null, checkedAt: null };
      added++;
    }
    if (!rtScores.entries[id]) {
      rtScores.entries[id] = { tomatometer: null, checkedAt: null };
      added++;
    }
    if (!mcScores.entries[id]) {
      mcScores.entries[id] = { metascore: null, checkedAt: null };
      added++;
    }
  }
  if (added > 0) {
    debugLog(`Reconciled secondary caches with the catalog: ${added} entr(ies) added`);
    saveOmdbCache();
    saveRtCache();
    saveMcCache();
  }
}

loadTmdbCache();
loadTmdbDetailsCache();
loadOmdbCache();
loadRtCache();
loadMcCache();
migrateLegacyOmdbCache();
reconcileSecondaryCaches();
if (RT_SCRAPE_ENABLED) loadRtSlugCache();
if (MC_SCRAPE_ENABLED) loadMcSlugCache();

// ---------------------------------------------------------------------------
// Trakt: single, server-wide account (see comment near TRAKT_CLIENT_ID).
// traktAuth holds OAuth tokens; traktWatched holds the derived set of
// watched IMDb ids, refreshed on its own interval, independent of both
// the TMDb catalog and the OMDb ratings.
// ---------------------------------------------------------------------------
let traktAuth = null; // { accessToken, refreshToken, expiresAt: isoString } | null = not connected
let traktWatched = { imdbIds: [], lastSync: null };
let traktWatchedSet = new Set();
// Set while a device-code flow is in progress; cleared on success/failure/replacement.
let traktPendingDevice = null; // { deviceCode, userCode, verificationUrl, expiresAt, interval }
let traktPollGeneration = 0; // incremented on every new /connect call to cancel any stale poll loop

function loadTraktAuth() {
  try {
    if (fs.existsSync(TRAKT_AUTH_FILE)) {
      traktAuth = JSON.parse(fs.readFileSync(TRAKT_AUTH_FILE, "utf-8"));
      debugLog("Trakt auth loaded from cache");
    }
  } catch (err) {
    console.error("Could not load Trakt auth, treating as not connected:", err.message);
    traktAuth = null;
  }
}
function saveTraktAuth() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (traktAuth) {
      fs.writeFileSync(TRAKT_AUTH_FILE, JSON.stringify(traktAuth));
    } else if (fs.existsSync(TRAKT_AUTH_FILE)) {
      fs.unlinkSync(TRAKT_AUTH_FILE);
    }
  } catch (err) {
    console.error("Could not save Trakt auth:", err.message);
  }
}

function loadTraktWatched() {
  try {
    if (fs.existsSync(TRAKT_WATCHED_FILE)) {
      traktWatched = JSON.parse(fs.readFileSync(TRAKT_WATCHED_FILE, "utf-8"));
      traktWatchedSet = new Set(traktWatched.imdbIds || []);
      debugLog(`Trakt watched list loaded: ${traktWatchedSet.size} movies`);
    }
  } catch (err) {
    console.error("Could not load Trakt watched list, starting empty:", err.message);
    traktWatched = { imdbIds: [], lastSync: null };
    traktWatchedSet = new Set();
  }
}
function saveTraktWatched() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(TRAKT_WATCHED_FILE, JSON.stringify(traktWatched));
  } catch (err) {
    console.error("Could not save Trakt watched list:", err.message);
  }
}

if (TRAKT_CONFIGURED) {
  loadTraktAuth();
  loadTraktWatched();
}

function buildMovieView(id) {
  const cat = tmdbCatalog.movies[id];
  if (!cat) return null;
  // Each source is read independently and merged only here, at the view
  // layer - see mergeRatingView for the precedence rule.
  const merged = mergeRatingView(omdbRatings.entries[id], rtScores.entries[id], mcScores.entries[id]);
  const details = tmdbDetails[id];
  const imdbId = details?.imdbId;
  let watched = "N/A"; // Trakt not connected, or this movie's IMDb id isn't known yet
  if (TRAKT_CONFIGURED && traktAuth && imdbId) {
    watched = traktWatchedSet.has(imdbId) ? "watched" : "unseen";
  }
  return {
    id,
    title: cat.title,
    // TMDb's primary release year (what themoviedb.org prints after the
    // title). cat.year is the region-scoped date discover returned - the
    // German release - and only stands in until the details fetch lands.
    year: details?.releaseYear || cat.year,
    genres: cat.genres,
    tmdbUrl: cat.tmdbUrl,
    rt: merged.rt,
    metacritic: merged.metacritic,
    rtCheckedAt: merged.rtCheckedAt,
    mcCheckedAt: merged.mcCheckedAt,
    omdbCheckedAt: merged.omdbCheckedAt,
    ratingNeedsRefresh: merged.ratingNeedsRefresh,
    watched,
  };
}
function buildAllMoviesView() {
  return Object.keys(tmdbCatalog.movies).map(buildMovieView).filter(Boolean);
}

// ---------------------------------------------------------------------------
// SSE: multiple clients at once, all receive the same live updates.
// ---------------------------------------------------------------------------
let sseClients = [];

function broadcast(type, payload = {}) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  sseClients.forEach((res) => {
    try {
      res.write(msg);
    } catch (err) {
      /* Client is probably already gone, will be cleaned up via "close" */
    }
  });
}

let engineStatus = {
  tmdb: { phase: "idle", message: "Not started yet.", updatedAt: null, lastRefresh: null, movieCount: 0 },
  // OMDb reports `configured` like the others now: with both scrapers on it
  // is genuinely optional, and a row for a source that isn't set up would
  // just be a permanent "not started yet".
  omdb: {
    configured: Boolean(OMDB_API_KEY),
    phase: "idle",
    message: "Not started yet.",
    updatedAt: null,
    lastFullSync: null,
    pending: 0,
  },
  rt: {
    configured: RT_SCRAPE_ENABLED,
    phase: "idle",
    message: "Not started yet.",
    updatedAt: null,
    lastSync: null,
    pending: 0,
  },
  mc: {
    configured: MC_SCRAPE_ENABLED,
    phase: "idle",
    message: "Not started yet.",
    updatedAt: null,
    lastSync: null,
    pending: 0,
  },
  trakt: {
    configured: TRAKT_CONFIGURED,
    phase: "unauthorized",
    message: "Not connected.",
    updatedAt: null,
    lastSync: null,
    movieCount: 0,
    userCode: null,
    verificationUrl: null,
    expiresAt: null,
  },
};

// Each source reports only its own progress. RT's sweep no longer shows up
// in the OMDb row (and vice versa) - that was the visible symptom of the two
// sharing one processing pass.
function setRtStatus(phase, message, extra = {}) {
  if (extra.lastSync) rtScores.lastFullSync = extra.lastSync;
  engineStatus.rt = {
    configured: RT_SCRAPE_ENABLED,
    phase,
    message,
    updatedAt: new Date().toISOString(),
    lastSync: rtScores.lastFullSync,
    pending: extra.pending ?? engineStatus.rt.pending ?? 0,
    processed: extra.processed,
    total: extra.total,
  };
  broadcast("status", { engineStatus });
}

function setMcStatus(phase, message, extra = {}) {
  if (extra.lastSync) mcScores.lastFullSync = extra.lastSync;
  engineStatus.mc = {
    configured: MC_SCRAPE_ENABLED,
    phase,
    message,
    updatedAt: new Date().toISOString(),
    lastSync: mcScores.lastFullSync,
    pending: extra.pending ?? engineStatus.mc.pending ?? 0,
    processed: extra.processed,
    total: extra.total,
  };
  broadcast("status", { engineStatus });
}

function setTmdbStatus(phase, message, extra = {}) {
  engineStatus.tmdb = {
    phase,
    message,
    updatedAt: new Date().toISOString(),
    lastRefresh: tmdbCatalog.lastRefresh ? new Date(tmdbCatalog.lastRefresh).toISOString() : null,
    movieCount: Object.keys(tmdbCatalog.movies).length,
    ...extra,
  };
  broadcast("status", { engineStatus });
}

function setOmdbStatus(phase, message, extra = {}) {
  if (extra.lastFullSync) omdbRatings.lastFullSync = extra.lastFullSync;
  engineStatus.omdb = {
    configured: Boolean(OMDB_API_KEY),
    phase,
    message,
    updatedAt: new Date().toISOString(),
    lastFullSync: omdbRatings.lastFullSync,
    pending: extra.pending ?? engineStatus.omdb.pending ?? 0,
    processed: extra.processed,
    total: extra.total,
  };
  broadcast("status", { engineStatus });
}

function setTraktStatus(phase, message, extra = {}) {
  if (extra.lastSync) traktWatched.lastSync = extra.lastSync;
  engineStatus.trakt = {
    configured: TRAKT_CONFIGURED,
    phase,
    message,
    updatedAt: new Date().toISOString(),
    lastSync: traktWatched.lastSync,
    movieCount: extra.movieCount ?? traktWatchedSet.size,
    userCode: extra.userCode ?? null,
    verificationUrl: extra.verificationUrl ?? null,
    expiresAt: extra.expiresAt ?? null,
  };
  broadcast("status", { engineStatus });
}

// Initial status values from the loaded cache, before the engine has
// completed its first pass.
setTmdbStatus("idle", tmdbCatalog.lastRefresh ? "Catalog loaded from cache." : "No catalog loaded yet.");
if (OMDB_API_KEY) {
  setOmdbStatus("idle", omdbRatings.lastFullSync ? "Ratings loaded from cache." : "No ratings checked yet.");
}
if (RT_SCRAPE_ENABLED) {
  setRtStatus("idle", rtScores.lastFullSync ? "Tomatometers loaded from cache." : "No tomatometers fetched yet.");
}
if (MC_SCRAPE_ENABLED) {
  setMcStatus("idle", mcScores.lastFullSync ? "Metascores loaded from cache." : "No Metascores fetched yet.");
}
if (TRAKT_CONFIGURED) {
  setTraktStatus(
    traktAuth ? "idle" : "unauthorized",
    traktAuth ? (traktWatched.lastSync ? "Watched list loaded from cache." : "Connected, not synced yet.") : "Not connected."
  );
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

app.get("/api/status", (req, res) => {
  res.json({
    tmdbConfigured: Boolean(TMDB_API_KEY),
    omdbConfigured: Boolean(OMDB_API_KEY),
    rtScrapeEnabled: RT_SCRAPE_ENABLED,
    mcScrapeEnabled: MC_SCRAPE_ENABLED,
    traktConfigured: TRAKT_CONFIGURED,
    debugMode: DEBUG_MODE,
    providerName: PROVIDER_NAME,
    engineStatus,
  });
});

app.post("/api/tmdb/refresh", (req, res) => {
  if (engineStatus.tmdb.phase === "refreshing") {
    return res.json({ ok: true, alreadyRunning: true });
  }
  forceTmdbRefresh = true;
  wakeEngine();
  res.json({ ok: true, queued: true });
});

// One manual trigger per secondary source, each touching only its own
// cache. Neither blanks the table back to "TODO": the stored values stay
// visible until fresh ones replace them (see markStale).
app.post("/api/omdb/refresh", (req, res) => {
  if (!OMDB_API_KEY) {
    return res.status(400).json({ error: "OMDB_API_KEY is not set." });
  }
  if (engineStatus.omdb.phase === "checking_ratings" || engineStatus.omdb.phase === "waiting_for_limit_reset") {
    return res.json({ ok: true, alreadyRunning: true });
  }
  const ids = Object.keys(omdbRatings.entries);
  for (const id of ids) omdbRatings.entries[id].needsRefresh = true;
  omdbPausedUntil = 0; // an explicit "Sync now" outranks an ongoing back-off
  saveOmdbCache();
  setOmdbStatus("idle", `Manual OMDb sync triggered (${ids.length} movies queued).`, { pending: ids.length });
  wakeEngine();
  res.json({ ok: true, queued: true, count: ids.length });
});

app.post("/api/rt/refresh", (req, res) => {
  if (!RT_SCRAPE_ENABLED) {
    return res.status(400).json({ error: "RT_SCRAPE_ENABLED is not set." });
  }
  if (engineStatus.rt.phase === "scraping") {
    return res.json({ ok: true, alreadyRunning: true });
  }
  const ids = Object.keys(rtScores.entries);
  for (const id of ids) rtScores.entries[id].needsRefresh = true;
  rtPausedUntil = 0; // an explicit "Sync now" outranks an ongoing back-off
  saveRtCache();
  setRtStatus("idle", `Manual Rotten Tomatoes sync triggered (${ids.length} movies queued).`, { pending: ids.length });
  wakeEngine();
  res.json({ ok: true, queued: true, count: ids.length });
});

app.post("/api/mc/refresh", (req, res) => {
  if (!MC_SCRAPE_ENABLED) {
    return res.status(400).json({ error: "MC_SCRAPE_ENABLED is not set." });
  }
  if (engineStatus.mc.phase === "scraping") {
    return res.json({ ok: true, alreadyRunning: true });
  }
  const ids = Object.keys(mcScores.entries);
  for (const id of ids) mcScores.entries[id].needsRefresh = true;
  mcPausedUntil = 0; // an explicit "Sync now" outranks an ongoing back-off
  saveMcCache();
  setMcStatus("idle", `Manual Metacritic sync triggered (${ids.length} movies queued).`, { pending: ids.length });
  wakeEngine();
  res.json({ ok: true, queued: true, count: ids.length });
});

app.post("/api/trakt/connect", async (req, res) => {
  if (!TRAKT_CONFIGURED) {
    return res.status(400).json({ error: "TRAKT_CLIENT_ID/TRAKT_CLIENT_SECRET are not set." });
  }
  try {
    const device = await requestTraktDeviceCode();
    traktPendingDevice = {
      deviceCode: device.device_code,
      userCode: device.user_code,
      verificationUrl: device.verification_url,
      expiresAt: new Date(Date.now() + device.expires_in * 1000).toISOString(),
      interval: device.interval || 5,
    };
    const generation = ++traktPollGeneration;
    setTraktStatus("awaiting_authorization", `Go to ${device.verification_url} and enter code ${device.user_code}.`, {
      userCode: device.user_code,
      verificationUrl: device.verification_url,
      expiresAt: traktPendingDevice.expiresAt,
    });
    pollTraktDeviceAuthorization(generation); // fire-and-forget; result arrives via status broadcasts
    res.json({ ok: true, userCode: device.user_code, verificationUrl: device.verification_url, expiresIn: device.expires_in });
  } catch (err) {
    console.error("Trakt device-code request failed:", err.message);
    setTraktStatus("error", `Could not start Trakt connection: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/trakt/refresh", (req, res) => {
  if (!TRAKT_CONFIGURED) return res.status(400).json({ error: "Trakt is not configured." });
  if (!traktAuth) return res.status(400).json({ error: "Trakt is not connected yet." });
  if (engineStatus.trakt.phase === "syncing") return res.json({ ok: true, alreadyRunning: true });
  traktWatched.lastSync = null; // marks it as due; next engine tick (or current, if idle) picks it up
  wakeEngine();
  res.json({ ok: true, queued: true });
});

app.post("/api/trakt/disconnect", (req, res) => {
  if (!TRAKT_CONFIGURED) return res.status(400).json({ error: "Trakt is not configured." });
  traktAuth = null;
  traktPendingDevice = null;
  traktPollGeneration++; // cancels any in-flight device-code poll loop
  saveTraktAuth();
  traktWatched = { imdbIds: [], lastSync: null };
  traktWatchedSet = new Set();
  saveTraktWatched();
  setTraktStatus("unauthorized", "Disconnected.");
  broadcast("snapshot", { movies: buildAllMoviesView() }); // resets everyone's "Watched" column back to N/A
  res.json({ ok: true });
});

// Live stream: initial state + all future updates.
app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // prevents buffering by nginx & similar reverse proxies
  });
  // Force the headers/first bytes to be sent immediately instead of waiting
  // for an internal buffer threshold (cause of delayed SSE connection
  // establishment).
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  if (req.socket && typeof req.socket.setNoDelay === "function") req.socket.setNoDelay(true);

  const connectStart = Date.now();
  debugLog(`SSE client connected (${sseClients.length + 1} active)`);

  res.write(
    `data: ${JSON.stringify({
      type: "init",
      movies: buildAllMoviesView(),
      engineStatus,
    })}\n\n`
  );
  debugLog(`SSE init sent after ${Date.now() - connectStart}ms`);

  sseClients.push(res);
  const heartbeat = setInterval(() => {
    try {
      // A real event instead of a plain comment, so the client (see below)
      // actually notices that the connection is still alive.
      res.write(`data: ${JSON.stringify({ type: "ping" })}\n\n`);
    } catch (err) {
      /* Client gone, will be cleaned up below */
    }
  }, 10000);

  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients = sseClients.filter((c) => c !== res);
    debugLog(`SSE client disconnected (${sseClients.length} still active)`);
  });
});

// ---------------------------------------------------------------------------
// TMDb / OMDb helper functions (with debug logging)
// ---------------------------------------------------------------------------

async function findProviderId() {
  const url = `${TMDB_BASE}/watch/providers/movie?api_key=${TMDB_API_KEY}&watch_region=DE&language=en-US`;
  const t0 = Date.now();
  debugLog(`TMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  debugLog(`TMDb <- ${r.status} (${Date.now() - t0}ms) [providers]`);
  if (!r.ok) throw new Error(`TMDb provider lookup failed (HTTP ${r.status})`);
  const data = await r.json();
  const match = (data.results || []).find((p) => p.provider_name === PROVIDER_NAME);
  if (!match) {
    throw new Error(`Provider "${PROVIDER_NAME}" was not found at TMDb for region DE.`);
  }
  return match.provider_id;
}

async function fetchGenreMap(tmdbLocale) {
  const url = `${TMDB_BASE}/genre/movie/list?api_key=${TMDB_API_KEY}&language=${tmdbLocale}`;
  const t0 = Date.now();
  debugLog(`TMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  debugLog(`TMDb <- ${r.status} (${Date.now() - t0}ms) [genres/${tmdbLocale}]`);
  if (!r.ok) throw new Error(`TMDb genre lookup failed (HTTP ${r.status})`);
  const data = await r.json();
  const map = {};
  (data.genres || []).forEach((g) => {
    map[g.id] = g.name;
  });
  return map;
}

async function fetchDiscoverPage(providerId, page, tmdbLocale) {
  const url =
    `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}` +
    `&language=${tmdbLocale}&region=DE&watch_region=DE` +
    `&with_watch_providers=${providerId}&with_watch_monetization_types=flatrate` +
    `&sort_by=primary_release_date.desc&include_adult=false&page=${page}`;
  const t0 = Date.now();
  debugLog(`TMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  debugLog(`TMDb <- ${r.status} (${Date.now() - t0}ms) [discover/${tmdbLocale} page ${page}]`);
  if (!r.ok) throw new Error(`TMDb discover request failed (page ${page}, HTTP ${r.status})`);
  return r.json();
}

/**
 * Fetches the per-movie primary-source facts in ONE request: the IMDb id and
 * the primary release year. This deliberately uses `/movie/{id}` rather than
 * `/movie/{id}/external_ids` - it costs exactly the same one request but also
 * carries `release_date`, and unlike discover's region-scoped date that field
 * is TMDb's primary release date, i.e. the year the website shows in
 * parentheses after the title. See lib/tmdb.js.
 */
async function fetchMovieDetails(tmdbMovieId) {
  const url = `${TMDB_BASE}/movie/${tmdbMovieId}?api_key=${TMDB_API_KEY}`;
  const t0 = Date.now();
  debugLog(`TMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  debugLog(`TMDb <- ${r.status} (${Date.now() - t0}ms) [details ${tmdbMovieId}]`);
  if (!r.ok) return null;
  return extractMovieDetails(await r.json());
}

async function fetchOmdbRatings(imdbId) {
  const url = `${OMDB_BASE}?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_API_KEY}`;
  const t0 = Date.now();
  debugLog(`OMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  debugLog(`OMDb <- ${r.status} (${Date.now() - t0}ms) [${imdbId}] Response=${data?.Response} Error=${data?.Error ?? "-"}`);

  if (isOmdbAuthError(r.status, data)) {
    throw new OmdbAuthError(`OMDB_API_KEY was rejected by OMDb: "${data.Error}"`);
  }
  if (isOmdbLimitResponse(r.status, data)) {
    const detail = data && data.Error ? `"${data.Error}"` : `HTTP ${r.status}`;
    throw new OmdbLimitError(`OMDb daily limit reached: ${detail}`);
  }

  return parseOmdbPayload(r.ok, data);
}

// ---------------------------------------------------------------------------
// Rotten Tomatoes (opt-in, RT_SCRAPE_ENABLED): a two-step, best-effort
// source that exists because RT has no public API.
//
//  1. Wikidata resolves IMDb ids -> RT slugs, BATCHED (one query per
//     WIKIDATA_BATCH_SIZE ids), and the mapping is cached permanently.
//  2. The RT page for a slug is fetched and parsed, unavoidably per movie,
//     throttled by RT_REQUEST_DELAY_MS.
//
// Every failure mode here (no Wikidata entry, 404, changed markup, network
// error) resolves to "no score" rather than an exception, so a broken
// scraper degrades to OMDb/"N/A" instead of stalling the engine.
// ---------------------------------------------------------------------------

/**
 * Runs ONE SPARQL query against Wikidata, with a single retry when the
 * endpoint says "not now" (429/5xx, see isWikidataRetryable).
 *
 * The HTTP mechanics are shared by both scrapers because there is genuinely
 * one upstream here - query.wikidata.org - and its rate limit is applied to
 * this host as a whole, not per source. Everything that makes the two
 * sources independent (which property they ask for, their caches, their
 * back-offs, their status rows) stays with each source.
 *
 * Returns `{ ok: true, data }`, or `{ ok: false, reason, retryAfterMs }`
 * where `reason` is human-readable and carries the HTTP status - the whole
 * point being that "unreachable" alone is not something anyone can act on.
 */
async function runWikidataQuery(query, userAgent, label) {
  const url = `${WIKIDATA_SPARQL_BASE}?format=json&query=${encodeURIComponent(query)}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    debugLog(`Wikidata GET sparql [${label}]${attempt > 1 ? " (retry)" : ""}`);
    try {
      const r = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": userAgent } });
      debugLog(`Wikidata <- ${r.status} (${Date.now() - t0}ms) [${label}]`);
      if (r.ok) return { ok: true, data: await r.json().catch(() => null) };

      const retryAfterMs = parseRetryAfterMs(r.headers.get("retry-after"));
      const reason = `HTTP ${r.status}${r.status === 429 ? " (rate limited by Wikidata)" : ""}`;
      // One brief pause and one more go covers a hiccup. When Wikidata
      // names a wait of its own (Retry-After), it is asking for far longer
      // than a pass may hold the loop for - that becomes the caller's
      // back-off instead, and this returns straight away.
      if (attempt === 1 && isWikidataRetryable(r.status) && retryAfterMs === null) {
        await sleep(WIKIDATA_RETRY_PAUSE_MS);
        continue;
      }
      return { ok: false, reason, retryAfterMs };
    } catch (err) {
      if (attempt === 1) {
        await sleep(WIKIDATA_RETRY_PAUSE_MS);
        continue;
      }
      return { ok: false, reason: err.message, retryAfterMs: null };
    }
  }
  return { ok: false, reason: "unknown error", retryAfterMs: null };
}

/**
 * Resolves and caches RT slugs for any of `imdbIds` not already known.
 *
 * Returns `{ ok, reason, retryAfterMs }`. A failure must NOT be cached and
 * must not be recorded as a missing rating - but note that whatever earlier
 * batches DID resolve is kept, and the caller goes on to scrape those. A
 * lookup that fails half way through slows the source down; it does not
 * stop it.
 */
async function resolveRtSlugs(imdbIds) {
  const unknown = [...new Set(imdbIds.filter((id) => id && !(id in rtSlugs)))];
  if (unknown.length === 0) return { ok: true };

  for (let i = 0; i < unknown.length; i += WIKIDATA_BATCH_SIZE) {
    const batch = unknown.slice(i, i + WIKIDATA_BATCH_SIZE);
    const query = buildRtIdQuery(batch);
    if (!query) continue;
    if (i > 0) await sleep(WIKIDATA_REQUEST_DELAY_MS);

    const result = await runWikidataQuery(query, RT_USER_AGENT, `Rotten Tomatoes, ${batch.length} ids`);
    if (!result.ok) {
      console.error(`[RT] Wikidata id lookup failed: ${result.reason}`);
      return result;
    }
    const found = parseRtIdBindings(result.data);
    for (const id of batch) {
      // Remember misses as null too, so a film Wikidata simply doesn't
      // cover doesn't get re-queried on every single pass.
      rtSlugs[id] = found[id] ?? null;
    }
    saveRtSlugCache();
  }
  return { ok: true };
}

/**
 * Fetches the RT page for one IMDb id. Returns `{ score, unavailable }`:
 * `score` is the tomatometer or null, and `unavailable` distinguishes "RT
 * wouldn't answer us just now" from "RT answered, there's simply no score" -
 * only the latter may be recorded as a checked "N/A" (see
 * isRtTransientFailure).
 */
async function fetchRtScore(imdbId) {
  const slug = rtSlugs[imdbId];
  if (!slug) return { score: null, unavailable: false };

  const url = buildRtUrl(slug);
  const t0 = Date.now();
  debugLog(`RT GET ${url}`);
  try {
    const r = await fetch(url, { headers: { "User-Agent": RT_USER_AGENT, Accept: "text/html" } });
    if (!r.ok) {
      debugLog(`RT <- ${r.status} (${Date.now() - t0}ms) [${imdbId} ${slug}]`);
      return { score: null, unavailable: isRtTransientFailure(r.status) };
    }
    const html = await r.text();
    const { tomatometer } = parseRtPage(html);
    debugLog(`RT <- ${r.status} (${Date.now() - t0}ms) [${imdbId} ${slug}] tomatometer=${tomatometer ?? "-"}`);
    // A page that loaded but yielded nothing is treated as "no score on
    // file". If RT changed its markup, that's indistinguishable from here -
    // which is why the scraper is opt-in and documented as best-effort.
    return { score: tomatometer, unavailable: false };
  } catch (err) {
    debugLog(`[RT] Fetch failed for ${imdbId} (${slug}): ${err.message}`);
    return { score: null, unavailable: true };
  }
}

// ---------------------------------------------------------------------------
// Metacritic (opt-in, MC_SCRAPE_ENABLED): structurally identical to the RT
// block above - Wikidata resolves IMDb ids -> "movie/<slug>" in batches
// (property P1712), then the page for a slug is fetched and parsed, one
// movie at a time, throttled by MC_REQUEST_DELAY_MS.
//
// Kept as its own pair of functions rather than folded into a generic
// "scrape a site" helper: the two sites differ in what a miss means, in
// which property holds their ids and in how their pages have to be read,
// and sharing the plumbing would put a Metacritic markup change one edit
// away from breaking RT as well.
// ---------------------------------------------------------------------------

/**
 * Resolves and caches Metacritic slugs for any of `imdbIds` not already
 * known. Same contract as resolveRtSlugs above: a failed lookup is reported
 * with its reason, never cached, and never recorded as a missing rating -
 * while whatever earlier batches resolved is kept and still scraped.
 */
async function resolveMcSlugs(imdbIds) {
  const unknown = [...new Set(imdbIds.filter((id) => id && !(id in mcSlugs)))];
  if (unknown.length === 0) return { ok: true };

  for (let i = 0; i < unknown.length; i += WIKIDATA_BATCH_SIZE) {
    const batch = unknown.slice(i, i + WIKIDATA_BATCH_SIZE);
    const query = buildMetacriticIdQuery(batch);
    if (!query) continue;
    if (i > 0) await sleep(WIKIDATA_REQUEST_DELAY_MS);

    const result = await runWikidataQuery(query, MC_USER_AGENT, `Metacritic, ${batch.length} ids`);
    if (!result.ok) {
      console.error(`[MC] Wikidata id lookup failed: ${result.reason}`);
      return result;
    }
    const found = parseMetacriticIdBindings(result.data);
    for (const id of batch) {
      // Remember misses as null too, so a film Wikidata simply doesn't
      // cover doesn't get re-queried on every single pass.
      mcSlugs[id] = found[id] ?? null;
    }
    saveMcSlugCache();
  }
  return { ok: true };
}

/**
 * Fetches the Metacritic page for one IMDb id. Returns `{ score,
 * unavailable }`, with the same meaning as fetchRtScore's: only a page that
 * actually answered may be recorded as a checked "N/A".
 */
async function fetchMetascore(imdbId) {
  const slug = mcSlugs[imdbId];
  if (!slug) return { score: null, unavailable: false };

  const url = buildMetacriticUrl(slug);
  const t0 = Date.now();
  debugLog(`MC GET ${url}`);
  try {
    const r = await fetch(url, { headers: { "User-Agent": MC_USER_AGENT, Accept: "text/html" } });
    if (!r.ok) {
      debugLog(`MC <- ${r.status} (${Date.now() - t0}ms) [${imdbId} ${slug}]`);
      return { score: null, unavailable: isMetacriticTransientFailure(r.status) };
    }
    const html = await r.text();
    const metascore = parseMetacriticPage(html);
    debugLog(`MC <- ${r.status} (${Date.now() - t0}ms) [${imdbId} ${slug}] metascore=${metascore ?? "-"}`);
    // A page that loaded but yielded nothing is treated as "no score on
    // file". If Metacritic changed its markup, that's indistinguishable from
    // here - which is why the scraper is opt-in and documented as
    // best-effort.
    return { score: metascore, unavailable: false };
  } catch (err) {
    debugLog(`[MC] Fetch failed for ${imdbId} (${slug}): ${err.message}`);
    return { score: null, unavailable: true };
  }
}

// ---------------------------------------------------------------------------
// Trakt: device-code OAuth flow + a single bulk "watched" sync.
//
// Unlike OMDb/TMDb, this never needs a per-movie API call: Trakt's
// /sync/watched/movies returns the entire watch history in one (paginated)
// request, which we turn into a Set of IMDb ids and match locally against
// whatever IMDb ids OMDb has already resolved for us.
// ---------------------------------------------------------------------------

async function requestTraktDeviceCode() {
  const url = `${TRAKT_BASE}/oauth/device/code`;
  debugLog(`Trakt POST ${url}`);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: TRAKT_CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`Trakt device-code request failed (HTTP ${r.status})`);
  return r.json();
}

/** Returns the raw fetch Response so callers can branch on status (pending/terminal/success). */
async function exchangeTraktDeviceToken(deviceCode) {
  const url = `${TRAKT_BASE}/oauth/device/token`;
  debugLog(`Trakt POST ${url} [device token poll]`);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: deviceCode, client_id: TRAKT_CLIENT_ID, client_secret: TRAKT_CLIENT_SECRET }),
  });
}

function saveTokensFromResponse(tokenData) {
  traktAuth = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
  };
  saveTraktAuth();
}

/**
 * Polls Trakt until the user has approved (or the code expired/was denied),
 * per the device-code flow's own recommended interval. Runs independently
 * of the main engine loop's tick (it has its own timing contract with
 * Trakt). `generation` lets a newer /connect call silently cancel an older,
 * still-running poll instead of both racing to save conflicting results.
 */
async function pollTraktDeviceAuthorization(generation) {
  const device = traktPendingDevice;
  if (!device) return;

  while (true) {
    if (generation !== traktPollGeneration) {
      debugLog("[Trakt] Poll cancelled (superseded by a newer /connect call)");
      return;
    }
    if (Date.now() >= new Date(device.expiresAt).getTime()) {
      setTraktStatus("unauthorized", "Connection code expired before it was approved. Try again.");
      traktPendingDevice = null;
      return;
    }

    await sleep(device.interval * 1000);
    if (generation !== traktPollGeneration) return; // cancelled while sleeping

    try {
      const r = await exchangeTraktDeviceToken(device.deviceCode);
      const data = await r.json().catch(() => null);
      debugLog(`Trakt <- ${r.status} [device token poll]`);

      if (r.ok) {
        saveTokensFromResponse(data);
        traktPendingDevice = null;
        setTraktStatus("idle", "Connected. Starting first sync ...");
        await syncTraktWatched();
        return;
      }
      if (isDeviceAuthorizationSlowDown(r.status)) {
        device.interval += 5; // Trakt asked us to back off
        continue;
      }
      if (isDeviceAuthorizationPending(r.status)) {
        continue; // normal - user hasn't approved yet, keep polling
      }
      if (isDeviceAuthorizationTerminal(r.status)) {
        setTraktStatus(
          "unauthorized",
          r.status === 418 ? "Connection was denied." : `Connection code is no longer valid (HTTP ${r.status}).`
        );
        traktPendingDevice = null;
        return;
      }
      // Unexpected status - log and keep trying until expiry.
      debugLog(`[Trakt] Unexpected device-token status ${r.status}, continuing to poll`);
    } catch (err) {
      debugLog(`[Trakt] Device-token poll error: ${err.message}`);
      // Transient network error - keep polling rather than aborting the whole flow.
    }
  }
}

async function refreshTraktAccessToken() {
  const url = `${TRAKT_BASE}/oauth/token`;
  debugLog(`Trakt POST ${url} [token refresh]`);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      refresh_token: traktAuth.refreshToken,
      client_id: TRAKT_CLIENT_ID,
      client_secret: TRAKT_CLIENT_SECRET,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error(`Trakt token refresh failed (HTTP ${r.status})`);
  const data = await r.json();
  saveTokensFromResponse(data);
}

/** Fetches one page of the watched-movies sync endpoint. Returns [] once exhausted. */
async function fetchTraktWatchedPage(page) {
  const url = `${TRAKT_BASE}/sync/watched/movies?page=${page}&limit=100`;
  const t0 = Date.now();
  debugLog(`Trakt GET ${url} [page ${page}]`);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${traktAuth.accessToken}`,
      "trakt-api-version": "2",
      "trakt-api-key": TRAKT_CLIENT_ID,
    },
  });
  debugLog(`Trakt <- ${r.status} (${Date.now() - t0}ms) [watched page ${page}]`);

  if (isTraktAuthError(r.status)) {
    const err = new Error(`Trakt authorization was rejected (HTTP ${r.status}) - reconnect required.`);
    err.isAuthError = true;
    throw err;
  }
  if (!r.ok) throw new Error(`Trakt watched-movies request failed (page ${page}, HTTP ${r.status})`);
  return r.json();
}

async function syncTraktWatched() {
  if (!traktAuth) return;

  if (isTokenDueForRefresh(traktAuth.expiresAt)) {
    try {
      await refreshTraktAccessToken();
    } catch (err) {
      console.error("Trakt token refresh failed:", err.message);
      setTraktStatus("error", "Trakt session expired and could not be refreshed - please reconnect.");
      traktAuth = null;
      saveTraktAuth();
      return;
    }
  }

  setTraktStatus("syncing", "Syncing watched history from Trakt ...");
  debugLog("[Trakt] Watched sync started");

  try {
    const allIds = new Set();
    let page = 1;
    for (;;) {
      const items = await fetchTraktWatchedPage(page);
      if (!items || items.length === 0) break;
      for (const id of extractWatchedImdbIds(items)) allIds.add(id);
      if (items.length < 100) break; // short page = last page
      page++;
      await sleep(100);
    }

    traktWatchedSet = allIds;
    traktWatched = { imdbIds: [...allIds], lastSync: new Date().toISOString() };
    saveTraktWatched();

    debugLog(`[Trakt] Watched sync done: ${allIds.size} movies`);
    setTraktStatus("idle", `Watched list up to date: ${allIds.size} movies.`, {
      lastSync: traktWatched.lastSync,
      movieCount: allIds.size,
    });

    // Watched status changed for potentially many movies at once - reuse
    // the same atomic "snapshot" mechanism as a TMDb catalog refresh so
    // every connected client updates in one consistent step.
    broadcast("snapshot", { movies: buildAllMoviesView() });
  } catch (err) {
    if (err.isAuthError) {
      console.error("Trakt auth error during sync:", err.message);
      setTraktStatus("unauthorized", "Trakt connection was revoked or expired - please reconnect.");
      traktAuth = null;
      saveTraktAuth();
    } else {
      console.error("Trakt sync error:", err.message);
      setTraktStatus("error", `Trakt sync failed: ${err.message}`);
    }
  }
}

/** Returns true if a sync actually ran (so the engine loop knows not to idle-sleep). */
async function maybeSyncTrakt() {
  if (!TRAKT_CONFIGURED || !traktAuth) return false;
  const due = !traktWatched.lastSync || Date.now() - new Date(traktWatched.lastSync).getTime() >= TRAKT_REFRESH_INTERVAL_MS;
  if (!due) return false;
  await syncTraktWatched();
  return true;
}

// ---------------------------------------------------------------------------
// Background engine
// ---------------------------------------------------------------------------

/**
 * Reloads the entire catalog and only takes it over AFTER it has fully
 * loaded, in a single step (staging -> atomic swap -> a single "snapshot"
 * broadcast). While loading (can take a couple of minutes, since the
 * catalog is fetched once per supported UI language), already-connected
 * clients keep seeing the old, complete state - no partially updated
 * intermediate state.
 *
 * Movie titles and genre names are fetched separately for every language
 * in SUPPORTED_LANGUAGES and stored per movie as e.g.
 * `title: { en: "...", de: "..." }`, so each connected browser can render
 * the catalog in its own chosen UI language without any server round-trip.
 * Ratings (RT/Metacritic) are language-independent and stay in the
 * separate OMDb cache untouched by this.
 */
async function refreshTmdbCatalog() {
  const t0 = Date.now();
  setTmdbStatus("refreshing", `Refreshing catalog "${PROVIDER_NAME}" (DE) from TMDb ...`);
  debugLog("[TMDb] Catalog refresh started");

  const providerId = await findProviderId();
  const languageKeys = Object.keys(SUPPORTED_LANGUAGES);

  // id -> { year, title: {langKey: string}, genres: {langKey: string} }
  const staging = {};

  for (const langKey of languageKeys) {
    const tmdbLocale = SUPPORTED_LANGUAGES[langKey];
    const genreMap = await fetchGenreMap(tmdbLocale);

    const firstPage = await fetchDiscoverPage(providerId, 1, tmdbLocale);
    const totalPages = Math.min(firstPage.total_pages || 1, 500);
    let allMovies = [...(firstPage.results || [])];
    setTmdbStatus("refreshing", `Loading catalog (${langKey}), page 1/${totalPages} ...`, {
      page: 1,
      totalPages,
      language: langKey,
    });

    for (let page = 2; page <= totalPages; page++) {
      setTmdbStatus("refreshing", `Loading catalog (${langKey}), page ${page}/${totalPages} ...`, {
        page,
        totalPages,
        language: langKey,
      });
      const pageData = await fetchDiscoverPage(providerId, page, tmdbLocale);
      allMovies = allMovies.concat(pageData.results || []);
      await sleep(60);
    }

    for (const movie of allMovies) {
      const id = String(movie.id);
      const year = (movie.release_date || "").slice(0, 4) || "unknown";
      const genres =
        (movie.genre_ids || [])
          .map((gid) => genreMap[gid])
          .filter(Boolean)
          .join(", ") || "\u2013";

      if (!staging[id]) staging[id] = { year, title: {}, genres: {} };
      staging[id].year = year; // language-independent, but set again defensively
      staging[id].title[langKey] = movie.title;
      staging[id].genres[langKey] = genres;
    }

    debugLog(`[TMDb] Language "${langKey}" done: ${allMovies.length} movies`);
  }

  // Staging: the new catalog is built completely separately, without
  // touching the currently visible state.
  const newMovies = {};
  for (const [id, entry] of Object.entries(staging)) {
    const tmdbUrl = `https://www.themoviedb.org/movie/${id}`;
    newMovies[id] = { id, year: entry.year, title: entry.title, genres: entry.genres, tmdbUrl };
  }

  const previousIds = new Set(Object.keys(tmdbCatalog.movies));
  const newIds = new Set(Object.keys(newMovies));

  // --- Atomic switch ---
  tmdbCatalog = { movies: newMovies, lastRefresh: Date.now() };

  // The primary source decides which movies exist; every secondary just
  // gets an empty entry per movie to fill in on its own schedule, and loses
  // entries for movies that left the catalog. Neither secondary is
  // consulted here, and neither can hold this up.
  reconcileSecondaryCaches();
  for (const id of previousIds) {
    if (newIds.has(id)) continue;
    delete omdbRatings.entries[id];
    delete rtScores.entries[id];
    delete mcScores.entries[id];
    delete tmdbDetails[id];
  }

  saveTmdbCache();
  saveTmdbDetailsCache();
  saveOmdbCache();
  saveRtCache();
  saveMcCache();

  debugLog(`[TMDb] Catalog refresh done: ${newIds.size} movies (${Date.now() - t0}ms)`);
  setTmdbStatus("idle", `Catalog up to date: ${newIds.size} movies on ${PROVIDER_NAME} (DE).`);

  // All connected clients jump to the new state in one go.
  broadcast("snapshot", { movies: buildAllMoviesView() });
}

/**
 * Resolves (and caches) a movie's IMDb id. This is PRIMARY-source data -
 * TMDb's external_ids - so it lives here rather than inside either
 * secondary's cache: OMDb needs it to query, RT needs it to find a slug,
 * and Trakt needs it to match watched history. A `null` result is cached
 * too, so a movie TMDb has no IMDb id for isn't looked up again and again.
 */
// A source that needs to wait (a spent daily quota, a website refusing us)
// records WHEN it may try again and returns - it never sleeps inside its
// pass. Sleeping there would hold the whole engine loop, which is exactly
// how a rate-limited OMDb used to stall RT and Trakt along with itself.
let omdbPausedUntil = 0;
let rtPausedUntil = 0;
let mcPausedUntil = 0;

let detailsResolvedSinceSave = 0;

/**
 * Resolves and caches a movie's primary-source details, returning its IMDb
 * id. A failed fetch is not cached, so it's retried later rather than
 * remembered as "this film has no IMDb id".
 */
async function ensureMovieDetails(tmdbId) {
  const cached = tmdbDetails[tmdbId];
  if (!needsDetailsFetch(cached)) return cached.imdbId;

  const fetched = await fetchMovieDetails(tmdbId);
  if (!fetched) return cached?.imdbId ?? null;

  tmdbDetails[tmdbId] = { ...fetched, detailsCheckedAt: new Date().toISOString() };
  if (++detailsResolvedSinceSave % 20 === 0) saveTmdbDetailsCache();
  return fetched.imdbId;
}

/**
 * Fills in per-movie primary-source details for catalog movies that don't
 * have them yet. This is the PRIMARY source's own pass: the release year is
 * shown for every movie whether or not any rating source is enabled, and
 * caches predating this (which carry an IMDb id but no year) are backfilled
 * without waiting for a secondary to touch each movie.
 *
 * Bounded per tick so a first run over a large catalog doesn't monopolise
 * the loop - the remaining movies are picked up on the following ticks.
 */
async function processPendingTmdbDetails() {
  if (!TMDB_API_KEY) return false;

  const pending = Object.keys(tmdbCatalog.movies).filter((id) => needsDetailsFetch(tmdbDetails[id]));
  if (pending.length === 0) return false;

  const batch = pending.slice(0, TMDB_DETAILS_BATCH_SIZE);
  setTmdbStatus("resolving_details", `Resolving release years and IMDb ids: 0 / ${pending.length}`, {
    processed: 0,
    total: pending.length,
  });

  let processed = 0;
  for (const id of batch) {
    if (forceTmdbRefresh) break; // a catalog refresh outranks this
    await ensureMovieDetails(id);
    processed++;
    broadcast("upsert", buildMovieView(id));
    await sleep(TMDB_REQUEST_DELAY_MS);
  }

  saveTmdbDetailsCache();
  const remaining = pending.length - processed;
  if (remaining > 0) {
    setTmdbStatus("resolving_details", `Resolving release years and IMDb ids: ${processed} / ${pending.length}`, {
      processed,
      total: pending.length,
    });
  } else {
    setTmdbStatus("idle", `Catalog up to date: ${Object.keys(tmdbCatalog.movies).length} movies on ${PROVIDER_NAME} (DE).`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Secondary source #1: OMDb (both figures second-hand, as a fallback).
//
// Everything below concerns OMDb alone. It reads the catalog and the IMDb id
// cache, and touches no other source's state - so a rate limit, an invalid
// key or an outage here delays OMDb's own fallback values and nothing else.
// With both scrapers enabled it can be left unconfigured entirely, which is
// the point: its 1000 requests a day then stop being anyone's problem.
// ---------------------------------------------------------------------------

/**
 * Flags OMDb ratings older than OMDB_REFRESH_INTERVAL_HOURS as due for a
 * re-check. Deliberately keeps the stored values visible until a fresh one
 * replaces them, rather than blanking the column meanwhile.
 */
function markStaleOmdbRatings() {
  const changed = markStale(omdbRatings.entries, Date.now(), OMDB_REFRESH_INTERVAL_MS);
  if (changed > 0) {
    debugLog(`[OMDb] ${changed} rating(s) marked stale (TTL ${OMDB_REFRESH_INTERVAL_HOURS}h), kept visible until rechecked`);
    saveOmdbCache();
  }
  return changed > 0;
}

/** Returns true if this pass did any work (so the engine loop knows not to idle-sleep). */
async function processPendingOmdb() {
  if (!OMDB_API_KEY) return false;
  if (Date.now() < omdbPausedUntil) return false; // backing off, see omdbPausedUntil

  // Never-checked movies first, stale refreshes after - a tight daily quota
  // should fill coverage gaps before re-confirming values already on screen.
  const { neverChecked, dueForRefresh } = splitPendingIds(omdbRatings.entries);
  const pendingIds = [...neverChecked, ...dueForRefresh];
  const neverCheckedTotal = neverChecked.length;
  if (pendingIds.length === 0) return false;

  let processed = 0;
  setOmdbStatus("checking_ratings", `Checking ratings: 0 / ${pendingIds.length}`, {
    processed: 0,
    total: pendingIds.length,
    pending: pendingIds.length,
  });

  for (const id of pendingIds) {
    // A manual TMDb sync was requested - the primary source outranks both
    // secondaries, so bail out and let the catalog refresh go first.
    if (forceTmdbRefresh) {
      debugLog("[OMDb] Pausing - a manual TMDb sync was requested");
      saveOmdbCache();
      saveTmdbDetailsCache();
      return true;
    }

    const entry = omdbRatings.entries[id];
    if (!entry) continue; // removed in the meantime via a catalog refresh

    const imdbId = await ensureMovieDetails(id);
    if (!imdbId) {
      // TMDb has no IMDb id for this movie, so OMDb can never answer for it.
      entry.rt = null;
      entry.metacritic = null;
      entry.checkedAt = new Date().toISOString();
      entry.needsRefresh = false;
      broadcast("upsert", buildMovieView(id));
      processed++;
    } else {
      try {
        const { rt, metacritic } = await fetchOmdbRatings(imdbId);
        entry.rt = rt;
        entry.metacritic = metacritic;
        entry.checkedAt = new Date().toISOString();
        entry.needsRefresh = false;
        broadcast("upsert", buildMovieView(id));
        processed++;
        if (processed % 20 === 0) saveOmdbCache();
        await sleep(OMDB_REQUEST_DELAY_MS);
      } catch (err) {
        if (err instanceof OmdbAuthError) {
          // Distinct from OmdbLimitError on purpose: an invalid/revoked key
          // will never resolve itself by waiting, unlike a daily limit.
          const remaining = pendingIds.length - processed;
          setOmdbStatus(
            "error",
            `${err.message} - fix OMDB_API_KEY, then use "Sync now" (${remaining} pending, retrying every ${OMDB_RETRY_INTERVAL_MINUTES} minute(s) meanwhile).`,
            { processed, total: pendingIds.length, pending: remaining }
          );
          saveOmdbCache();
          saveTmdbDetailsCache();
          console.error(`[OMDb] ${err.message}`);
          omdbPausedUntil = Date.now() + OMDB_RETRY_INTERVAL_MS;
          return true;
        }
        if (err instanceof OmdbLimitError) {
          const remaining = pendingIds.length - processed;
          // pendingIds is ordered never-checked-first, so anything beyond
          // neverCheckedTotal is only the optional stale-refresh tail. A
          // backlog of pure refreshes is a background nicety, not a problem
          // worth a red status.
          const remainingNeverChecked = Math.max(0, neverCheckedTotal - processed);
          if (remainingNeverChecked > 0) {
            setOmdbStatus(
              "waiting_for_limit_reset",
              `OMDb daily limit reached (${remaining} pending, ${remainingNeverChecked} never checked). Next attempt in ${OMDB_RETRY_INTERVAL_MINUTES} minute(s) ...`,
              { processed, total: pendingIds.length, pending: remaining }
            );
          } else {
            setOmdbStatus(
              "stale_refresh_pending",
              `Every movie has an OMDb rating; the daily limit was reached while refreshing ${remaining} stale one(s). Next attempt in ${OMDB_RETRY_INTERVAL_MINUTES} minute(s).`,
              { processed, total: pendingIds.length, pending: remaining }
            );
          }
          saveOmdbCache();
          saveTmdbDetailsCache();
          debugLog(`[OMDb] Limit reached, pausing OMDb for ${OMDB_RETRY_INTERVAL_MINUTES}min (${remaining} pending) - other sources carry on`);
          omdbPausedUntil = Date.now() + OMDB_RETRY_INTERVAL_MS;
          return true;
        }
        console.error(`OMDb error for movie ID ${id}:`, err.message);
        debugLog(`[OMDb] Error for ID ${id}: ${err.message}`);
      }
    }

    setOmdbStatus("checking_ratings", `Checking ratings: ${processed} / ${pendingIds.length}`, {
      processed,
      total: pendingIds.length,
      pending: pendingIds.length - processed,
    });
  }

  saveOmdbCache();
  saveTmdbDetailsCache();
  setOmdbStatus("idle", `All OMDb ratings up to date (${processed} checked).`, {
    lastFullSync: new Date().toISOString(),
    pending: 0,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Secondary source #2: Rotten Tomatoes (the tomatometer, scraped).
//
// A peer of the OMDb pass above, not a step inside it: its own cache, its
// own interval, its own status row, its own retry. It never calls OMDb, and
// OMDb's quota never applies to it.
// ---------------------------------------------------------------------------

/** RT's own staleness pass, on RT_REFRESH_INTERVAL_HOURS rather than OMDb's. */
function markStaleRtScores() {
  if (!RT_SCRAPE_ENABLED) return false;
  const changed = markStale(rtScores.entries, Date.now(), RT_REFRESH_INTERVAL_MS);
  if (changed > 0) {
    debugLog(`[RT] ${changed} tomatometer(s) marked stale (TTL ${RT_REFRESH_INTERVAL_HOURS}h), kept visible until rechecked`);
    saveRtCache();
  }
  return changed > 0;
}

/** Returns true if this pass did any work (so the engine loop knows not to idle-sleep). */
async function processPendingRt() {
  if (!RT_SCRAPE_ENABLED) return false;
  if (Date.now() < rtPausedUntil) return false; // backing off, see rtPausedUntil

  const { neverChecked, dueForRefresh } = splitPendingIds(rtScores.entries);
  const pendingIds = [...neverChecked, ...dueForRefresh];
  if (pendingIds.length === 0) return false;

  // Resolve the IMDb ids first (cheap and cached), then the RT slugs for the
  // whole pass in batches, so the per-movie loop only does the unavoidable
  // page fetch.
  const knownImdbIds = [];
  for (const id of pendingIds) {
    const imdbId = await ensureMovieDetails(id);
    if (imdbId) knownImdbIds.push(imdbId);
  }
  saveTmdbDetailsCache();

  // A failed lookup is a reason to slow down, not to stop: movies whose
  // slug is already cached are scraped anyway, and only the ones still
  // missing a mapping stay pending. Backing the whole source off here is
  // what made a single throttled query look like "Metacritic is down".
  const lookup = await resolveRtSlugs(knownImdbIds);
  const scrapable = pendingIds.filter((id) => {
    const imdbId = tmdbDetails[id]?.imdbId;
    return !imdbId || imdbId in rtSlugs;
  });

  if (!lookup.ok) {
    rtPausedUntil = Date.now() + (lookup.retryAfterMs ?? RT_RETRY_INTERVAL_MS);
    const waitMinutes = Math.round((rtPausedUntil - Date.now()) / 60000);
    const unresolved = pendingIds.length - scrapable.length;
    if (scrapable.length === 0) {
      // Nothing is mapped yet, so there is genuinely nothing to scrape.
      setRtStatus("error", `Wikidata (Rotten Tomatoes id lookup) failed: ${lookup.reason} - retrying in ${waitMinutes} minute(s).`, {
        pending: pendingIds.length,
      });
      return true;
    }
    debugLog(`[RT] Wikidata lookup failed (${lookup.reason}); scraping ${scrapable.length} already-mapped movie(s), ${unresolved} left pending`);
  }

  let processed = 0;
  setRtStatus("scraping", `Fetching tomatometers: 0 / ${scrapable.length}`, {
    processed: 0,
    total: scrapable.length,
    pending: pendingIds.length,
  });

  for (const id of scrapable) {
    if (forceTmdbRefresh) {
      debugLog("[RT] Pausing - a manual TMDb sync was requested");
      saveRtCache();
      return true;
    }

    const entry = rtScores.entries[id];
    if (!entry) continue; // removed in the meantime via a catalog refresh

    const imdbId = tmdbDetails[id]?.imdbId;
    const slug = imdbId ? rtSlugs[imdbId] : null;
    if (!slug) {
      // No IMDb id, or Wikidata knows no RT page for it: a definitive "no
      // tomatometer available", not a failed lookup.
      entry.tomatometer = null;
      entry.checkedAt = new Date().toISOString();
      entry.needsRefresh = false;
      broadcast("upsert", buildMovieView(id));
      processed++;
    } else {
      const { score, unavailable } = await fetchRtScore(imdbId);
      await sleep(RT_REQUEST_DELAY_MS); // deliberately slow: this is someone else's website
      if (unavailable) {
        // RT is throttling us or down. Leave this movie pending instead of
        // recording a "checked, no rating" we never confirmed.
        const remaining = pendingIds.length - processed;
        setRtStatus("error", `Rotten Tomatoes is currently unreachable (${remaining} pending). Next attempt in ${RT_RETRY_INTERVAL_MINUTES} minute(s).`, {
          processed,
          total: scrapable.length,
          pending: remaining,
        });
        saveRtCache();
        rtPausedUntil = Date.now() + RT_RETRY_INTERVAL_MS;
        return true;
      }
      entry.tomatometer = score;
      entry.checkedAt = new Date().toISOString();
      entry.needsRefresh = false;
      broadcast("upsert", buildMovieView(id));
      processed++;
      if (processed % 20 === 0) saveRtCache();
    }

    setRtStatus("scraping", `Fetching tomatometers: ${processed} / ${scrapable.length}`, {
      processed,
      total: scrapable.length,
      pending: pendingIds.length - processed,
    });
  }

  saveRtCache();
  const unmapped = pendingIds.length - scrapable.length;
  if (unmapped > 0) {
    // Partial pass: everything mapped is up to date, the rest is waiting on
    // Wikidata, not on Rotten Tomatoes. Said plainly rather than reported as
    // a finished sync.
    const waitMinutes = Math.max(1, Math.round((rtPausedUntil - Date.now()) / 60000));
    setRtStatus("error", `${processed} tomatometer(s) updated; ${unmapped} still need their Rotten Tomatoes id from Wikidata (retrying in ${waitMinutes} minute(s)).`, {
      pending: unmapped,
    });
    return true;
  }
  rtScores.lastFullSync = new Date().toISOString();
  setRtStatus("idle", `All tomatometers up to date (${processed} fetched).`, {
    lastSync: rtScores.lastFullSync,
    pending: 0,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Secondary source #3: Metacritic (the Metascore, scraped).
//
// A peer of the two passes above, not a step inside either: its own cache,
// its own interval, its own status row, its own retry. It never calls OMDb
// or RT, and neither one's failures apply to it.
// ---------------------------------------------------------------------------

/** Metacritic's own staleness pass, on MC_REFRESH_INTERVAL_HOURS. */
function markStaleMcScores() {
  if (!MC_SCRAPE_ENABLED) return false;
  const changed = markStale(mcScores.entries, Date.now(), MC_REFRESH_INTERVAL_MS);
  if (changed > 0) {
    debugLog(`[MC] ${changed} Metascore(s) marked stale (TTL ${MC_REFRESH_INTERVAL_HOURS}h), kept visible until rechecked`);
    saveMcCache();
  }
  return changed > 0;
}

/** Returns true if this pass did any work (so the engine loop knows not to idle-sleep). */
async function processPendingMc() {
  if (!MC_SCRAPE_ENABLED) return false;
  if (Date.now() < mcPausedUntil) return false; // backing off, see mcPausedUntil

  const { neverChecked, dueForRefresh } = splitPendingIds(mcScores.entries);
  const pendingIds = [...neverChecked, ...dueForRefresh];
  if (pendingIds.length === 0) return false;

  // Resolve the IMDb ids first (cheap and cached), then the Metacritic slugs
  // for the whole pass in batches, so the per-movie loop only does the
  // unavoidable page fetch.
  const knownImdbIds = [];
  for (const id of pendingIds) {
    const imdbId = await ensureMovieDetails(id);
    if (imdbId) knownImdbIds.push(imdbId);
  }
  saveTmdbDetailsCache();

  // As in the RT pass: a failed lookup costs the unmapped movies, not the
  // whole source.
  const lookup = await resolveMcSlugs(knownImdbIds);
  const scrapable = pendingIds.filter((id) => {
    const imdbId = tmdbDetails[id]?.imdbId;
    return !imdbId || imdbId in mcSlugs;
  });

  if (!lookup.ok) {
    mcPausedUntil = Date.now() + (lookup.retryAfterMs ?? MC_RETRY_INTERVAL_MS);
    const waitMinutes = Math.round((mcPausedUntil - Date.now()) / 60000);
    const unresolved = pendingIds.length - scrapable.length;
    if (scrapable.length === 0) {
      setMcStatus("error", `Wikidata (Metacritic id lookup) failed: ${lookup.reason} - retrying in ${waitMinutes} minute(s).`, {
        pending: pendingIds.length,
      });
      return true;
    }
    debugLog(`[MC] Wikidata lookup failed (${lookup.reason}); scraping ${scrapable.length} already-mapped movie(s), ${unresolved} left pending`);
  }

  let processed = 0;
  setMcStatus("scraping", `Fetching Metascores: 0 / ${scrapable.length}`, {
    processed: 0,
    total: scrapable.length,
    pending: pendingIds.length,
  });

  for (const id of scrapable) {
    if (forceTmdbRefresh) {
      debugLog("[MC] Pausing - a manual TMDb sync was requested");
      saveMcCache();
      return true;
    }

    const entry = mcScores.entries[id];
    if (!entry) continue; // removed in the meantime via a catalog refresh

    const imdbId = tmdbDetails[id]?.imdbId;
    const slug = imdbId ? mcSlugs[imdbId] : null;
    if (!slug) {
      // No IMDb id, or Wikidata knows no Metacritic page for it: a
      // definitive "no Metascore available", not a failed lookup.
      entry.metascore = null;
      entry.checkedAt = new Date().toISOString();
      entry.needsRefresh = false;
      broadcast("upsert", buildMovieView(id));
      processed++;
    } else {
      const { score, unavailable } = await fetchMetascore(imdbId);
      await sleep(MC_REQUEST_DELAY_MS); // deliberately slow: this is someone else's website
      if (unavailable) {
        // Metacritic is throttling us or down. Leave this movie pending
        // instead of recording a "checked, no rating" we never confirmed.
        const remaining = pendingIds.length - processed;
        setMcStatus("error", `Metacritic is currently unreachable (${remaining} pending). Next attempt in ${MC_RETRY_INTERVAL_MINUTES} minute(s).`, {
          processed,
          total: scrapable.length,
          pending: remaining,
        });
        saveMcCache();
        mcPausedUntil = Date.now() + MC_RETRY_INTERVAL_MS;
        return true;
      }
      entry.metascore = score;
      entry.checkedAt = new Date().toISOString();
      entry.needsRefresh = false;
      broadcast("upsert", buildMovieView(id));
      processed++;
      if (processed % 20 === 0) saveMcCache();
    }

    setMcStatus("scraping", `Fetching Metascores: ${processed} / ${scrapable.length}`, {
      processed,
      total: scrapable.length,
      pending: pendingIds.length - processed,
    });
  }

  saveMcCache();
  const unmapped = pendingIds.length - scrapable.length;
  if (unmapped > 0) {
    const waitMinutes = Math.max(1, Math.round((mcPausedUntil - Date.now()) / 60000));
    setMcStatus("error", `${processed} Metascore(s) updated; ${unmapped} still need their Metacritic id from Wikidata (retrying in ${waitMinutes} minute(s)).`, {
      pending: unmapped,
    });
    return true;
  }
  mcScores.lastFullSync = new Date().toISOString();
  setMcStatus("idle", `All Metascores up to date (${processed} fetched).`, {
    lastSync: mcScores.lastFullSync,
    pending: 0,
  });
  return true;
}

/**
 * One tick: the primary source first (it decides which movies exist), then
 * every secondary source, each in its OWN try/catch so no source can take
 * another down with it. Adding a further rating source means adding one
 * more block here - not threading it through an existing one.
 */
async function backgroundEngineLoop() {
  for (;;) {
    let didWork = false;
    let catalogRefreshed = false;

    // --- Primary: TMDb ---
    try {
      if (!TMDB_API_KEY) {
        setTmdbStatus("error", "TMDB_API_KEY is not set - engine paused.");
      } else {
        const tmdbDue =
          forceTmdbRefresh || tmdbCatalog.lastRefresh === 0 || Date.now() - tmdbCatalog.lastRefresh >= TMDB_REFRESH_INTERVAL_MS;
        if (tmdbDue) {
          forceTmdbRefresh = false;
          await refreshTmdbCatalog();
          catalogRefreshed = true;
          didWork = true;
        } else {
          didWork = (await processPendingTmdbDetails()) || didWork;
        }
      }
    } catch (err) {
      console.error("TMDb engine error:", err);
      debugLog(`TMDb engine error: ${err.stack || err.message}`);
      setTmdbStatus("error", `Engine error: ${err.message}`);
    }

    // The secondaries only run on ticks where the catalog didn't just
    // change under them; each is otherwise entirely independent of the
    // others, in its own interval, its own status and its own failure mode.
    if (!catalogRefreshed && TMDB_API_KEY) {
      // --- Secondary: OMDb ---
      try {
        markStaleOmdbRatings();
        didWork = (await processPendingOmdb()) || didWork;
      } catch (err) {
        console.error("OMDb engine error:", err);
        debugLog(`OMDb engine error: ${err.stack || err.message}`);
        setOmdbStatus("error", `OMDb error: ${err.message}`);
      }

      // --- Secondary: Rotten Tomatoes ---
      try {
        markStaleRtScores();
        didWork = (await processPendingRt()) || didWork;
      } catch (err) {
        console.error("RT engine error:", err);
        debugLog(`RT engine error: ${err.stack || err.message}`);
        setRtStatus("error", `Rotten Tomatoes error: ${err.message}`);
      }

      // --- Secondary: Metacritic ---
      try {
        markStaleMcScores();
        didWork = (await processPendingMc()) || didWork;
      } catch (err) {
        console.error("Metacritic engine error:", err);
        debugLog(`Metacritic engine error: ${err.stack || err.message}`);
        setMcStatus("error", `Metacritic error: ${err.message}`);
      }
    }

    // --- Secondary: Trakt (watched status, not a rating source) ---
    try {
      didWork = (await maybeSyncTrakt()) || didWork;
    } catch (err) {
      console.error("Trakt engine error:", err);
      debugLog(`Trakt engine error: ${err.stack || err.message}`);
    }

    if (!didWork) {
      await sleepOrWake(ENGINE_IDLE_MS);
    }
  }
}

backgroundEngineLoop();

app.listen(PORT, () => {
  console.log(`prime-rt-finder running on port ${PORT}${DEBUG_MODE ? " (DEBUG_MODE active)" : ""}`);
});
