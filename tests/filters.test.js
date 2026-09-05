import { test } from "node:test";
import assert from "node:assert/strict";
import { formatScore, passesColumnFilter, passesAllColumnFilters, compareMovies, paginate } from "../public/js/filters.js";

test("formatScore: TODO / N-A / number are distinguished correctly", () => {
  assert.deepEqual(formatScore("TODO"), { text: "TODO", cls: "score-todo" });
  assert.deepEqual(formatScore(null), { text: "N/A", cls: "score-na" });
  assert.deepEqual(formatScore(87), { text: "87", cls: "score-value" });
});

test("passesColumnFilter: numeric RT filter is a minimum-rating filter", () => {
  assert.equal(passesColumnFilter({ rt: 55 }, "rt", "60"), false);
  assert.equal(passesColumnFilter({ rt: 60 }, "rt", "60"), true);
  assert.equal(passesColumnFilter({ rt: 75 }, "rt", "60"), true);
});

test("passesColumnFilter: TODO/N-A NEVER satisfy a numeric minimum-value filter", () => {
  assert.equal(passesColumnFilter({ rt: "TODO" }, "rt", "0"), false);
  assert.equal(passesColumnFilter({ rt: null }, "rt", "0"), false);
});

test("passesColumnFilter: text filter on RT/Metacritic matches as a substring of the display value", () => {
  assert.equal(passesColumnFilter({ rt: "TODO" }, "rt", "todo"), true);
  assert.equal(passesColumnFilter({ rt: null }, "rt", "n/a"), true);
  assert.equal(passesColumnFilter({ rt: 87 }, "rt", "n/a"), false);
});

test("passesColumnFilter: title/genre/year filter as substring, case-insensitive", () => {
  assert.equal(passesColumnFilter({ title: "Der Pate" }, "title", "pate"), true);
  assert.equal(passesColumnFilter({ year: "2021" }, "year", "202"), true);
  assert.equal(passesColumnFilter({ year: "2021" }, "year", "1999"), false);
});

test("passesAllColumnFilters: all set filters must match simultaneously (AND)", () => {
  const movie = { title: "Dune", year: "2021", rt: 83 };
  assert.equal(passesAllColumnFilters(movie, { title: "dune", year: "", rt: "80", metacritic: "" }), true);
  assert.equal(passesAllColumnFilters(movie, { title: "dune", year: "1999", rt: "80", metacritic: "" }), false);
});

test("compareMovies: TODO/N-A sort lower than real values in numeric fields", () => {
  const withTodo = { rt: "TODO" };
  const withNull = { rt: null };
  const withValue = { rt: 80 };
  // Descending: a real value should come before TODO/N-A -> negative result
  assert.ok(compareMovies(withValue, withTodo, "rt", "desc") < 0);
  assert.ok(compareMovies(withValue, withNull, "rt", "desc") < 0);
});

test("compareMovies: title sorts alphabetically (case-insensitive)", () => {
  assert.ok(compareMovies({ title: "banane" }, { title: "Apfel" }, "title", "asc") > 0);
});

test("paginate: returns only the first N rows without mutating the input", () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
  const page = paginate(rows, 3);
  assert.deepEqual(page, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.equal(rows.length, 5, "original array must stay untouched");
});

test("paginate: returns everything if count exceeds the row count", () => {
  const rows = [{ id: 1 }, { id: 2 }];
  assert.equal(paginate(rows, 200).length, 2);
});

test("paginate: treats a negative count as zero instead of throwing/slicing from the end", () => {
  const rows = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(paginate(rows, -5), []);
});
