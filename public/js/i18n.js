// UI chrome translations + language persistence. Pure, DOM-free logic
// where possible, so it's unit-testable; only getStoredLanguage/
// setStoredLanguage touch localStorage (guarded, safe to call in tests
// with a stubbed storage).

export const SUPPORTED_LANGUAGES = ["en", "de"];
export const DEFAULT_LANGUAGE = "en";
const STORAGE_KEY = "primeRtFinder.lang";

const STRINGS = {
  en: {
    connecting: "Connecting ...",
    connectionLost: "Connection lost, retrying ...",
    syncNow: "Sync now",
    clearFilters: "Clear column filters",
    colTitle: "Title",
    colGenres: "Genre(s)",
    colYear: "Year",
    colRt: "RT %",
    colMeta: "Meta",
    colWatched: "Watched",
    filterPlaceholder: "filter ...",
    filterYearPlaceholder: "e.g. 2021",
    filterMinPlaceholder: "e.g. 60 = min.",
    emptyDefault: "Connecting to the server ...",
    emptyNoMatch: "No rows match the current column filters.",
    moviesTotal: (n) => `${n} movies total`,
    visibleAfterFilters: (n) => `${n} visible after filters`,
    loadMore: (shown, total) => `Load more (showing ${shown} of ${total})`,
    never: "never",
    lastLabel: (date) => `Last: ${date}`,
    moviesCountSuffix: (n) => `${n} movies`,
    lastFullSyncLabel: (date) => `Last full sync: ${date}`,
    pendingSuffix: (n) => `${n} pending`,
    ratingNeverChecked: "Not checked against OMDb yet",
    ratingChecked: (date) => `OMDb rating checked: ${date}`,
    ratingCheckedStale: (date) => `OMDb rating checked: ${date} (refresh pending)`,
    footerLine1:
      "Data sources: TMDb (catalog, availability, genres, movie page), OMDb (Rotten Tomatoes & Metacritic ratings).",
    footerLine2: "TODO = not checked yet \u00b7 N/A = checked, no rating available.",
    footerLine3:
      'For the RT / Metacritic columns: a number in the filter (e.g. "60") shows only movies with at least that rating; text (e.g. "N/A") filters as a substring.',
    footerLine4: "Click a column header to sort \u00b7 The catalog sync keeps running in the background even without the page open.",
    subtitle: "Amazon Prime Video (DE) \u00b7 RT & Metacritic ratings, continuously updated in the background",
    connectTrakt: "Connect Trakt",
    disconnectTrakt: "Disconnect",
    traktGoTo: (url, code) => `Go to ${url} and enter code: ${code}`,
    traktExpiresIn: (mins) => `expires in ${mins} min`,
    tmdbPhase: {
      idle: () => "Up to date",
      refreshing: (d) =>
        d.totalPages ? `Loading catalog (${d.language ?? ""}), page ${d.page}/${d.totalPages} ...` : "Refreshing catalog ...",
    },
    omdbPhase: {
      idle: () => "Up to date",
      checking_ratings: (d) => `Checking ratings: ${d.processed ?? 0} / ${d.total ?? 0}`,
      waiting_for_limit_reset: (d) => `Waiting for OMDb daily limit reset (${d.pending ?? 0} pending) ...`,
      stale_refresh_pending: () => "Every movie has a rating - refreshing stale ones in the background",
    },
    traktPhase: {
      unauthorized: () => "Not connected",
      awaiting_authorization: () => "Waiting for you to approve on trakt.tv ...",
      syncing: () => "Syncing watched history ...",
      idle: () => "Connected",
    },
  },
  de: {
    connecting: "Verbinde ...",
    connectionLost: "Verbindung unterbrochen, versuche erneut ...",
    syncNow: "Jetzt abgleichen",
    clearFilters: "Spaltenfilter zur\u00fccksetzen",
    colTitle: "Filmtitel",
    colGenres: "Genre(s)",
    colYear: "Jahr",
    colRt: "RT %",
    colMeta: "Meta",
    colWatched: "Gesehen",
    filterPlaceholder: "filtern ...",
    filterYearPlaceholder: "z.B. 2021",
    filterMinPlaceholder: "z.B. 60 = min.",
    emptyDefault: "Verbinde mit dem Server ...",
    emptyNoMatch: "Keine Zeilen passen zu den aktuellen Spaltenfiltern.",
    moviesTotal: (n) => `${n} Filme insgesamt`,
    visibleAfterFilters: (n) => `${n} nach Filter sichtbar`,
    loadMore: (shown, total) => `Mehr laden (${shown} von ${total} angezeigt)`,
    never: "nie",
    lastLabel: (date) => `Zuletzt: ${date}`,
    moviesCountSuffix: (n) => `${n} Filme`,
    lastFullSyncLabel: (date) => `Zuletzt vollst\u00e4ndig: ${date}`,
    pendingSuffix: (n) => `${n} ausstehend`,
    ratingNeverChecked: "Noch nicht bei OMDb gepr\u00fcft",
    ratingChecked: (date) => `OMDb-Bewertung gepr\u00fcft: ${date}`,
    ratingCheckedStale: (date) => `OMDb-Bewertung gepr\u00fcft: ${date} (Aktualisierung ausstehend)`,
    footerLine1:
      "Datenquellen: TMDb (Katalog, Verf\u00fcgbarkeit, Genres, Filmseite), OMDb (Rotten-Tomatoes- & Metacritic-Wertung).",
    footerLine2: "TODO = noch nicht gepr\u00fcft \u00b7 N/A = gepr\u00fcft, keine Wertung vorhanden.",
    footerLine3:
      'Bei den Spalten RT / Metacritic: eine Zahl im Filter (z.\u00a0B. "60") zeigt nur Filme mit mindestens dieser Wertung; Text (z.\u00a0B. "N/A") filtert als Teilstring.',
    footerLine4: "Spaltenkopf klicken zum Sortieren \u00b7 Der Katalog-Abgleich l\u00e4uft im Hintergrund weiter, auch ohne Seitenaufruf.",
    subtitle: "Amazon Prime Video (DE) \u00b7 RT- & Metacritic-Wertung, laufend im Hintergrund aktualisiert",
    connectTrakt: "Trakt verbinden",
    disconnectTrakt: "Trennen",
    traktGoTo: (url, code) => `Gehe zu ${url} und gib den Code ein: ${code}`,
    traktExpiresIn: (mins) => `l\u00e4uft ab in ${mins} Min.`,
    tmdbPhase: {
      idle: () => "Aktuell",
      refreshing: (d) =>
        d.totalPages ? `Katalog laden (${d.language ?? ""}), Seite ${d.page}/${d.totalPages} ...` : "Katalog wird aktualisiert ...",
    },
    omdbPhase: {
      idle: () => "Aktuell",
      checking_ratings: (d) => `Pr\u00fcfe Bewertungen: ${d.processed ?? 0} / ${d.total ?? 0}`,
      waiting_for_limit_reset: (d) => `Warte auf OMDb-Limit-Reset (${d.pending ?? 0} ausstehend) ...`,
      stale_refresh_pending: () => "Alle Filme bewertet \u2013 aktualisiere veraltete Bewertungen im Hintergrund",
    },
    traktPhase: {
      unauthorized: () => "Nicht verbunden",
      awaiting_authorization: () => "Warte auf Best\u00e4tigung bei trakt.tv ...",
      syncing: () => "Synchronisiere Sehhistorie ...",
      idle: () => "Verbunden",
    },
  },
};

