/* #71 e2e：提交 TTS 任务并在任务结束后看到结果音频（复用历史 wav URL）。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const READY = {
  id: "i1", modelId: "supertonic", instanceName: "supertonic", status: "READY",
  backend: "cpu", device: 0, port: 19001, taskCount: 0
};

test("TTS 任务：提交 → 轮询到 DONE → 结果音频可见", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  await expect(page.locator("#tts-submit")).toBeEnabled();

  await page.locator("#tts-text").fill("你好，世界");
  await page.locator("#tts-submit").click();

  await expect(page.locator("#tts-result")).toBeVisible({ timeout: 12000 });
  await expect(page.locator("#tts-player")).toHaveAttribute("src", /\/api\/history\/supertonic\/t\d+\/audio/);
  await expect(page.locator("#tts-download")).toHaveAttribute("href", /\/api\/history\/supertonic\/t\d+\/audio/);

  expect(backend.tasks).toHaveLength(1);
  expect(backend.tasks[0].category).toBe("tts");
  expect(backend.tasks[0].status).toBe("DONE");
});
