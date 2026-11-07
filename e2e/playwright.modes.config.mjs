/* Disposable test-only port: must not reuse another agent's localhost:4173. */
import { defineConfig } from "@playwright/test";
import base from "./playwright.config.mjs";
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://127.0.0.1:4295" },
  reporter: [["line"]],
  webServer: {
    ...base.webServer,
    url: "http://127.0.0.1:4295",
    command: "node static-server.mjs",
    env: { PORT: "4295" },
    reuseExistingServer: false
  }
});
