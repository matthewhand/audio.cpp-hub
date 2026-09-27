/* Playwright e2e 配置：headless Chromium，静态服务 web/，后端全部 mock。
   失败保留 trace + 截图，便于排查。无 GPU / 无 Go / 无模型。 */
import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = fileURLToPath(new URL(".", import.meta.url));
const rootDir = path.resolve(e2eDir, "..");

export default defineConfig({
  testDir: e2eDir,
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30000,
  expect: { timeout: 7000 },
  outputDir: path.join(rootDir, "test-results"),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(rootDir, "playwright-report") }]
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
  ],
  webServer: {
    command: "node static-server.mjs",
    cwd: e2eDir,
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 15000
  }
});
