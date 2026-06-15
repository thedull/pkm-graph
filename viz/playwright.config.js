const { defineConfig } = require("@playwright/test");

// Allow overriding the port (e.g. PORT=3100 npx playwright test) so tests can
// avoid a port already taken by another process.
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: BASE_URL,
    headless: true,
  },
  // reuse a running server if present, else start one on the chosen port
  webServer: {
    command: "node server.js",
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 15000,
    env: { PORT: String(PORT) },
  },
});
