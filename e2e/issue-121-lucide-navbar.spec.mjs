/* #121: accessible, licensed Lucide navbar icons on current Studio v3. */
import { expect, test } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 720 }
]) {
  test(`Lucide header works at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page, new MockBackend(), { lang: "en" });
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
      await expect(button.locator("svg use")).toHaveCount(1);
      await expect(button).toHaveAttribute("aria-label", /.+/);
    }
    const theme = page.locator("#theme-toggle use");
    const previous = await theme.getAttribute("href");
    await page.locator("#theme-toggle").click();
    await expect(theme).not.toHaveAttribute("href", previous);
    await page.locator("#lang-toggle").click();
    await expect(page.locator("#lang-label")).toHaveText("中文");
    expect(
      await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)
    ).toBe(true);
    await test.info().attach(`lucide-${viewport.width}x${viewport.height}`, {
      body: await page.screenshot(),
      contentType: "image/png"
    });
  });
}
