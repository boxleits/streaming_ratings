import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { OmdbLimitError, isOmdbLimitResponse, parseOmdbPayload } from "./lib/omdb.js";
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
const OMDB_REFRESH_INTERVAL_HOURS = parseFloat(process.env.OMDB_REFRESH_INTERVAL_HOURS || "168");
const ENGINE_IDLE_MS = parseInt(process.env.ENGINE_IDLE_MS || "15000", 10);
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "data");
const PROVIDER_NAME = process.env.PROVIDER_NAME || "Amazon Prime Video";
const DEBUG_MODE = /^(1|true|yes)$/i.test(process.env.DEBUG_MODE || "");

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
// Two separate, provider-specific caches:
//  - tmdbCatalog: title/year/genres/link, fully reloaded on an interval of
//    TMDB_REFRESH_INTERVAL_HOURS. The switch happens ATOMICALLY (see below).
//  - omdbRatings: RT and Metacritic rating per movie, "TODO" until checked,
//    individually rechecked after OMDB_REFRESH_INTERVAL_HOURS.
// ---------------------------------------------------------------------------
let tmdbCatalog = { movies: {}, lastRefresh: 0 };
let omdbRatings = { entries: {}, lastFullSync: null };
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

loadTmdbCache();
loadOmdbCache();

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
  const rating = omdbRatings.entries[id] || { rt: "TODO", metacritic: "TODO" };
  let watched = "N/A"; // Trakt not connected, or this movie's IMDb id isn't known yet
  if (TRAKT_CONFIGURED && traktAuth && rating.imdbId) {
    watched = traktWatchedSet.has(rating.imdbId) ? "watched" : "unseen";
  }
  return {
    id,
    title: cat.title,
    year: cat.year,
    genres: cat.genres,
    tmdbUrl: cat.tmdbUrl,
    rt: rating.rt,
    metacritic: rating.metacritic,
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
  omdb: { phase: "idle", message: "Not started yet.", updatedAt: null, lastFullSync: null, pending: 0 },
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
setOmdbStatus("idle", omdbRatings.lastFullSync ? "Ratings loaded from cache." : "No ratings checked yet.");
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

app.post("/api/omdb/refresh", (req, res) => {
  if (!OMDB_API_KEY) {
    return res.status(400).json({ error: "OMDB_API_KEY is not set." });
  }
  if (engineStatus.omdb.phase === "checking_ratings" || engineStatus.omdb.phase === "waiting_for_limit_reset") {
    return res.json({ ok: true, alreadyRunning: true });
  }
  const ids = Object.keys(omdbRatings.entries);
  for (const id of ids) {
    omdbRatings.entries[id].rt = "TODO";
    omdbRatings.entries[id].metacritic = "TODO";
    omdbRatings.entries[id].checkedAt = null;
  }
  saveOmdbCache();
  broadcast("ratings_reset", { ids });
  setOmdbStatus("idle", `Manual sync triggered (${ids.length} movies will be rechecked).`, {
    pending: ids.length,
  });
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

async function fetchImdbId(tmdbMovieId) {
  const url = `${TMDB_BASE}/movie/${tmdbMovieId}/external_ids?api_key=${TMDB_API_KEY}`;
  const t0 = Date.now();
  debugLog(`TMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  debugLog(`TMDb <- ${r.status} (${Date.now() - t0}ms) [external_ids ${tmdbMovieId}]`);
  if (!r.ok) return null;
  const data = await r.json();
  return data.imdb_id || null;
}

async function fetchOmdbRatings(imdbId) {
  const url = `${OMDB_BASE}?i=${encodeURIComponent(imdbId)}&apikey=${OMDB_API_KEY}`;
  const t0 = Date.now();
  debugLog(`OMDb GET ${maskUrl(url)}`);
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  debugLog(`OMDb <- ${r.status} (${Date.now() - t0}ms) [${imdbId}] Response=${data?.Response} Error=${data?.Error ?? "-"}`);

  if (isOmdbLimitResponse(r.status, data)) {
    const detail = data && data.Error ? `"${data.Error}"` : `HTTP ${r.status}`;
    throw new OmdbLimitError(`OMDb daily limit reached: ${detail}`);
  }

  return parseOmdbPayload(r.ok, data);
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

  for (const id of newIds) {
    if (!omdbRatings.entries[id]) {
      omdbRatings.entries[id] = { imdbId: null, rt: "TODO", metacritic: "TODO", checkedAt: null };
    }
  }
  for (const id of previousIds) {
    if (!newIds.has(id)) delete omdbRatings.entries[id];
  }

  saveTmdbCache();
  saveOmdbCache();

  debugLog(`[TMDb] Catalog refresh done: ${newIds.size} movies (${Date.now() - t0}ms)`);
  setTmdbStatus("idle", `Catalog up to date: ${newIds.size} movies on ${PROVIDER_NAME} (DE).`);

  // All connected clients jump to the new state in one go.
  broadcast("snapshot", { movies: buildAllMoviesView() });
}

/** Resets ratings older than OMDB_REFRESH_INTERVAL_HOURS back to "TODO". */
function markStaleRatings() {
  const now = Date.now();
  let changed = 0;
  for (const entry of Object.values(omdbRatings.entries)) {
    if (entry.checkedAt && now - new Date(entry.checkedAt).getTime() >= OMDB_REFRESH_INTERVAL_MS) {
      entry.rt = "TODO";
      entry.metacritic = "TODO";
      entry.checkedAt = null;
      changed++;
    }
  }
  if (changed > 0) {
    debugLog(`[OMDb] ${changed} rating(s) marked stale (TTL ${OMDB_REFRESH_INTERVAL_HOURS}h)`);
    saveOmdbCache();
  }
  return changed > 0;
}

async function processPendingRatings() {
  if (!OMDB_API_KEY) return false;

  const pendingIds = Object.keys(omdbRatings.entries).filter((id) => omdbRatings.entries[id].rt === "TODO");
  if (pendingIds.length === 0) return false;

  let processed = 0;
  setOmdbStatus("checking_ratings", `Checking ratings: 0 / ${pendingIds.length}`, {
    processed: 0,
    total: pendingIds.length,
    pending: pendingIds.length,
  });

  for (const id of pendingIds) {
    // A manual TMDb sync was requested (see /api/tmdb/refresh) - bail out
    // now instead of finishing the entire (potentially long) OMDb pass
    // first. Without this check, "Sync now" for TMDb could silently sit
    // unnoticed for minutes (or up to OMDB_RETRY_INTERVAL_MINUTES, if
    // currently waiting out a rate limit) behind an in-progress OMDb run,
    // since wakeEngine() only interrupts the engine's *idle* wait, not an
    // active processing pass like this one.
    if (forceTmdbRefresh) {
      debugLog("[OMDb] Pausing rating checks - a manual TMDb sync was requested");
      saveOmdbCache();
      return true;
    }

    const entry = omdbRatings.entries[id];
    if (!entry) continue; // removed in the meantime via a catalog refresh

    if (!entry.imdbId) {
      entry.imdbId = await fetchImdbId(id);
    }

    if (!entry.imdbId) {
      entry.rt = null;
      entry.metacritic = null;
      entry.checkedAt = new Date().toISOString();
      broadcast("upsert", buildMovieView(id));
      processed++;
    } else {
      try {
        const { rt, metacritic } = await fetchOmdbRatings(entry.imdbId);
        entry.rt = rt;
        entry.metacritic = metacritic;
        entry.checkedAt = new Date().toISOString();
        broadcast("upsert", buildMovieView(id));
        processed++;
        if (processed % 20 === 0) saveOmdbCache();
        await sleep(OMDB_REQUEST_DELAY_MS);
      } catch (err) {
        if (err instanceof OmdbLimitError) {
          const remaining = pendingIds.length - processed;
          setOmdbStatus(
            "waiting_for_limit_reset",
            `OMDb daily limit reached (${remaining} pending). Next attempt in ${OMDB_RETRY_INTERVAL_MINUTES} minute(s) ...`,
            { processed, total: pendingIds.length, pending: remaining }
          );
          saveOmdbCache();
          debugLog(`[OMDb] Limit reached, waiting ${OMDB_RETRY_INTERVAL_MINUTES}min (${remaining} pending)`);
          // Wakeable: a manual TMDb sync (or, in principle, a future
          // manual OMDb retry) can cut this wait short instead of forcing
          // a full OMDB_RETRY_INTERVAL_MINUTES wait first.
          await sleepOrWake(OMDB_RETRY_INTERVAL_MS);
          return true; // the next engine tick retries the remaining TODOs (or prioritizes the TMDb sync)
        }
        console.error(`Error for movie ID ${id}:`, err.message);
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
  setOmdbStatus("idle", `All ratings up to date (${processed} checked).`, {
    lastFullSync: new Date().toISOString(),
    pending: 0,
  });
  return true;
}

async function backgroundEngineLoop() {
  for (;;) {
    let didWork = false;
    try {
      if (!TMDB_API_KEY) {
        setTmdbStatus("error", "TMDB_API_KEY is not set - engine paused.");
      } else {
        const tmdbDue =
          forceTmdbRefresh || tmdbCatalog.lastRefresh === 0 || Date.now() - tmdbCatalog.lastRefresh >= TMDB_REFRESH_INTERVAL_MS;

        if (tmdbDue) {
          forceTmdbRefresh = false;
          await refreshTmdbCatalog();
          didWork = true;
        } else {
          markStaleRatings();
          const processed = await processPendingRatings();
          didWork = didWork || processed;
        }
      }
    } catch (err) {
      console.error("Engine error:", err);
      debugLog(`Engine error: ${err.stack || err.message}`);
      setTmdbStatus("error", `Engine error: ${err.message}`);
    }

    // Deliberately a separate try/catch: a Trakt failure (e.g. a revoked
    // token) must never interrupt TMDb/OMDb processing above.
    try {
      const traktDidWork = await maybeSyncTrakt();
      didWork = didWork || traktDidWork;
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