/** Returns the translation table for a language, falling back to English. */
export function getStrings(lang) {
  return STRINGS[lang] || STRINGS[DEFAULT_LANGUAGE];
}

/**
 * Builds the display text for an engine status phase (tmdb, omdb, or
 * trakt), falling back to the raw server-provided message for phases
 * without a dedicated template (e.g. "error") - technical error text is
 * shown as-is regardless of UI language, since it may be an arbitrary
 * upstream error.
 */
export function localizePhaseMessage(provider, statusData, lang) {
  const strings = getStrings(lang);
  const table = { tmdb: strings.tmdbPhase, omdb: strings.omdbPhase, trakt: strings.traktPhase }[provider];
  const fn = table && table[statusData.phase];
  if (fn) return fn(statusData);
  return statusData.message || "";
}

/**
 * Builds the tooltip text for an RT/Metacritic cell: when its rating was
 * last checked against OMDb, or that it's never been checked, plus a note
 * when a background refresh of an already-known rating is pending (not a
 * coverage gap - see splitPendingOmdbIds/selectPendingOmdbIds in
 * lib/omdb.js for why that's a distinct, lower-urgency state).
 */
export function formatRatingTooltip(checkedAtIso, needsRefresh, lang) {
  const strings = getStrings(lang);
  if (!checkedAtIso) return strings.ratingNeverChecked;
  const date = formatLocalizedDate(checkedAtIso, lang);
  return needsRefresh ? strings.ratingCheckedStale(date) : strings.ratingChecked(date);
}

