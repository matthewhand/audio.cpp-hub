/* #119: failed stop requests must be visible to operators. */
import { expect, test } from "@playwright/test";
import { openApp } from "./helpers.mjs";
import { MockBackend } from "./mock-backend.mjs";

test("failed Stop actions report an error without hiding the READY instance", async ({ page }) => {
  const backend = new MockBackend({
    instances: [
      {
        id: "breeze1",
        instanceName: "Breeze TTS",
        modelId: "breeze-tts",
        status: "READY",
        backend: "vulkan",
        device: 0,
        port: 18090,
        taskCount: 0
      }
    ]
  });
  await openApp(page, backend, { modelId: "breeze-tts", lang: "en" });
  await expect(page.locator("#instance-stop")).toBeEnabled();

  // Force an API failure without actually terminating any model process.
  await page.route("**/api/instances/**", (route) => {
    if (route.request().method() === "DELETE") {
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "service unavailable" })
      });
    }
    return route.continue();
  });

  await page.locator("#instance-stop").click();
  await expect(page.locator("#toast-root .toast.error").last()).toContainText(
    "Could not stop instance"
  );
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/);

  await page.locator("#instance-list .stop-btn").first().click();
  await expect(page.locator("#toast-root .toast.error")).toHaveCount(2);
  await expect(page.locator("#instance-list")).toContainText("Breeze TTS");
});
