/* #139: All header actions must remain visible and operable on narrow screens. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const viewports = [
  { width: 320, height: 720 },
  { width: 359, height: 780 },
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 }
];

async function expectHeaderFits(page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: globalThis.document.documentElement.scrollWidth,
    viewportWidth: globalThis.document.documentElement.clientWidth,
    buttons: [...globalThis.document.querySelectorAll(".header-actions > button")].map((el) => {
      const box = el.getBoundingClientRect();
      return { id: el.id, left: box.left, right: box.right, width: box.width, height: box.height };
    })
  }));
  expect(metrics.scrollWidth, "page must not horizontally overflow").toBeLessThanOrEqual(
    metrics.viewportWidth + 1
  );
  expect(metrics.buttons).toHaveLength(7);
  for (const button of metrics.buttons) {
    expect(button.left, button.id).toBeGreaterThanOrEqual(-1);
    expect(button.right, button.id).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(button.width, button.id).toBeGreaterThanOrEqual(38);
    expect(button.height, button.id).toBeGreaterThanOrEqual(38);
  }
}

async function expectPanelButtonsFit(page, selector, count) {
  const buttons = await page.locator(selector).evaluateAll((elements) =>
    elements.map((el) => {
      const box = el.getBoundingClientRect();
      return { id: el.id, left: box.left, right: box.right };
    })
  );
  expect(buttons).toHaveLength(count);
  const viewportWidth = page.viewportSize().width;
  for (const button of buttons) {
    expect(button.left, button.id).toBeGreaterThanOrEqual(-1);
    expect(button.right, button.id).toBeLessThanOrEqual(viewportWidth + 1);
  }
}

for (const viewport of viewports) {
  test("header actions fit and stay operable at " + viewport.width + "px", async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page, new MockBackend(), { modelId: "index_tts2", lang: "en" });
    await expectHeaderFits(page);

    await page.locator("#history-btn").click();
    await expect(page.locator("#history-panel")).toBeVisible();
    await expectPanelButtonsFit(page, "#history-panel .history-actions button", 5);
    await page.locator("#history-close").click();
    await expect(page.locator("#history-panel")).toBeHidden();

    await page.locator("#stats-btn").click();
    await expect(page.locator("#stats-panel")).toBeVisible();
    await expectPanelButtonsFit(page, "#stats-close", 1);
    await page.locator("#stats-close").click();
    await expect(page.locator("#stats-panel")).toBeHidden();

    const themeModeBefore = await page.locator("html").getAttribute("data-theme-mode");
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-mode", themeModeBefore);
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#lang-toggle").click();
    await expectHeaderFits(page);

    if (viewport.width <= 390) {
      await page.locator("#history-btn").click();
      await expect(page.locator("#history-panel")).toBeVisible();
      await expectPanelButtonsFit(page, "#history-panel .history-actions button", 5);
      await page.locator("#history-close").click();
    }

    if (viewport.width <= 768) {
      await page.locator("#menu-toggle").click();
      await expect(page.locator("#left")).toHaveClass(/open/);
    }
  });
}

for (const width of [320, 390]) {
  test("mobile TTS and playback stay reachable at " + width + "px", async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const backend = new MockBackend({
      instances: [
        {
          id: "mobile-ready",
          modelId: "supertonic",
          instanceName: "supertonic",
          status: "READY",
          backend: "cpu",
          device: 0,
          port: 19001,
          taskCount: 0
        }
      ]
    });
    await openApp(page, backend, { modelId: "supertonic", lang: "en" });
    await expectHeaderFits(page);
    await page.locator("#tts-text").fill("A mobile viewport speech sample.");
    await expect(page.locator("#tts-submit")).toBeEnabled();
    await page.locator("#tts-submit").click();
    await expect(page.locator("#tts-result")).toBeVisible({ timeout: 12000 });
    await expect(page.locator("#tts-player")).toHaveAttribute(
      "src",
      /\/api\/history\/supertonic\/t\d+\/audio/
    );
    await expect(page.locator("#tts-download")).toHaveAttribute(
      "href",
      /\/api\/history\/supertonic\/t\d+\/audio/
    );
    expect(backend.tasks).toHaveLength(1);
    expect(backend.tasks[0].status).toBe("DONE");
    await expectHeaderFits(page);
  });
}
