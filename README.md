# Prime × Tomatoes

A web app that loads the **Amazon Prime Video catalog (Germany, included
in the subscription)** via the official **TMDb API** and checks each title
against the **OMDb API** for its **Rotten Tomatoes** and **Metacritic**
rating.

A **persistent background engine** runs as soon as the server starts —
regardless of whether a browser is currently connected:

- The **TMDb catalog** (title, year, genres, link) is fully reloaded on
  its own configurable interval (default: daily).
- **OMDb ratings** (RT + Metacritic) are checked per movie independently
  of that, and automatically rechecked after their own, longer interval
  (default: 7 days).
- If the OMDb daily limit is hit, the engine automatically pauses and
  retries at configurable intervals — no manual intervention needed.
- All connected browsers are kept live-updated via Server-Sent Events.
- The **UI language (English/German) is user-selectable**, right in the
  browser, and includes movie titles and genre names — not just interface
  labels. See "Language switching" below.

It does **not** scrape justwatch.com — the catalog and rating sources it
uses by default (TMDb, OMDb, Trakt) all offer official, publicly documented
APIs. The one exception is the **optional, off-by-default Rotten Tomatoes
scraper** (`RT_SCRAPE_ENABLED`, see below), which exists only because Rotten
Tomatoes has no public API at all any more; enabling it is a deliberate
choice with the trade-offs spelled out in its own section.

## Required API keys

| Env var          | Source                                    | Free |
|-------------------|--------------------------------------------|------|
| `TMDB_API_KEY`    | https://www.themoviedb.org/settings/api    | yes  |
| `OMDB_API_KEY`    | https://www.omdbapi.com/apikey.aspx        | yes (1000 requests/day, extendable via a Patreon tier) |
| `TRAKT_CLIENT_ID` / `TRAKT_CLIENT_SECRET` (optional) | https://trakt.tv/oauth/applications (create an app; "Redirect URI" can be left as `urn:ietf:wg:oauth:2.0:oob` since the device-code flow doesn't use it) | yes |

## Environment variables

| Variable                      | Required | Default                | Description |
|--------------------------------|----------|--------------------------|--------------|
| `TMDB_API_KEY`                 | yes      | –                         | TMDb v3 API key |
| `OMDB_API_KEY`                 | yes*     | –                         | OMDb API key. Without it (and without `RT_SCRAPE_ENABLED`), the catalog still works, but RT/Metacritic stay permanently "TODO". |
| `RT_SCRAPE_ENABLED`            | no       | `false`                   | `true`/`1` enables the optional Rotten Tomatoes scraper as the primary RT source — see "Rotten Tomatoes without OMDb" below. Works with or without an OMDb key. |
| `RT_REQUEST_DELAY_MS`          | no       | `1500`                    | Wait time between individual rottentomatoes.com page requests. Deliberately slow — don't lower it without reason. |
| `RT_USER_AGENT`                | no       | a descriptive default     | User-Agent sent to Wikidata/RT. Wikidata rejects generic clients, so keep it descriptive. |
| `TRAKT_CLIENT_ID`              | no       | –                         | Trakt API app Client ID. Leave both Trakt vars unset to disable the feature entirely (the "Watched" column and Trakt status row are hidden). |
| `TRAKT_CLIENT_SECRET`          | no       | –                         | Trakt API app Client Secret. Needed together with `TRAKT_CLIENT_ID` for the device-code OAuth flow. |
| `TRAKT_REFRESH_INTERVAL_HOURS` | no       | `24`                      | How often the watched-history sync re-runs once connected |
| `PORT`                         | no       | `3000`                    | Server port |
| `TMDB_REFRESH_INTERVAL_HOURS`  | no       | `24`                      | How often the entire catalog is reloaded from TMDb |
| `OMDB_REFRESH_INTERVAL_HOURS`  | no       | `168` (7 days)            | How old an RT/Metacritic rating may get before it's automatically rechecked |
| `OMDB_RETRY_INTERVAL_MINUTES`  | no       | `30`                      | Wait time between retries once the OMDb daily limit is hit |
| `OMDB_REQUEST_DELAY_MS`        | no       | `150`                     | Wait time between individual OMDb requests (rate-limit protection) |
| `ENGINE_IDLE_MS`               | no       | `15000`                   | How long the engine waits when there's currently nothing to do |
| `PROVIDER_NAME`                | no       | `Amazon Prime Video`      | TMDb provider name, exactly as it appears in TMDb's provider list |
| `CACHE_DIR`                    | no       | `/app/data`               | Directory for the cache files (see below) |
| `DEBUG_MODE`                   | no       | `false`                   | `true`/`1` enables detailed console logging of every TMDb/OMDb/Trakt request |

## Rotten Tomatoes without OMDb (optional, `RT_SCRAPE_ENABLED`)

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
  pending and the engine backs off for `OMDB_RETRY_INTERVAL_MINUTES`,
  so an outage can't silently turn hundreds of movies into false "N/A"s.

