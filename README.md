# Prime × Tomatoes

A web app that loads the **Amazon Prime Video catalog (Germany, included
in the subscription)** via the official **TMDb API** and checks each title
against the **OMDb API** for its **Rotten Tomatoes** and **Metacritic**
rating.

A **persistent background engine** runs as soon as the server starts —
regardless of whether a browser is currently connected:

- The **TMDb catalog** (title, year, genres, link) is fully reloaded on
  its own configurable interval (default: daily).
- Each **rating source** (OMDb, and the optional Rotten Tomatoes scraper)
  checks movies on its **own** interval, entirely independently of the
  catalog and of each other.
- If one source has to wait — OMDb's daily limit is hit, Rotten Tomatoes is
  unreachable — it backs off on its own and the others carry on unaffected.
  No manual intervention needed.
- All connected browsers are kept live-updated via Server-Sent Events.
- The **UI language (English/German) is user-selectable**, right in the
  browser, and includes movie titles and genre names — not just interface
  labels. See "Language switching" below.

It does **not** scrape justwatch.com — the catalog and rating sources it
uses by default (TMDb, OMDb, Trakt) all offer official, publicly documented
APIs. The exceptions are the two **optional, off-by-default scrapers** for
Rotten Tomatoes (`RT_SCRAPE_ENABLED`) and Metacritic (`MC_SCRAPE_ENABLED`),
which exist only because neither site has a public API any more and OMDb —
the one API that carries both figures — hands out 1000 requests a day.
Enabling them is a deliberate choice with the trade-offs spelled out in
their own section; with both on, **OMDb becomes optional entirely**.

## Required API keys

| Env var          | Source                                    | Free |
|-------------------|--------------------------------------------|------|
| `TMDB_API_KEY`    | https://www.themoviedb.org/settings/api    | yes  |
| `OMDB_API_KEY` *(optional — see the scrapers below)* | https://www.omdbapi.com/apikey.aspx | yes (1000 requests/day, extendable via a Patreon tier) |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` (optional) | https://trakt.tv/oauth/applications (create an app; "Redirect URI" can be left as `urn:ietf:wg:oauth:2.0:oob` since the device-code flow doesn't use it) | yes |

## Environment variables

| Variable                      | Required | Default                | Description |
|--------------------------------|----------|--------------------------|--------------|
| `TMDB_API_KEY`                 | yes      | –                         | TMDb v3 API key |
| `OMDB_API_KEY`                 | no*      | –                         | OMDb API key. Optional: with `RT_SCRAPE_ENABLED` **and** `MC_SCRAPE_ENABLED` both columns are filled without it, and its status row disappears. Without it and without the scrapers, the catalog still works, but RT/Metacritic stay permanently "TODO". |
| `OMDB_RETRY_INTERVAL_MINUTES`  | no       | `30`                      | How long OMDb pauses itself after hitting its daily limit. Only OMDb waits — every other source keeps running. |
| `RT_SCRAPE_ENABLED`            | no       | `false`                   | `true`/`1` enables the optional Rotten Tomatoes scraper as the primary RT source — see "Ratings without OMDb" below. Works with or without an OMDb key. |
| `RT_REQUEST_DELAY_MS`          | no       | `1500`                    | Wait time between individual rottentomatoes.com page requests. Deliberately slow — don't lower it without reason. |
| `RT_REFRESH_INTERVAL_HOURS`    | no       | `24`                      | How old a tomatometer may get before it's re-scraped. Independent of `OMDB_REFRESH_INTERVAL_HOURS` — scraping has no quota, so RT can refresh far more often than Metacritic. |
| `RT_RETRY_INTERVAL_MINUTES`    | no       | `30`                      | How long RT backs off after Rotten Tomatoes or Wikidata is unreachable. Separate from `OMDB_RETRY_INTERVAL_MINUTES`: the two sources fail for unrelated reasons. |
| `RT_USER_AGENT`                | no       | a descriptive default     | User-Agent sent to Wikidata/RT. Wikidata rejects generic clients, so keep it descriptive. |
| `MC_SCRAPE_ENABLED`            | no       | `false`                   | `true`/`1` enables the optional Metacritic scraper as the primary Metascore source — see the scrapers section below. This is what makes an OMDb key unnecessary. |
| `MC_REQUEST_DELAY_MS`          | no       | `1500`                    | Wait time between individual metacritic.com page requests. Deliberately slow — don't lower it without reason. |
| `MC_REFRESH_INTERVAL_HOURS`    | no       | `24`                      | How old a Metascore may get before it's re-scraped. Its own knob, independent of RT's and of `OMDB_REFRESH_INTERVAL_HOURS`. |
| `MC_RETRY_INTERVAL_MINUTES`    | no       | `30`                      | How long Metacritic backs off after metacritic.com or Wikidata is unreachable. Separate from RT's and OMDb's: the sources fail for unrelated reasons. |
| `MC_USER_AGENT`                | no       | a descriptive default     | User-Agent sent to Wikidata/Metacritic. Wikidata rejects generic clients, so keep it descriptive. |
| `TRAKT_CLIENT_ID`              | no       | –                         | Trakt API app Client ID. Leave both Trakt vars unset to disable the feature entirely (the "Watched" column and Trakt status row are hidden). |
| `TRAKT_CLIENT_SECRET`          | no       | –                         | Trakt API app Client Secret. Needed together with `TRAKT_CLIENT_ID` for the device-code OAuth flow. |
| `TRAKT_REFRESH_INTERVAL_HOURS` | no       | `24`                      | How often the watched-history sync re-runs once connected |
| `PORT`                         | no       | `3000`                    | Server port |
| `TMDB_REFRESH_INTERVAL_HOURS`  | no       | `24`                      | How often the entire catalog is reloaded from TMDb |
| `TMDB_REQUEST_DELAY_MS`        | no       | `60`                      | Wait time between per-movie TMDb detail lookups (IMDb ID + release year) |
| `TMDB_DETAILS_BATCH_SIZE`      | no       | `200`                     | How many movies get their details resolved per engine tick, so a first run over a large catalog doesn't monopolise the loop |
| `OMDB_REFRESH_INTERVAL_HOURS`  | no       | `168` (7 days)            | How old an RT/Metacritic rating may get before it's automatically rechecked |
| `OMDB_REQUEST_DELAY_MS`        | no       | `150`                     | Wait time between individual OMDb requests (rate-limit protection) |
| `ENGINE_IDLE_MS`               | no       | `15000`                   | How long the engine waits when there's currently nothing to do |
| `PROVIDER_NAME`                | no       | `Amazon Prime Video`      | TMDb provider name, exactly as it appears in TMDb's provider list |
| `CACHE_DIR`                    | no       | `/app/data`               | Directory for the cache files (see below) |
| `DEBUG_MODE`                   | no       | `false`                   | `true`/`1` enables detailed console logging of every TMDb/OMDb/Trakt request |

