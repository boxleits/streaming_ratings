import { defineConfig, devices } from "@playwright/test";

// E2E tests for frontend connection resilience (see tests/e2e/). The
// server starts automatically; real TMDB_API_KEY/OMDB_API_KEY are NOT
// needed for this, since these tests don't check movie data, only the
// SSE connection's behavior on network drops.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",

  use: {
    baseURL: process.env.BASE_URL || "http://localhost:3000",
    trace: "retain-on-failure",
  },

  webServer: {
    command: "node server.js",
    url: "http://localhost:3000/api/status",
    reuseExistingServer: !process.env.CI,
    timeout: 15000,
    env: {
      // Dummy values are enough: these tests don't check real movie data.
      TMDB_API_KEY: process.env.TMDB_API_KEY || "e2e-dummy-key",
      OMDB_API_KEY: process.env.OMDB_API_KEY || "e2e-dummy-key",
      CACHE_DIR: process.env.CACHE_DIR || "./.e2e-cache",
      PORT: "3000",
    },
  },

  projects: [
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 13"] },
    },
  ],
});
