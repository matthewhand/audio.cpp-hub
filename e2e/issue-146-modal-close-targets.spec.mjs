/* Issue #146: modal close buttons are touch targets on mobile.
   The Settings and Downloads close buttons must be >=44x44 CSS px at 320/390/720
   viewports, keep their "x" glyph centered, and stay clickable in English and Chinese. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const TITLE = {
  settings: { en: "Settings", zh: "设置" },
  downloads: { en: "Downloads", zh: "下载管理" }
};

/** Button box (CSS px) plus how far the "x" glyph drifts from the horizontal center. */
async function closeTarget(page, selector) {
  return page.evaluate((sel) => {
    const el = globalThis.document.querySelector(sel);
    const box = el.getBoundingClientRect();
    const range = globalThis.document.createRange();
    range.selectNodeContents(el);
    const glyph = range.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      glyphOffsetX: Math.abs(glyph.left + glyph.width / 2 - (box.left + box.width / 2))
    };
  }, selector);
}

for (const width of [320, 359, 360, 390, 720]) {
  for (const lang of ["en", "zh"]) {
    test(`#146 modal close targets >=44x44 at ${width}px (${lang})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await openApp(page, new MockBackend(), { lang });

      // Settings modal: open, measure the close target, click it.
      await page.locator("#settings-btn").click();
      await expect(page.locator("#settings-modal")).toBeVisible();
      await expect(page.locator("#settings-pane-general")).toBeVisible();
      await expect(page.locator("#settings-modal-title")).toHaveText(TITLE.settings[lang]);
      await expect(page.locator("#settings-modal-close")).toBeVisible();
      await expect(page.locator("#settings-modal .modal")).toHaveCSS("opacity", "1");
      const settingsClose = await closeTarget(page, "#settings-modal-close");
      expect(settingsClose.width).toBeGreaterThanOrEqual(44);
      expect(settingsClose.height).toBeGreaterThanOrEqual(44);
      expect(settingsClose.glyphOffsetX).toBeLessThanOrEqual(2);
      await page.locator("#settings-modal-close").click();
      await expect(page.locator("#settings-modal")).toBeHidden();

      // Downloads modal: same contract.
      await page.locator("#downloads-btn").click();
      await expect(page.locator("#downloads-modal")).toBeVisible();
      await expect(page.locator("#dl-list .state-box")).toBeVisible();
      await expect(page.locator("#downloads-modal-title")).toHaveText(TITLE.downloads[lang]);
      await expect(page.locator("#downloads-modal-close")).toBeVisible();
      await expect(page.locator("#downloads-modal .modal")).toHaveCSS("opacity", "1");
      const downloadsClose = await closeTarget(page, "#downloads-modal-close");
      expect(downloadsClose.width).toBeGreaterThanOrEqual(44);
      expect(downloadsClose.height).toBeGreaterThanOrEqual(44);
      expect(downloadsClose.glyphOffsetX).toBeLessThanOrEqual(2);
      await page.locator("#downloads-modal-close").click();
      await expect(page.locator("#downloads-modal")).toBeHidden();
    });
  }
}
