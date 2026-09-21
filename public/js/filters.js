// Pure filter/sort functions with no DOM dependency - run unchanged in the
// browser (via <script type="module">) and in tests (via Node import), so
// the exact same logic that runs live is what gets tested.

export function formatScore(value) {
  if (value === "TODO") return { text: "TODO", cls: "score-todo" };
  if (value === null || value === undefined) return { text: "N/A", cls: "score-na" };
  return { text: String(value), cls: "score-value" };
}

export function passesColumnFilter(movie, field, filterRaw) {
  const filterVal = String(filterRaw ?? "").trim();
  if (!filterVal) return true;

  if (field === "rt" || field === "metacritic") {
    if (/^\d+(\.\d+)?$/.test(filterVal)) {
      // Numeric filter = minimum rating. TODO/N-A never satisfy this.
      return typeof movie[field] === "number" && movie[field] >= Number(filterVal);
    }
    const display = movie[field] === "TODO" ? "todo" : movie[field] === null ? "n/a" : String(movie[field]);
    return display.includes(filterVal.toLowerCase());
  }

  const cellVal = String(movie[field] ?? "").toLowerCase();
  return cellVal.includes(filterVal.toLowerCase());
}

export function passesAllColumnFilters(movie, columnFilters) {
  return Object.keys(columnFilters).every((field) => passesColumnFilter(movie, field, columnFilters[field]));
}

export function toSortable(field, value) {
  if (field !== "rt" && field !== "metacritic" && field !== "year") {
    return String(value ?? "").toLowerCase();
  }
  if (value === "TODO") return -2;
  if (value === null || value === undefined) return -1;
  const n = parseFloat(value);
  return Number.isNaN(n) ? -1 : n;
}

export function compareMovies(a, b, field, dir) {
  const av = toSortable(field, a[field]);
  const bv = toSortable(field, b[field]);
  if (typeof av === "number" && typeof bv === "number") {
    return dir === "asc" ? av - bv : bv - av;
  }
  if (av < bv) return dir === "asc" ? -1 : 1;
  if (av > bv) return dir === "asc" ? 1 : -1;
  return 0;
}

/**
 * Returns only the first `count` rows of an already filtered/sorted array,
 * for capping how many DOM rows get rendered on large catalogs (filtering
 * and sorting themselves always run over the full array; this only limits
 * what actually gets painted).
 */
export function paginate(rows, count) {
  return rows.slice(0, Math.max(0, count));
}

/**
 * Reads the current column filters straight off the filter inputs, which are
 * the single source of truth for them.
 *
 * Deliberately not mirrored into a variable kept in sync by input events:
 * browsers restore text inputs on a soft reload (F5), setting the visible
 * value WITHOUT firing an input event. A mirrored copy therefore stayed
 * empty while the box showed e.g. "60", leaving a filter that was plainly
 * visible but had no effect at all. Reading the DOM at render time makes
 * that state impossible.
 *
 * `documentRef` is injected rather than taken from the global, so this stays
 * testable with a plain fake.
 */
export function readColumnFilters(documentRef) {
  const filters = {};
  const inputs = documentRef?.querySelectorAll?.(".filter-row input[data-filter]") || [];
  for (const input of inputs) {
    const field = input.getAttribute("data-filter");
    if (field) filters[field] = input.value ?? "";
  }
  return filters;
}
