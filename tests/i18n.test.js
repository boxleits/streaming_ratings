import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getStrings,
  localizePhaseMessage,
  formatLocalizedDate,
  formatRatingTooltip,
  buildTmdbMovieUrl,
  projectMovieForLocale,
  getStoredLanguage,
  setStoredLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} from "../public/js/i18n.js";

test("getStrings: falls back to English for an unknown language", () => {
  const strings = getStrings("fr");
  assert.equal(strings, getStrings("en"));
});

test("localizePhaseMessage: builds a template-based message from structured status data", () => {
  const msg = localizePhaseMessage("omdb", { phase: "checking_ratings", processed: 3, total: 10 }, "en");
  assert.equal(msg, "Checking ratings: 3 / 10");
});

test("localizePhaseMessage: same phase renders differently per language", () => {
  const en = localizePhaseMessage("omdb", { phase: "waiting_for_limit_reset", pending: 5 }, "en");
  const de = localizePhaseMessage("omdb", { phase: "waiting_for_limit_reset", pending: 5 }, "de");
  assert.match(en, /pending/);
  assert.match(de, /ausstehend/);
  assert.notEqual(en, de);
});

test("localizePhaseMessage: falls back to the raw server message for phases without a template (e.g. error)", () => {
  const msg = localizePhaseMessage("tmdb", { phase: "error", message: "TMDB_API_KEY is not set - engine paused." }, "de");
  assert.equal(msg, "TMDB_API_KEY is not set - engine paused.");
});

test("localizePhaseMessage: supports the trakt provider too, per language", () => {
  const en = localizePhaseMessage("trakt", { phase: "awaiting_authorization" }, "en");
  const de = localizePhaseMessage("trakt", { phase: "awaiting_authorization" }, "de");
  assert.match(en, /approve/i);
  assert.match(de, /best.tigung/i);
  assert.notEqual(en, de);
});

test("formatLocalizedDate: returns the localized 'never' placeholder for a missing date", () => {
  assert.equal(formatLocalizedDate(null, "en"), "never");
  assert.equal(formatLocalizedDate(null, "de"), "nie");
});

test("formatLocalizedDate: formats a real date without throwing, for both languages", () => {
  const iso = "2026-08-14T10:15:00.000Z";
  assert.equal(typeof formatLocalizedDate(iso, "en"), "string");
  assert.equal(typeof formatLocalizedDate(iso, "de"), "string");
});

test("formatRatingTooltip: never-checked (no checkedAt) uses the dedicated placeholder", () => {
  assert.equal(formatRatingTooltip(null, false, "en"), "Not checked against OMDb yet");
  assert.equal(formatRatingTooltip(undefined, false, "de"), "Noch nicht bei OMDb geprüft");
});

test("formatRatingTooltip: a fresh, up-to-date rating shows just the checked date", () => {
  const iso = "2026-08-14T10:15:00.000Z";
  assert.match(formatRatingTooltip(iso, false, "en"), /^OMDb rating checked: /);
  assert.doesNotMatch(formatRatingTooltip(iso, false, "en"), /refresh pending/);
});

test("formatRatingTooltip: a stale, due-for-refresh rating notes that a refresh is pending", () => {
  const iso = "2026-08-14T10:15:00.000Z";
  assert.match(formatRatingTooltip(iso, true, "en"), /refresh pending/);
  assert.match(formatRatingTooltip(iso, true, "de"), /Aktualisierung ausstehend/);
});

test("buildTmdbMovieUrl: uses the matching TMDb locale per UI language", () => {
  assert.equal(buildTmdbMovieUrl("603", "en"), "https://www.themoviedb.org/movie/603?language=en-US");
  assert.equal(buildTmdbMovieUrl("603", "de"), "https://www.themoviedb.org/movie/603?language=de-DE");
});

test("projectMovieForLocale: picks the requested language's title/genres", () => {
  const movie = {
    id: "603",
    title: { en: "The Matrix", de: "Matrix" },
    genres: { en: "Action, Science Fiction", de: "Action, Science Fiction" },
    year: "1999",
    rt: 83,
    metacritic: 73,
    ratingCheckedAt: "2026-08-14T10:15:00.000Z",
    ratingNeedsRefresh: true,
    watched: "watched",
  };
  const en = projectMovieForLocale(movie, "en");
  const de = projectMovieForLocale(movie, "de");
  assert.equal(en.title, "The Matrix");
  assert.equal(de.title, "Matrix");
  assert.equal(en.rt, 83); // language-independent fields pass through unchanged
  assert.equal(de.rt, 83);
  assert.equal(en.watched, "watched");
  assert.equal(de.watched, "watched");
  assert.equal(en.ratingCheckedAt, "2026-08-14T10:15:00.000Z");
  assert.equal(en.ratingNeedsRefresh, true);
});

test("projectMovieForLocale: falls back to English, then any available language, if requested language is missing", () => {
  const onlyEnglish = { id: "1", title: { en: "Only English Title" }, genres: { en: "Drama" }, year: "2020" };
  assert.equal(projectMovieForLocale(onlyEnglish, "de").title, "Only English Title");

  const onlyGerman = { id: "2", title: { de: "Nur Deutscher Titel" }, genres: { de: "Drama" }, year: "2020" };
  assert.equal(projectMovieForLocale(onlyGerman, "en").title, "Nur Deutscher Titel");
});

test("projectMovieForLocale: tolerates already-flat string title/genres (legacy cache data)", () => {
  const legacy = { id: "3", title: "Legacy Title", genres: "Drama", year: "2019" };
  const projected = projectMovieForLocale(legacy, "de");
  assert.equal(projected.title, "Legacy Title");
  assert.equal(projected.genres, "Drama");
});

function fakeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
    _dump: () => store,
  };
}

test("getStoredLanguage: returns the persisted choice when present and supported", () => {
  const storage = fakeStorage({ "primeRtFinder.lang": "de" });
  assert.equal(getStoredLanguage(storage, { language: "en-US" }), "de");
});

test("getStoredLanguage: falls back to the browser language when nothing is stored", () => {
  const storage = fakeStorage();
  assert.equal(getStoredLanguage(storage, { language: "de-AT" }), "de");
});

test("getStoredLanguage: falls back to the default language for an unsupported browser language", () => {
  const storage = fakeStorage();
  assert.equal(getStoredLanguage(storage, { language: "fr-FR" }), DEFAULT_LANGUAGE);
});

test("getStoredLanguage: ignores an unsupported stored value and falls back", () => {
  const storage = fakeStorage({ "primeRtFinder.lang": "xx" });
  assert.equal(getStoredLanguage(storage, { language: "de-DE" }), "de");
});

test("getStoredLanguage: never throws when storage access itself throws (e.g. private browsing)", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("storage disabled");
    },
  };
  assert.equal(getStoredLanguage(throwingStorage, { language: "de-DE" }), "de");
});

test("setStoredLanguage: writes the choice under the expected key", () => {
  const storage = fakeStorage();
  setStoredLanguage(storage, "de");
  assert.equal(storage._dump()["primeRtFinder.lang"], "de");
});

test("setStoredLanguage: never throws when storage.setItem throws", () => {
  const throwingStorage = {
    setItem: () => {
      throw new Error("quota exceeded");
    },
  };
  assert.doesNotThrow(() => setStoredLanguage(throwingStorage, "en"));
});

test("SUPPORTED_LANGUAGES contains exactly the languages the app currently offers", () => {
  assert.deepEqual(SUPPORTED_LANGUAGES, ["en", "de"]);
});