**Combining with OMDb:** the two are independent.

- `RT_SCRAPE_ENABLED` **and** `OMDB_API_KEY`: the scraper is the primary RT
  source, OMDb supplies Metacritic and acts as the RT fallback for anything
  the scraper couldn't resolve.
- `RT_SCRAPE_ENABLED` **without** `OMDB_API_KEY`: RT scores only, no
  Metacritic (that column stays "N/A"), and no daily quota anywhere in the
  loop.

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
  -e OMDB_API_KEY=your_omdb_key \
  -v prime_rt_cache:/app/data \
  prime-rt-finder
```

The volume on `/app/data` is **recommended, bordering on necessary**:
since the engine runs continuously, a container restart without a volume
would discard all prior progress (catalog + already-checked movies).

## Separate caches (one cache per provider)

`CACHE_DIR` holds independent files per data source:

- **`tmdb-cache.json`** – the full catalog (title, year, genres, link),
  fetched **once per supported UI language** (see "Language switching"
  below) and stored per movie as e.g. `title: { en: "...", de: "..." }`.
  **Fully replaced** on every `TMDB_REFRESH_INTERVAL_HOURS` cycle.
- **`omdb-cache.json`** – RT/Metacritic rating per movie. Language-
  independent (just numbers), updated per movie individually, independent
  of the catalog refresh.
- **`trakt-auth.json`** *(only if Trakt is configured)* – OAuth tokens for
  the single, server-wide Trakt connection. Sensitive — see "Trakt:
  Watched status" below.
- **`trakt-watched.json`** *(only if Trakt is configured)* – the derived
  list of watched IMDb IDs, refreshed on `TRAKT_REFRESH_INTERVAL_HOURS`.
- **`rt-slug-cache.json`** *(only if `RT_SCRAPE_ENABLED`)* – IMDb ID → Rotten
  Tomatoes slug, resolved via Wikidata. Never expires (the mapping is a
  stable fact about a film) and remembers misses too. Delete it to force a
  full re-resolve.

This decouples the data sources: a catalog refresh doesn't automatically
trigger a recheck of all movies' OMDb ratings or a Trakt re-sync, and
vice versa.

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

Top right shows a panel per provider (TMDb / OMDb):

- current phase (up to date / running / waiting for limit reset / error),
- timestamp of the last full sync,
- while an OMDb check is running or waiting for a limit reset: number of
  movies still pending.

The OMDb status turns **red** ("waiting for OMDb daily limit reset") only
when movies that have **never** been checked at all are still stuck behind
the limit - a genuine coverage gap. If every movie already has a rating and
the daily limit is only delaying an optional background refresh of
already-known, merely-stale ratings, the status shows as a normal
in-progress state instead ("every movie has a rating - refreshing stale
ones in the background") - not a problem, just a nice-to-have still
catching up.

Each "Sync now" button is grayed out while a sync is already running for
that provider — an ongoing wait for a limit reset also counts as
"currently running".

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

- The engine pauses rating checks and automatically retries every
  `OMDB_RETRY_INTERVAL_MINUTES` minutes.
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
- **`tests/rottentomatoes.test.js`** – RT page parsing across every
  supported markup variant plus the fail-soft paths (`lib/rottentomatoes.js`),
  and the batched IMDb→RT-slug SPARQL query building/parsing
  (`lib/wikidata.js`), including that non-`tt…` ids can't reach the query.
- **`tests/filters.test.js`** – the result table's column-filter and sort
  logic (`public/js/filters.js`).
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
  omdb.js                    Pure OMDb response parsing / limit detection (tested, no network)
  trakt.js                   Pure Trakt response parsing / OAuth-flow status helpers (tested, no network)
  rottentomatoes.js          Pure RT page parsing (multi-strategy, fail-soft) + failure classification (tested, no network)
  wikidata.js                Pure SPARQL query building / result parsing for IMDb->RT slug mapping (tested, no network)
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

- **No request-driven scanning.** A single background loop
  (`backgroundEngineLoop` in `server.js`) runs continuously from process
  start, independent of HTTP requests. It alternates between refreshing
  the TMDb catalog (on its own interval) and processing pending OMDb
  rating checks.
- **Two independent caches**, each with its own refresh cadence and its
  own JSON file on disk (see "Two separate caches" above) — deliberately
  not merged into one cache, so a catalog refresh and a ratings refresh
  never force each other.
- **Atomic catalog swap.** The new TMDb catalog is built in a local
  variable first; only after it's complete does the code swap it into the
  shared state and broadcast a single `snapshot` SSE event. No client ever
  observes a half-updated catalog.
- **SSE, not polling.** `/api/stream` pushes `init` (full state on
  connect), `upsert` (single movie changed), `snapshot` (full catalog
  swap), `ratings_reset`, `status`, and `ping` (liveness heartbeat, not a
  real update) events to every connected client.
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
npm start              # run the server locally (needs TMDB_API_KEY/OMDB_API_KEY)
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

