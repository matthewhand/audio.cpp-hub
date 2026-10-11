/* #119: empty history belongs to the selected model, not the whole hub. */
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers.mjs";
import { MockBackend } from "./mock-backend.mjs";

for (const scenario of [
  { modelId: "breeze-tts", name: /Breeze/i },
  { modelId: "sanotts", name: /Sano/i }
]) {
  test(`empty history identifies selected model: ${scenario.modelId}`, async ({ page }) => {
    await openApp(page, new MockBackend(), { modelId: scenario.modelId, lang: "en" });
    await page.locator("#history-btn").click();
    await expect(page.locator("#history-panel")).toBeVisible();
    const list = page.locator("#history-list");
    await expect(list).toContainText("No takes for");
    await expect(list).toContainText(scenario.name);
    await expect(list).toContainText("model-specific history");
  });
}
