/* #119: previous READY is not proof of current availability after polling fails. */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

for (const [lang, warning] of [
  ["en", "Instance status unavailable"],
  ["zh", "实例状态暂不可用"]
]) {
  test(`failed instance poll warns and recovery restores controls (${lang})`, async ({ page }) => {
    const backend = new MockBackend({
      instances: [{
        id: "ready-breeze", modelId: "breeze-tts", instanceName: "Breeze",
        status: "READY", backend: "vulkan", device: 0, port: 19090
      }]
    });
    await openApp(page, backend, { modelId: "breeze-tts", lang });
    await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
    await expect(page.locator("#tts-submit")).toBeEnabled();

    const fail = (route) => route.fulfill({
      status: 503, contentType: "application/json",
      body: JSON.stringify({ error: "temporary network failure" })
    });
    await page.route("**/api/instances", fail);
    await expect(page.locator("#instance-pill")).toContainText(warning, { timeout: 12000 });
    await expect(page.locator("#instance-pill")).toHaveClass(/warn/);
    await expect(page.locator("#tts-submit")).toBeDisabled();
    await expect(page.locator("#instance-stop")).toBeDisabled();
    await expect(page.locator("#instance-list .stop-btn").first()).toBeDisabled();
    await expect(page.locator("#instance-context")).toBeHidden();

    await page.unroute("**/api/instances", fail);
    await expect(page.locator("#instance-pill")).toHaveClass(/ok/, { timeout: 12000 });
    await expect(page.locator("#tts-submit")).toBeEnabled();
    await expect(page.locator("#instance-list .stop-btn").first()).toBeEnabled();
  });
}
