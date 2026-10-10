/* #71 e2e：模型切换、主题切换、语言切换。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const READY = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "supertonic",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 0
};

const modelsPanelOpen = (page) => page.locator("#model-panel").evaluate((el) => el.open);

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

test("模型区折叠：有实例时默认收起，点开summary 后仍可切换模型", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  // 有实例 → 默认收起，summary 上仍有计数徽标（展开前也看得出有几个模型）
  expect(await modelsPanelOpen(page)).toBe(false);
  await expect(page.locator("#model-count")).toHaveText(/^\d+$/);
  await expect(page.locator("#model-list .card").first()).toBeHidden();

  await page.locator("#model-panel > summary").click();
  expect(await modelsPanelOpen(page)).toBe(true);
  await page.locator("#model-list .card", { hasText: "Citrinet ASR" }).click();
  await expect(page.locator("#panel-asr")).toBeVisible();

  // 折叠状态记在 localStorage：刷新后仍是展开的
  await page.reload();
  await expect(page.locator("#model-panel > summary")).toBeVisible();
  expect(await modelsPanelOpen(page)).toBe(true);
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
