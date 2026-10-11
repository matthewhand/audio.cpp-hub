/* #119: Stats must fit the viewport and scroll independently of the TTS workspace. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 }
]) {
  test(`Stats panel stays reachable and scrolls at ${viewport.width}x${viewport.height}`, async ({
    page
  }) => {
    await page.setViewportSize(viewport);
    await openApp(page, new MockBackend(), { lang: "en" });
    await page.locator("#stats-btn").click();
    await expect(page.locator("#stats-panel")).toBeVisible();
    await expect(page.locator("#stats-body .stats-model")).toHaveCount(2);

    // Supply enough rows to exceed the viewport without mutating backend data.
    const metrics = await page.evaluate(() => {
      const panel = globalThis.document.querySelector("#stats-panel .history-panel-card");
      const body = globalThis.document.querySelector("#stats-body");
      const list = body.querySelector(".stats-models");
      const original = list.querySelector(".stats-model");
      for (let n = 0; n < 16; n++) list.appendChild(original.cloneNode(true));
      const box = panel.getBoundingClientRect();
      const viewportWidth = globalThis.innerWidth;
      const viewportHeight = globalThis.innerHeight;
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        viewportWidth,
        viewportHeight,
        scrolls: body.scrollHeight > body.clientHeight,
        scrollMode: globalThis.getComputedStyle(body).overflowY
      };
    });
    expect(metrics.top).toBeGreaterThanOrEqual(0);
    expect(metrics.bottom).toBeLessThanOrEqual(metrics.viewportHeight + 1);
    expect(metrics.left).toBeGreaterThanOrEqual(0);
    expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.scrolls).toBe(true);
    expect(metrics.scrollMode).toBe("auto");
    await expect(page.locator("#stats-close")).toBeVisible();
  });
}
