/* #71 e2e：音色库添加音色（名称 + 本地路径音频）。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp, pickAudioByPath } from "./helpers.mjs";

test("音色库：添加音色后列表出现", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  await page.locator("#voices-btn").click();
  await expect(page.locator("#voices-panel")).toBeVisible();
  await expect(page.locator("#voices-list")).toContainText("暂无音色");

  await page.locator("#voice-add-name").fill("Alice");
  await page.locator("#voice-add-text").fill("这是参考文本");
  await pickAudioByPath(page, "#voice-add-picker", "/audio/alice.wav");
  await page.locator("#voice-add-btn").click();

  await expect(page.locator("#voices-list .voice-row .voice-name")).toHaveText("Alice");
  expect(backend.voices).toHaveLength(1);
  expect(backend.voices[0]).toMatchObject({ name: "Alice", text: "这是参考文本" });
});