## Ratings without OMDb: the two scrapers (optional, opt-in)

### Rotten Tomatoes (`RT_SCRAPE_ENABLED`)

Rotten Tomatoes has **no public API** any more, and OMDb's free tier caps
you at 1000 requests/day — which on a large catalog means the RT column can
take days to fill and never really catches up. As an alternative, setting
`RT_SCRAPE_ENABLED=true` reads the tomatometer off the public Rotten
Tomatoes movie page instead:

1. **Wikidata** resolves IMDb ids → RT slugs (property `P1258`), **batched**
   — one SPARQL query per 200 ids, so mapping an entire catalog costs a
   handful of requests, not one per movie. The mapping is cached
   permanently in `rt-slug-cache.json` (it's a stable fact about a film),
   including remembered misses, so nothing is looked up twice.
2. The RT page for each slug is then fetched and parsed, throttled by
   `RT_REQUEST_DELAY_MS` (1.5s by default).

**This is a scraper, and it is opt-in for a reason:**

- There is no API contract. When RT changes its markup, this breaks. The
  parser tries several known markup variants and, if all fail, reports "no
  rating" rather than crashing the engine — so the failure mode is missing
  ratings, not downtime.
- Scraping a site you don't own sits in a grey area with respect to its
  terms of service. That's your call to make for your own deployment; it is
  why this ships disabled by default.
- A transient failure (RT throttling you, Wikidata unreachable) is
  explicitly **not** recorded as "checked, no rating" — the movie stays
  pending and RT backs off for `RT_RETRY_INTERVAL_MINUTES` (OMDb keeps
  running meanwhile), so an outage can't silently turn hundreds of movies
  into false "N/A"s.

### Metacritic, the same way (`MC_SCRAPE_ENABLED`)

The Metascore was the last figure only OMDb could supply — and therefore
the only reason left to live with its 1000-requests-a-day limit.
`MC_SCRAPE_ENABLED=true` removes that reason, using the identical two-step
approach one column over:

1. **Wikidata** resolves IMDb ids → Metacritic slugs (property `P1712`,
   the `movie/<slug>` form), batched the same way and cached permanently in
   `mc-slug-cache.json`. Only `movie/...` ids are kept — `P1712` also holds
   `game/`, `tv/` and `music/` ids, whose pages carry a Metascore for
   something that isn't the film.
2. The Metacritic page for each slug is fetched and parsed, throttled by
   `MC_REQUEST_DELAY_MS` (1.5s by default).

The same caveats apply, one-for-one: no API contract, a grey area with
respect to the site's terms, opt-in for exactly those reasons, and every
failure mode resolving to "no score" rather than an exception. One trap is
specific to Metacritic and worth knowing about: every movie page shows
**two** scores — the critics' Metascore (0-100, an integer) and the user
score (0-10, with a decimal). The parser identifies the critics' score
specifically and rejects anything decimal-shaped, so a markup change can
make the column go empty but cannot quietly fill it with a user score
(`lib/metacritic.js`, and the tests that pin exactly this down in
`tests/metacritic.test.js`).

**Combining with OMDb:** all three are independent.

- **Both scrapers, no `OMDB_API_KEY`** — the point of all this: both
  columns are filled, there is no daily quota anywhere in the loop, and
  the OMDb status row disappears from the UI.
- **Both scrapers *and* `OMDB_API_KEY`**: each scraper owns its column;
  OMDb stays on purely as the fallback for whatever a scraper couldn't
  resolve (no Wikidata entry, no page, a markup change). Its limit then
  delays nothing but those leftovers.
- **One scraper only**: that column comes off the site, the other one
  needs OMDb — without a key it stays "TODO".

Enabling a scraper never removes data: where it has no score of its own, a
value OMDb already fetched stays on display.

**Switching an existing deployment over** takes one variable and a restart:
add `MC_SCRAPE_ENABLED=true` (alongside `RT_SCRAPE_ENABLED=true`), and drop
`OMDB_API_KEY` if you want OMDb gone entirely. **No cache needs clearing.**
Every movie simply gets an empty `mc-cache.json` entry on the next startup
and is filled in by the new pass; whatever OMDb had already fetched stays
visible in the meantime, and the Metascores replace it movie by movie as
they arrive. Removing the OMDb key stops all OMDb requests but leaves
`omdb-cache.json` in place, and its stored values keep serving as the
fallback for anything the scrapers can't resolve — delete the file if you
want those old figures gone too.

**Each source has its own refresh cadence and its own "Sync now".** Neither
scraper is tied to `OMDB_REFRESH_INTERVAL_HOURS`: they have
`RT_REFRESH_INTERVAL_HOURS` and `MC_REFRESH_INTERVAL_HOURS` (24h by default,
versus a week for OMDb), because scraping costs no quota and there is no
reason to make a fresh tomatometer wait for a Metascore, or either wait for
OMDb. The status panel gets an **RT** and a **Meta** row, each with its own
"Sync now" button (`POST /api/rt/refresh`, `POST /api/mc/refresh`) that
queues a re-scrape of that source's cache alone — re-scraping the whole
catalog can't burn a single request of the OMDb quota, and no other source's
staleness clock is touched.

**When OMDb hits its daily limit**, it pauses *itself* for
`OMDB_RETRY_INTERVAL_MINUTES` and both scrapers keep going at full speed —
each runs as a separate pass over a separate cache, so no source waiting
holds up another (nor the Trakt sync).

## Trakt: "Watched" status (optional)

If `TRAKT_CLIENT_ID`/`TRAKT_CLIENT_SECRET` are set, a "Trakt" row appears
in the status panel with a **Connect Trakt** button. This is a
**single, server-wide connection** — the app has no per-user login system,
so the "Watched" column reflects **one** Trakt account's history for
every visitor. That's a deliberate simplification for self-hosted,
personal-use deployments; see "Coding language"/architecture notes below
if you'd need true multi-user support instead.

**Connecting:** click "Connect Trakt" → the status row shows a code and a
link to trakt.tv → open the link on any device, log in, and enter the
code. The server polls in the background; once approved, it immediately
does a first sync.

**How it works technically:** uses Trakt's OAuth **device-code flow** (no
public redirect URL needed — works behind any reverse proxy). Once
connected, the app fetches your **entire** watched-movies history in one
(paginated) call to `/sync/watched/movies` — not one request per movie —
and matches it locally against the IMDb IDs already resolved via OMDb.
This is re-synced automatically every `TRAKT_REFRESH_INTERVAL_HOURS`
(default: daily), or on demand via "Sync now".

