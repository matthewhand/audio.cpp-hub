/* #71 e2e：提交 ASR 任务（本地路径取音频）→ 识别文本渲染。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp, pickAudioByPath } from "./helpers.mjs";

const READY = {
  id: "i2",
  modelId: "citrinet_asr",
  instanceName: "citrinet_asr",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19002,
  taskCount: 0,
};

test("ASR 任务：路径选音频 → 提交 → 识别文本展示", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "citrinet_asr", lang: "zh" });
  await expect(page.locator("#panel-asr")).toBeVisible();
  await expect(page.locator("#asr-submit")).toBeEnabled();

  await pickAudioByPath(page, "#asr-audio-picker", "/audio/sample.wav");
  await page.locator("#asr-submit").click();

  await expect(page.locator("#asr-result")).toBeVisible({ timeout: 12000 });
  await expect(page.locator("#asr-text")).toContainText("mock transcript");

  expect(backend.tasks).toHaveLength(1);
  expect(backend.tasks[0].category).toBe("asr");
});
