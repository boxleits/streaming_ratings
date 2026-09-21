import { test, expect } from "@playwright/test";

// Column filtering in a real browser. The regression these guard against is
// specifically a BROWSER behavior, invisible to unit tests: on a soft reload
// (F5) browsers restore a text input's value and fire no input event. While
// the page mirrored the filters into its own variable, that left a filter
// plainly visible in the box but with no effect at all - the table rendered
// unfiltered. See readColumnFilters in public/js/filters.js.

/** Seeds the catalog through the SSE stream the page already listens to. */
async function seedCatalog(page) {
  await page.addInitScript(() => {
    const movies = [
      { id: "1", title: { en: "Low Score" }, genres: { en: "Drama" }, year: "2001", rt: 30, metacritic: 30, watched: "N/A" },
      { id: "2", title: { en: "Mid Score" }, genres: { en: "Drama" }, year: "2002", rt: 65, metacritic: 65, watched: "N/A" },
      { id: "3", title: { en: "High Score" }, genres: { en: "Drama" }, year: "2003", rt: 92, metacritic: 92, watched: "N/A" },
    ];
    // Stand in for the server's stream so the test doesn't depend on any
    // real catalog, API key or cache state.
    class FakeEventSource {
      constructor() {
        this.readyState = 1;
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ type: "init", movies, engineStatus: null }) });
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    window.EventSource = FakeEventSource;
  });
}

test("a filter typed into a column applies to the table", async ({ page }) => {
  await seedCatalog(page);
  await page.goto("/");
  await expect(page.locator("tbody tr")).toHaveCount(3);

  await page.fill('input[data-filter="rt"]', "60");
  await expect(page.locator("tbody tr")).toHaveCount(2);

  await page.fill('input[data-filter="rt"]', "");
  await expect(page.locator("tbody tr")).toHaveCount(3);
});

test("a filter value already present on load applies too (browser restore after F5)", async ({ page }) => {
  await seedCatalog(page);
  // Serve the page with the input already carrying a value, which is the
  // state a browser leaves behind when it restores the field on reload:
  // a visible value that never produced an input event.
  await page.route("**/", async (route) => {
    const response = await route.fetch();
    const html = (await response.text()).replace(
      'data-filter="rt" data-placeholder="filterMinPlaceholder"',
      'data-filter="rt" value="60" data-placeholder="filterMinPlaceholder"'
    );
    await route.fulfill({ response, body: html });
  });

  await page.goto("/");
  await expect(page.locator('input[data-filter="rt"]')).toHaveValue("60");
  // The whole point: what the box shows is what the table shows.
  await expect(page.locator("tbody tr")).toHaveCount(2);
});

test("the clear-filters button empties the inputs and restores every row", async ({ page }) => {
  await seedCatalog(page);
  await page.goto("/");
  await page.fill('input[data-filter="rt"]', "60");
  await page.fill('input[data-filter="title"]', "high");
  await expect(page.locator("tbody tr")).toHaveCount(1);

  await page.click("#clearFiltersBtn");
  await expect(page.locator('input[data-filter="rt"]')).toHaveValue("");
  await expect(page.locator("tbody tr")).toHaveCount(3);
});
