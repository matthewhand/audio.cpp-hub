/* #121 independent QA: keyboard access, SVG semantics and narrow viewports. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

for (const viewport of [
  { width: 320, height: 700 },
  { width: 768, height: 1024 },
  { width: 1920, height: 1080 }
]) {
  test(`Lucide icons preserve keyboard and ARIA at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page, new MockBackend(), { lang: "en", theme: "light" });
    for (const id of [
      "menu-toggle",
      "voices-btn",
      "history-btn",
      "downloads-btn",
      "stats-btn",
      "lang-toggle",
      "settings-btn",
      "theme-toggle"
    ]) {
      const button = page.locator("#" + id);
      await expect(button).toHaveAttribute("aria-label", /\\S/);
      await expect(button.locator("svg")).toHaveAttribute("aria-hidden", "true");
      const href = await button.locator("svg use").getAttribute("href");
      expect(href).toMatch(/^#i-[\\w-]+$/);
      await expect(page.locator(`svg.icon-sprite symbol[id="${href.slice(1)}"]`)).toHaveCount(1);
    }

    await page.locator("#history-btn").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#history-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#history-panel")).toBeHidden();

    await page.locator("#settings-btn").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#theme-toggle")).toBeFocused();
    const outlineWidth = await page.locator("#theme-toggle").evaluate((button) => {
      return parseFloat(globalThis.getComputedStyle(button).outlineWidth);
    });
    expect(outlineWidth).toBeGreaterThan(0);
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("#theme-toggle use")).toHaveAttribute("href", "#i-moon");

    await page.locator("#lang-toggle").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#lang-label")).toHaveText("EN");
    const fits = await page.evaluate(() => {
      return globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth;
    });
    expect(fits).toBe(true);
    await test.info().attach(`lucide-qa-${viewport.width}`, {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png"
    });
  });
}