**Tokens** are stored in `trakt-auth.json` inside `CACHE_DIR` — treat that
file like a credential (it's already covered by the same `.gitignore`/
`.dockerignore` exclusions as the other cache files, but is worth calling
out specifically since, unlike the others, it's sensitive). "Disconnect"
deletes it and resets every visitor's "Watched" column back to "N/A".

**Filtering:** the "Watched" column behaves like the others — type
`unseen` to see only what you haven't watched yet (arguably the most
useful filter combination this app offers: `unseen` + an RT/Metacritic
minimum rating), or `watched`/`N/A` for the other states.

## Docker build

```bash
docker build -t prime-rt-finder .
```

## Running without Compose (example)

```bash
docker run -p 3000:3000 \
  -e TMDB_API_KEY=your_tmdb_key \
  -e RT_SCRAPE_ENABLED=true \
  -e MC_SCRAPE_ENABLED=true \
  -v prime_rt_cache:/app/data \
  prime-rt-finder
```

That example runs **without an OMDb key at all** — both rating columns come
off the scrapers. Add `-e OMDB_API_KEY=your_omdb_key` to keep OMDb on as a
fallback, or use it instead of the two scraper flags for the API-only
setup.

The volume on `/app/data` is **recommended, bordering on necessary**:
since the engine runs continuously, a container restart without a volume
would discard all prior progress (catalog + already-checked movies).

## Separate caches (one cache per provider)

`CACHE_DIR` holds independent files per data source:

- **`tmdb-cache.json`** – the full catalog (title, year, genres, link),
  fetched **once per supported UI language** (see "Language switching"
  below) and stored per movie as e.g. `title: { en: "...", de: "..." }`.
  **Fully replaced** on every `TMDB_REFRESH_INTERVAL_HOURS` cycle.
- **`tmdb-details.json`** – TMDb movie ID → IMDb ID **and primary release
  year**, both fetched in one `/movie/{id}` request. Primary-source data, so
  it lives with the catalog rather than inside any one rating source: OMDb,
  the RT scraper and Trakt all read it, none of them owns it. Misses are
  remembered too. (Supersedes `imdb-ids.json`, migrated automatically.)
- **`omdb-cache.json`** – OMDb's own ratings per movie (Metacritic, plus
  OMDb's RT figure). Language-independent (just numbers), updated per movie
  individually, on `OMDB_REFRESH_INTERVAL_HOURS`.
- **`rt-cache.json`** *(only if `RT_SCRAPE_ENABLED`)* – the scraped
  tomatometer per movie, on its own `RT_REFRESH_INTERVAL_HOURS`. A peer of
  `omdb-cache.json`, not a part of it.
- **`rt-slug-cache.json`** *(only if `RT_SCRAPE_ENABLED`)* – IMDb ID → Rotten
  Tomatoes slug, resolved via Wikidata. Never expires (the mapping is a
  stable fact about a film) and remembers misses too. Delete it to force a
  full re-resolve.
- **`mc-cache.json`** *(only if `MC_SCRAPE_ENABLED`)* – the scraped
  Metascore per movie, on its own `MC_REFRESH_INTERVAL_HOURS`. A peer of the
  two above, not a part of either.
