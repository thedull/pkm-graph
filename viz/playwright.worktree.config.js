const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
  },
  webServer: {
    command: "PORT=3001 node server.js",
    url: "http://localhost:3001",
    reuseExistingServer: false,
    timeout: 15000,
  },
});