/** Formats an ISO date string per the given UI language, or "never"/"nie" if absent. */
export function formatLocalizedDate(iso, lang) {
  const strings = getStrings(lang);
  if (!iso) return strings.never;
  const d = new Date(iso);
  const locale = lang === "de" ? "de-DE" : "en-GB";
  return d.toLocaleString(locale, { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Builds a TMDb movie page URL localized to the given UI language. */
export function buildTmdbMovieUrl(id, lang) {
  const tmdbLocale = lang === "de" ? "de-DE" : "en-US";
  return `https://www.themoviedb.org/movie/${id}?language=${tmdbLocale}`;
}

/**
 * Projects a raw, multi-language movie record (as received from the
 * server: `title`/`genres` are objects keyed by language) into a flat,
 * single-language view for display/filtering/sorting - falls back to
 * English, then to any available language, if the requested one is
 * missing for a given movie. `rt`/`metacritic`/`watched` are already
 * language-independent and pass through unchanged.
 */
export function projectMovieForLocale(movie, lang) {
  const pick = (field) => {
    if (!field) return "";
    if (typeof field === "string") return field; // already flat (e.g. in older cached data)
    return field[lang] ?? field[DEFAULT_LANGUAGE] ?? Object.values(field)[0] ?? "";
  };
  return {
    id: movie.id,
    title: pick(movie.title),
    genres: pick(movie.genres),
    year: movie.year,
    rt: movie.rt,
    metacritic: movie.metacritic,
    ratingCheckedAt: movie.ratingCheckedAt,
    ratingNeedsRefresh: movie.ratingNeedsRefresh,
    watched: movie.watched,
    tmdbUrl: buildTmdbMovieUrl(movie.id, lang),
  };
}

/** Reads the persisted language choice, defaulting to the browser's own language, then English. */
export function getStoredLanguage(storage, navigatorRef) {
  try {
    const stored = storage?.getItem?.(STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.includes(stored)) return stored;
  } catch (err) {
    /* storage unavailable (e.g. private browsing) - fall through to auto-detect */
  }
  const browserLang = (navigatorRef?.language || "").slice(0, 2).toLowerCase();
  return SUPPORTED_LANGUAGES.includes(browserLang) ? browserLang : DEFAULT_LANGUAGE;
}

/** Persists a language choice; silently ignores storage failures. */
export function setStoredLanguage(storage, lang) {
  try {
    storage?.setItem?.(STORAGE_KEY, lang);
  } catch (err) {
    /* storage unavailable (e.g. private browsing) - the in-memory choice still applies for this session */
  }
}