- **`mc-slug-cache.json`** *(only if `MC_SCRAPE_ENABLED`)* – IMDb ID →
  Metacritic slug (`movie/<slug>`), resolved via Wikidata. Same rules as
  `rt-slug-cache.json`, separate file: the two mappings come from different
  Wikidata properties, and one being absent says nothing about the other.
- **`trakt-auth.json`** *(only if Trakt is configured)* – OAuth tokens for
  the single, server-wide Trakt connection. Sensitive — see "Trakt:
  Watched status" below.
- **`trakt-watched.json`** *(only if Trakt is configured)* – the derived
  list of watched IMDb IDs, refreshed on `TRAKT_REFRESH_INTERVAL_HOURS`.

**One file per source is the point, not an accident.** Each rating source
owns exactly one cache, and nothing else writes to it. You can delete
`rt-cache.json` to force a full re-scrape without spending a single OMDb
request, or delete `omdb-cache.json` without losing a single scraped
tomatometer. A catalog refresh likewise doesn't trigger a recheck of any
source, and no source's failure invalidates another's data.

## Atomic catalog switch

A TMDb catalog refresh takes a couple of minutes, depending on catalog
size (several paginated requests, fetched once per supported language —
see "Language switching"). To avoid disrupting usage during that time,
the new catalog is **built entirely in the background** and only switched
live in a single step, after it has fully loaded. Until then, connected
browsers keep seeing the old, complete state throughout, then jump to the
new state in one go — no flickering or partially updated intermediate
state.

## Language switching

The two small **EN / DE** buttons top-right let each user pick their own
UI language, independently per browser:

- **Interface text** (labels, buttons, status messages, footer) is
  translated client-side from a small dictionary in `public/js/i18n.js` —
  no server round-trip.
- **Movie titles and genre names** are also language-dependent. Since the
  catalog is fetched and cached once, centrally, for *all* users (not per
  browser session), the server fetches it **once per supported language**
  on every catalog refresh and sends both variants to every connected
  client; the browser picks the right one for display. This is what
  roughly doubles the catalog refresh time and TMDb call count mentioned
  above.
- The choice is persisted in the browser's `localStorage` and otherwise
  defaults to the browser's own language, falling back to English.
- Currently supported: English (`en`) and German (`de`), matching
  `SUPPORTED_LANGUAGES` in `server.js` and `public/js/i18n.js`. Adding a
  third language means extending both.
- The **catalog scope** (which country's Prime Video catalog is shown)
  stays independent of the UI language — that's controlled separately via
  TMDb's `region`/`watch_region` parameters (hardcoded to `DE` in
  `server.js`), not by `SUPPORTED_LANGUAGES`.

## Which year is shown

The **Year** column is TMDb's **primary release date** — the year
themoviedb.org prints in parentheses after the title.

This is deliberately *not* the year from the catalog listing:
`/discover/movie` scopes `release_date` to the request's `region` (`DE`
here), so it reports the **German** release, which for films that opened
late in a year abroad differs from the year TMDb itself displays. The year
therefore comes from `/movie/{id}`, which returns the primary release date —
and since that same request also carries the IMDb ID the app needs anyway,
it costs **no extra requests**.

Note that the primary release date is not always the earliest release
anywhere in the world: a festival premiere can predate it. Matching what
TMDb shows is the goal, so the primary release date is the right field.

Until a movie's details have been fetched, the region-scoped year from the
catalog is shown as a provisional value; the TMDb status row reports the
progress of that backfill.

## Result table: TODO / N/A / rating

- **TODO** – the movie has never been checked against OMDb yet. All Prime
  movies appear in the table immediately, even before their rating is known.
- **N/A** – the movie was checked, but OMDb has no Rotten Tomatoes or
  Metacritic rating on file for it.
- **Number** – the actual rating (RT in %, Metacritic on a 0–100 scale). Once
  its TTL (`OMDB_REFRESH_INTERVAL_HOURS`) expires, this number **stays
  displayed** while a re-check is pending in the background - it does not
  regress back to "TODO". When the daily OMDb quota is limited, movies that
  have never been checked at all are always processed before due refreshes
  of already-known ratings, so the visible backlog fills in first-time gaps
  before re-confirming ratings that are merely a bit old.

Hover over the RT or Metacritic cell of any row to see a tooltip with when
that rating was last checked against OMDb (or that it hasn't been checked
yet, or that a background refresh of it is currently pending).

## Filtering

No free-text search field anymore — column filters only:

- Title / Genre / Year: substring filter.
- RT / Metacritic: a number (e.g. `60`) filters by **minimum rating**;
  text (e.g. `n/a`, `todo`) filters as a substring of the display value.

Click a column header to sort by it (click again to reverse direction).

## Performance on large catalogs / low-powered devices

On a large catalog (thousands of movies), two things matter more than raw
network speed, especially on weaker CPUs like phones:

- **Render debounce during background rating checks.** While the engine
  works through pending OMDb rating checks, it sends an `upsert` event
  roughly every `OMDB_REQUEST_DELAY_MS` (150ms by default). The frontend
  batches these into a single table rebuild at most every 500ms
  (`scheduleRender` in `public/index.html`), instead of rebuilding the
  full table on every single incoming update — the difference is mainly
  noticeable on slower devices, where continuous full-table rebuilds add
  up to visible lag.
