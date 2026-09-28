/* #71 e2e：模型切换、主题切换、语言切换。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("模型切换：TTS 面板切到 ASR 面板", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  await expect(page.locator("#panel-tts")).toBeVisible();

  await page.locator("#model-list .card", { hasText: "Citrinet ASR" }).click();
  await expect(page.locator("#panel-asr")).toBeVisible();
  await expect(page.locator("#panel-tts")).toBeHidden();

  await page.locator("#model-list .card", { hasText: "Supertonic" }).click();
  await expect(page.locator("#panel-tts")).toBeVisible();
  await expect(page.locator("#panel-asr")).toBeHidden();
});

test("主题切换：light ↔ dark", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh", theme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("语言切换：zh → en 时静态与动态文案同步刷新", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("#lang-toggle")).toHaveText("EN");

  await page.locator("#lang-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("#lang-toggle")).toHaveText("中文");
  await expect(page.locator("#tts-title")).toContainText("Text to Speech");
  await expect(page.locator("#settings-btn")).toHaveAttribute("title", "Settings");
});
