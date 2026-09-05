import { test, expect } from "@playwright/test";

// These tests run in real Chromium/WebKit instances with mobile device
// emulation (see playwright.config.js: "mobile-chrome" uses Pixel 5,
// "mobile-safari" uses iPhone 13). They verify actual browser behavior,
// not just the isolated logic (that's already covered by the unit tests
// in tests/connection.test.js).
//
// staleMs/watchdogMs in the URL are a deliberate test hook (see
// public/index.html) so we don't have to wait 35 real seconds for the
// production watchdog.

test("connection recovers automatically after a real network drop", async ({ page, context }) => {
  const streamRequestTimes = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/stream")) streamRequestTimes.push(Date.now());
  });

  await page.goto("/?staleMs=1500&watchdogMs=500");
  await expect(page.locator("#tmdbStatusText")).toBeVisible();
  await page.waitForTimeout(500); // let the initial connection establish
  expect(streamRequestTimes.length).toBeGreaterThanOrEqual(1);

  // Cut the network entirely - Playwright's closest equivalent to a
  // cellular/Wi-Fi outage, or the OS hard-killing the connection when the
  // screen locks.
  await context.setOffline(true);
  await page.waitForTimeout(2000); // > staleMs; the watchdog already tries, but can't get through while offline

  await context.setOffline(false);

  // At the latest on the next watchdog tick (500ms), a new /api/stream
  // connection should be established.
  await expect
    .poll(() => streamRequestTimes.length, { timeout: 10000, message: "no new /api/stream connection after network recovery" })
    .toBeGreaterThanOrEqual(2);
});

test("connection recovers when the tab becomes visible again after inactivity", async ({ page }) => {
  const streamRequestTimes = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/stream")) streamRequestTimes.push(Date.now());
  });

  // Watchdog timer deliberately set very sluggish so that in this test
  // ONLY the visibility change triggers the reconnect (not the timer).
  await page.goto("/?staleMs=1000&watchdogMs=120000");
  await page.waitForTimeout(300);
  const initialCount = streamRequestTimes.length;
  expect(initialCount).toBeGreaterThanOrEqual(1);

  // Let the connection go "stale" (> staleMs) without the sluggish
  // watchdog timer interfering in the meantime.
  await page.waitForTimeout(1500);

  // Simulate a visibility change: page becomes "hidden", then "visible"
  // again - reproducing the behavior of unlocking a phone.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect
    .poll(() => streamRequestTimes.length, { timeout: 5000, message: "no reconnect triggered after visibility change" })
    .toBeGreaterThan(initialCount);
});

test("no unnecessary reconnect while the connection is fresh and the page stays visible", async ({ page }) => {
  const streamRequestTimes = [];
  page.on("request", (req) => {
    if (req.url().includes("/api/stream")) streamRequestTimes.push(Date.now());
  });

  await page.goto("/?staleMs=5000&watchdogMs=300");
  await page.waitForTimeout(1500); // well below staleMs, several watchdog ticks pass

  // Only the initial connection should exist - no reason for reconnects.
  expect(streamRequestTimes.length).toBe(1);
});