- **Rendering is paginated independently of filtering/sorting.** Filtering
  and sorting always run over the *entire* dataset in memory — that's
  already fast even for thousands of movies. What's comparatively
  expensive is turning a large result set into DOM rows, especially on
  weaker hardware. The table therefore only renders the first 200
  matches (`PAGE_SIZE` in `public/index.html`) at a time and **loads more
  automatically as you scroll** (via `IntersectionObserver`, observed
  against the table's own internal scroll container) — no click needed,
  though the "Load more" indicator at the bottom stays clickable too, as
  a fallback for keyboard/screen-reader use. The result counts above the
  table always reflect the true, full match count — pagination only caps
  what's painted into the DOM, not what's counted or searched.
  The "Load more" row is horizontally `position: sticky` (mirroring the
  sticky `<thead>` used vertically) so it stays within view even when the
  table is scrolled sideways — the table is wider than most phone
  screens, and without this the load-more indicator would scroll out of
  the visible area horizontally and silently stop auto-loading.
- Filter/sort changes, a language switch's underlying data change, and a
  fresh catalog snapshot reset the visible page back to the top (new
  result set); a single movie's rating being updated in the background
  does not (keeps your current scroll/pagination position undisturbed).

## Status display & manual sync

Top right shows a panel per provider: TMDb, plus **OMDb** when
`OMDB_API_KEY` is set, **RT** when `RT_SCRAPE_ENABLED`, **Meta** when
`MC_SCRAPE_ENABLED` and **Trakt** when Trakt is configured. A source that
isn't configured has no row at all — with both scrapers on and no OMDb key,
the OMDb row is simply gone:

- current phase (up to date / running / waiting for limit reset / error),
- timestamp of that source's last full sync,
- number of movies still pending for that source while it's working.

**Each row reports only its own source.** An RT sweep counts up in the RT
row and nowhere else; OMDb's quota wait shows only in the OMDb row. (Before
the sources were split apart, both ran through one pass, so RT's progress
appeared under OMDb.)

The OMDb status turns **red** ("waiting for OMDb daily limit reset") only
when movies that have **never** been checked at all are still stuck behind
the limit - a genuine coverage gap. If every movie already has a rating and
the daily limit is only delaying an optional background refresh of
already-known, merely-stale ratings, the status shows as a normal
in-progress state instead ("every movie has a rating - refreshing stale
ones in the background") - not a problem, just a nice-to-have still
catching up.

Each source has its own "Sync now", which queues a re-check of **that
source only** — OMDb's costs no scraping, and neither scraper's costs a
single OMDb request. None of them blanks the table back to "TODO": the values on screen stay until fresh ones
replace them. A button is grayed out while that source is already working;
an explicit "Sync now" also cancels that source's current back-off.

## Debug mode

With `DEBUG_MODE=true`, the server prints detailed logs for every
TMDb/OMDb request to the console (URL with masked API key, HTTP status,
duration), e.g.:

```
[DEBUG 2026-08-14T10:15:03.120Z] TMDb GET https://api.themoviedb.org/3/discover/movie?api_key=***&...
[DEBUG 2026-08-14T10:15:03.410Z] TMDb <- 200 (290ms) [discover page 4]
[DEBUG 2026-08-14T10:15:04.002Z] OMDb GET https://www.omdbapi.com/?i=tt1234567&apikey=***
[DEBUG 2026-08-14T10:15:04.180Z] OMDb <- 200 (178ms) [tt1234567] Response=True Error=-
```

With `MC_SCRAPE_ENABLED=true`, the Metacritic path logs in the same shape
(`MC GET …` / `MC <- 200 (…ms) [tt0133093 movie/the-matrix] metascore=73`);
a `metascore=-` on an otherwise healthy `200` is the same tell-tale sign of
a markup change as below.

With `RT_SCRAPE_ENABLED=true`, the Rotten Tomatoes path logs too — useful
for spotting a markup change (a `tomatometer=-` on an otherwise healthy
`200` is the tell-tale sign that RT changed its page and the parser needs
updating):

```
[DEBUG 2026-08-14T10:15:05.001Z] Wikidata GET sparql [200 ids]
[DEBUG 2026-08-14T10:15:05.640Z] Wikidata <- 200 (639ms) [200 ids]
[DEBUG 2026-08-14T10:15:05.700Z] RT GET https://www.rottentomatoes.com/m/the_matrix
[DEBUG 2026-08-14T10:15:06.010Z] RT <- 200 (310ms) [tt0133093 m/the_matrix] tomatometer=83
```

## Behavior when the OMDb daily limit is hit

*(Enabling both scrapers makes this section moot — that's what they're for.
Without an OMDb key it doesn't apply at all.)*

- **OMDb alone** pauses and automatically retries every
  `OMDB_RETRY_INTERVAL_MINUTES` minutes. Every other source — both
  scrapers and Trakt — keeps running at full speed meanwhile.
- Already-checked movies are kept; only still-open ("TODO") movies get
  processed on the next attempt.
- The status display shows "Waiting for OMDb limit reset" along with the
  number of pending movies during this time.

## Running tests

```bash
npm install
npm test
```

Uses Node's built-in test runner (`node --test`), no extra test
dependencies needed. Runs without any real network access (no TMDb/OMDb
keys required), against extracted, pure logic:

- **`tests/omdb.test.js`** – OMDb response parsing (RT/Metacritic
  extraction) and daily-limit detection (`lib/omdb.js`).
- **`tests/tmdb.test.js`** – the primary source's pure parsing
  (`lib/tmdb.js`): the release-year extraction (including malformed dates)
  and when a cached details entry still needs fetching.
- **`tests/ratings.test.js`** – the logic every secondary source shares
  (`lib/ratings.js`): staleness, the never-checked/stale work tiers, and the
  merge precedence between sources (including that enabling a scraper can
  never blank a value OMDb already had, and that a scrapers-only setup
  fills both columns).
- **`tests/rottentomatoes.test.js`** – RT page parsing across every
  supported markup variant plus the fail-soft paths (`lib/rottentomatoes.js`),
  and the batched IMDb→RT-slug SPARQL query building/parsing
  (`lib/wikidata.js`), including that non-`tt…` ids can't reach the query.
- **`tests/metacritic.test.js`** – the same for Metacritic
  (`lib/metacritic.js`): every supported markup variant, the fail-soft
  paths, the batched IMDb→Metacritic-slug queries (`P1712`, `movie/…` ids
  only) — and, above all, that the 0-10 **user score** sitting next to the
  Metascore on every page is never mistaken for it.
- **`tests/filters.test.js`** – the result table's column-filter and sort
  logic (`public/js/filters.js`), including that the filters are read
  straight off the inputs, so a value the browser restored without firing an
  input event still takes effect.
- **`tests/connection.test.js`** – the SSE connection manager
  (`public/js/connection.js`), including a test that **reproduces exactly
  the mobile connection-drop scenario**: an `EventSource` that "dies
  silently" (`readyState` becomes `CLOSED` without `onerror` firing —
  exactly the behavior of iOS/Android on screen lock), verifying that the
  watchdog detects it and reconnects.

The browser frontend logic (`connection.js`, `filters.js`) is
deliberately extracted into pure, dependency-injected modules so it's
testable without a real browser (via a fake `EventSource`/`document`/
`window`), while still running unchanged via `<script type="module">` in
the browser.

## End-to-end tests (Playwright)

In addition to the unit tests, there are real browser tests with mobile
device emulation (Pixel 5 / iPhone 13) that verify the app actually
recovers from network drops **in a real browser** — not just the isolated
logic behind it.

**One-time setup** (downloads browser binaries, needs internet):

```bash
npm install
npx playwright install --with-deps chromium webkit
```

**Run:**

```bash
npm run test:e2e
```

This automatically starts a local server (dummy API keys are enough,
since these tests don't check real movie data, only connection behavior)
and tests, in `tests/e2e/mobile-reconnect.spec.js`:

- **Real network drop**: `context.setOffline(true/false)` cuts the
  connection completely at the browser level and restores it — Playwright's
  closest equivalent to a cellular/Wi-Fi outage or the OS hard-killing the
  connection on screen lock.
- **Tab visibility change**: simulates unlocking a phone
  (`visibilitychange` event), independent of the watchdog timer.
- **No unnecessary reconnect**: verifies that a healthy, visible
  connection does NOT keep reconnecting.

And, in `tests/e2e/column-filters.spec.js`:

- **Column filters apply**: typing a value filters the table, clearing it
  restores every row, and "Clear column filters" empties all inputs.
- **A filter already present on load applies too**: the page is served with
  a filter input already carrying a value, reproducing what a browser leaves
  behind when it restores the field on a soft reload (F5) — a visible value
  that never fired an input event. This is the exact state that used to
  render the table **unfiltered** while the box showed a filter, and it is
  invisible to unit tests, which is why it is guarded here.

The `?staleMs=...&watchdogMs=...` URL parameters are a test hook (see
`public/index.html`) that shorten the watchdog time windows for fast,
deterministic tests — in normal operation, without these parameters, the
production defaults apply unchanged.

**Note:** These tests are deliberately kept separate from `npm test`
(unit tests, run in seconds without internet/browser downloads) and
`npm run test:e2e` (needs internet once for the browser download, then
works offline), so the fast unit tests stay usable e.g. in a simple
pre-commit hook without requiring Playwright.

## Dev Container (VS Code)

The `.devcontainer/` folder contains a ready-made dev container
configuration, engine-agnostic by default (works with both Docker and
Podman as the underlying container engine):

- Base image: `mcr.microsoft.com/devcontainers/javascript-node:1-20-bookworm`
  (Node 20, matching `engines.node` in `package.json`)
- `npm install` and `npx playwright install --with-deps chromium webkit`
  run automatically the first time the container is built
- Port `3000` is forwarded automatically
- VS Code extensions are suggested automatically: ESLint, Prettier,
  Playwright, Docker
- `remoteUser` is set to `node` (the base image's built-in non-root
  user), which also happens to be what rootless Podman needs

**Before first opening:** set `TMDB_API_KEY` and `OMDB_API_KEY` as
environment variables on the host (e.g. in `~/.bashrc`/`~/.zshrc`)
**before** starting VS Code — they're passed into the container via
`${localEnv:...}`, so no keys end up in the repo:

```bash
export TMDB_API_KEY=your_tmdb_key
export OMDB_API_KEY=your_omdb_key
```

**Usage:** open the folder in VS Code → "Reopen in Container" (or via the
Command Palette: *Dev Containers: Reopen in Container*). Then:

```bash
npm start          # starts the server on port 3000 (inside the container)
npm test           # unit tests
npm run test:e2e   # Playwright E2E tests (browsers are already installed)
```

Inside the dev container, the cache lives under `.dev-data/` **inside**
the workspace folder (unlike the production Dockerfile, which uses
`/app/data`) — this makes it persist automatically on the host without
any extra Docker/Podman volume, and it's already excluded from commits
via `.gitignore`.

### Using Podman instead of Docker

By default, VS Code's Dev Containers extension assumes Docker. To use
Podman instead, set this in your **VS Code user settings** (this is a
VS Code setting, not something that can live in the repo's
`devcontainer.json`):

```json
{
  "dev.containers.dockerPath": "podman"
}
```

Make sure Podman's API socket is actually running before opening the
folder in a container:

- **Linux:** `systemctl --user enable --now podman.socket`
- **macOS/Windows (Podman Desktop / `podman machine`):**
  `podman machine start`

If the container still fails to start with a user-namespace/permission
error (rootless Podman), add this to your **local, uncommitted** copy of
`.devcontainer/devcontainer.json`:

```json
"runArgs": ["--userns=keep-id"]
```

This is deliberately **not** in the committed `devcontainer.json`,
because `--userns=keep-id` is Podman-specific syntax that Docker's CLI
rejects — adding it unconditionally would break the config for Docker
users. Keep it as a local, personal override instead (e.g. via `git
update-index --skip-worktree .devcontainer/devcontainer.json`, or just
don't commit the change).

**Why there's no `docker-outside-of-docker` feature here:** an earlier
version of this config included it, to make `docker build`/`docker run`
usable from inside the dev container. That feature hardcodes a bind
mount of `/var/run/docker.sock`, which doesn't exist under Podman (it
uses a different socket path and rootless-by-default model) — so the
container failed to start entirely for Podman users. If you're on Docker
and want that convenience back, add the feature yourself to your local
config:

```json
"features": {
  "ghcr.io/devcontainers/features/docker-outside-of-docker:1": {}
}
```

For Podman users who want to build/test the production `Dockerfile` from
inside the dev container, it's simplest to just run `podman build`/`podman
run` on the **host**, outside the dev container, rather than trying to
reach the host's Podman socket from within it.

## For Developers

### Project layout

```
server.js                    Express app + background engine (entry point)
lib/
  tmdb.js                    Pure TMDb detail parsing: primary release year, IMDb id (tested, no network)
  ratings.js                 Source-agnostic rating logic shared by every secondary source:
                             staleness, work scheduling, the merge into one view (tested, no network)
  omdb.js                    Pure OMDb response parsing / limit detection (tested, no network)
  trakt.js                   Pure Trakt response parsing / OAuth-flow status helpers (tested, no network)
  rottentomatoes.js          Pure RT page parsing (multi-strategy, fail-soft) + failure classification (tested, no network)
  metacritic.js              Pure Metacritic page parsing (multi-strategy, fail-soft, critics-score-only) + failure classification (tested, no network)
  wikidata.js                Pure SPARQL query building / result parsing for IMDb->RT/Metacritic slug mapping (tested, no network)
public/
  index.html                 UI shell; loads the modules below via <script type="module">
  js/
    filters.js                Pure column-filter/sort logic (tested)
    connection.js              SSE connection manager with watchdog/reconnect logic (tested)
    i18n.js                    UI translations, per-language date formatting, movie locale projection, language persistence (tested)
tests/
  *.test.js                   Unit tests (Node's built-in test runner, no dependencies)
  e2e/*.spec.js                Playwright end-to-end tests (real browsers, mobile emulation)
.devcontainer/
  devcontainer.json            VS Code Dev Container config
Dockerfile                    Production image (Node 20 Alpine)
playwright.config.js          E2E test config (auto-starts the server)
```

### Architecture at a glance

- **One primary source, several independent secondary ones.**

  ```
  TMDb (primary)          which movies exist, their titles/genres, their
    |                     primary release year and their IMDb IDs —
    |                     everything else keys off this
    +-- RT     (secondary)  the tomatometer, scraped
    +-- MC     (secondary)  the Metascore, scraped
    +-- OMDb   (secondary)  both figures second-hand, as a fallback
    +-- Trakt  (secondary)  watched status
  ```

  The secondaries are **peers, not layers**. Each owns one cache file, one
  refresh interval, one status row, one manual trigger and one pass in the
  engine loop, and each runs in its own `try`/`catch`. None of them calls,
  waits on, or writes to another's state. Adding a further rating source
  means adding one more block to the loop — not threading it through an
  existing one. `lib/ratings.js` holds the parts that are genuinely the
  same for all of them (staleness, work scheduling, the merge into one
  view); everything else is deliberately duplicated per source so the
  sources stay independent.
- **A waiting source never blocks the loop.** When a source has to back off
  (OMDb's daily quota is spent, Rotten Tomatoes is refusing us), it records
  *when* it may try again and returns — it does not sleep inside its pass.
  Sleeping there would hold up every other source, which is precisely how a
  rate-limited OMDb key used to stall the RT scraper and the Trakt sync
  along with it. Each scraper has its own back-off timestamp for the same
  reason: Metacritic refusing us must not slow down Rotten Tomatoes.
- **The sources are merged only at the view layer**, in
  `mergeRatingView`. Each scraper wins its own column once it has actually
  checked, since it reads the score off the site itself while OMDb's figure
  is a second-hand copy that's missing for many titles — but a movie a
  scraper hasn't reached still falls back to OMDb's value, so enabling a
  scraper never removes data.
- **No request-driven scanning.** A single background loop
  (`backgroundEngineLoop` in `server.js`) runs continuously from process
  start, independent of HTTP requests.
- **The primary source owns the ID set.** `reconcileSecondaryCaches` gives
  every catalog movie an entry in every secondary cache and drops entries
  for movies that left the catalog. It runs at startup as well as after a
  catalog refresh, so a cache predating a source (or a source enabled
  later) is filled in without waiting for the next refresh cycle.
- **Atomic catalog swap.** The new TMDb catalog is built in a local
  variable first; only after it's complete does the code swap it into the
  shared state and broadcast a single `snapshot` SSE event. No client ever
  observes a half-updated catalog.
- **SSE, not polling.** `/api/stream` pushes `init` (full state on
  connect), `upsert` (single movie changed), `snapshot` (full catalog
  swap), `status`, and `ping` (liveness heartbeat, not a real update)
  events to every connected client.
- **Pure logic is extracted on purpose.** Anything that doesn't need the
  DOM, the network, or Express (rating parsing, filtering/sorting,
  connection/watchdog behavior, translations) lives in its own small
  module with no side effects, specifically so it can be unit-tested with
  plain fakes instead of a real browser or real API keys.
- **Catalog data is multi-language, ratings are not.** `refreshTmdbCatalog`
  loops over `SUPPORTED_LANGUAGES` and fetches the full catalog once per
  language, merging results into `title`/`genres` objects keyed by
  language per movie. `public/js/i18n.js`'s `projectMovieForLocale` then
  flattens a raw multi-language movie record down to a single-language
  view at render time, based on the user's chosen UI language — this
  keeps `filters.js`'s filter/sort logic completely language-agnostic (it
  only ever sees already-flattened records).

### Coding conventions

- Comments, identifiers, and all user-visible strings (UI text, status
  messages, log output) are in English throughout the codebase — see
  "Coding language" below.
- Plain ES modules throughout (`"type": "module"` in `package.json`) — no
  build step, no bundler. `public/index.html` loads its scripts directly
  via `<script type="module">`.
- No framework on the frontend; vanilla DOM APIs only.
- New pure logic (parsing, filtering, formatting, connection handling)
  should go into its own module under `lib/` (server-side) or
  `public/js/` (frontend-side) with unit tests in `tests/`, rather than
  being added inline to `server.js` or `index.html`. That's what keeps the
  test suite fast and network-free.

### Coding language

Comments, identifiers, test names, and this README are written in
English — that's the codebase's development language and doesn't change
based on user-facing settings.

The **app's UI language (English/German) is separately user-selectable**
at runtime (see "Language switching" above) and applies to both interface
text and movie titles/genre names. The **catalog's data scope** (which
country's Prime Video catalog is shown) is independent of both: TMDb
requests use `region=DE` and `watch_region=DE` regardless of UI language,
so the app always shows the German Amazon Prime Video catalog — only
*how it's labeled* changes with the language switch, not *which* catalog
is shown.

### Local development workflow

```bash
npm install
npm test              # fast unit tests, no network/keys needed
npm start              # run the server locally (needs TMDB_API_KEY; OMDB_API_KEY or the scrapers for ratings)
npm run test:e2e       # slower, real-browser tests (needs a one-time Playwright browser install)
```

For iterating on the frontend, `public/` is served as static files —
just reload the browser after editing `public/index.html` or
`public/js/*.js`, no build step required. For server-side changes,
restart `node server.js` (or use a file watcher of your choice, e.g.
`node --watch server.js`).

### Adding a new environment variable

1. Read it with a sensible default in `server.js` (near the top, with the
   other `process.env.*` reads).
2. Document it in the "Environment variables" table above.
3. If it affects behavior a developer would want to test in isolation,
   consider whether it belongs in `lib/` or `public/js/` as an injectable
   parameter instead of a global, so it stays unit-testable.

## Completeness notes

- The app queries the **entire** current Prime Video catalog (DE,
  subscription/flatrate) from TMDb, not just a subset.
- TMDb and OMDb data is maintained by communities/editors and may include
  individual titles with a delay, or not at all. "Complete" refers to the
  state of the underlying sources at the time of each check.
- With very large catalogs and the free OMDb quota (1000/day), a full
  initial pass can take several days, since the engine automatically
  waits when the limit is hit instead of throwing errors. A paid OMDb
  Patreon tier (starting at roughly $1/month) speeds this up
  significantly.

## Migrating from an older version

**Release year now comes from TMDb's primary release date (latest
change).** `imdb-ids.json` is superseded by `tmdb-details.json`, which holds
the IMDb ID *and* the primary release year. Existing IDs are migrated
automatically at startup and each movie is re-fetched once to pick up its
year — see "Which year is shown".

**Splitting the rating sources apart.** The single
`omdb-cache.json` entry used to carry the IMDb ID, *both* sources' ratings
and both sources' timestamps. It's now split into `imdb-ids.json` (primary
data), `omdb-cache.json` (OMDb's own ratings) and `rt-cache.json` (scraped
tomatometers). **This migration is automatic and runs once at startup** —
scraped RT scores, IMDb IDs and any pending Metacritic re-checks are moved
to their new homes, and the log line says what moved. No manual action, and
nothing is re-fetched that had already been fetched.

The cache file format has changed (separate `tmdb-cache.json` /
`omdb-cache.json` instead of a single `cache.json`). An old `cache.json`
is no longer read — it can be deleted; the app automatically rebuilds its
state on first start.

**Also:** `tmdb-cache.json`'s schema changed to support per-language
titles/genres (`title`/`genres` are now objects like `{ en: "...", de:
"..." }` instead of plain strings). This is handled gracefully: an older
cache with plain-string `title`/`genres` still works (`projectMovieForLocale`
falls back to displaying that single string regardless of the selected UI
language) — movies just show in whichever single language they were
originally cached in, for both EN and DE, until the next catalog refresh
naturally repopulates them with both languages. No manual action needed,
though triggering a manual "Sync now" for TMDb gets you both languages
sooner.

