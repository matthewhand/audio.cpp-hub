/* #71 e2e：提交 TTS 任务并在任务结束后看到结果音频（复用历史 wav URL）。 */
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

test("TTS 任务：提交 → 轮询到 DONE → 结果音频可见", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
  await expect(page.locator("#tts-submit")).toBeEnabled();

  await page.locator("#tts-text").fill("你好，世界");
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
  expect(backend.tasks[0].category).toBe("tts");
  expect(backend.tasks[0].status).toBe("DONE");
});

test("Kokoro TTS：单控件无重复渲染，所选 voice_id 正确写入 options 且顶层无冲突 (#210)", async ({
  page
}) => {
  const KOKORO_READY = {
    id: "i2",
    modelId: "kokoro_tts",
    instanceName: "kokoro",
    status: "READY",
    backend: "cpu",
    device: 0,
    port: 19002,
    taskCount: 0
  };
  const backend = new MockBackend({ instances: [KOKORO_READY] });
  await openApp(page, backend, { modelId: "kokoro_tts", lang: "zh" });
  await expect(page.locator("#tts-submit")).toBeEnabled();

  // 验证 DOM 中只有一个 voice_id 控件，高级参数中没有 adv-voice_id
  await expect(page.locator("#tts-enum-voice_id")).toHaveCount(1);
  await expect(page.locator("#adv-voice_id")).toHaveCount(0);

  // 选中非默认音色 jf_alpha
  await page.locator("#tts-enum-voice_id").selectOption("jf_alpha");
  await page.locator("#tts-text").fill("Hello Kokoro");
  await page.locator("#tts-submit").click();

  await expect(page.locator("#tts-result")).toBeVisible({ timeout: 12000 });

  expect(backend.tasks).toHaveLength(1);
  const task = backend.tasks[0];
  expect(task.request?.options?.voice_id).toBe("jf_alpha");
  expect(task.request?.voice_id).toBeUndefined();
});

test("Kokoro phoneme chunks survive submission and history restore", async ({ page }) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "kokoro_tts", instanceName: "kokoro" }]
  });
  await openApp(page, backend, { modelId: "kokoro_tts", lang: "en" });
  await page.locator("#tts-advanced summary").click();
  const phonemes = page.getByRole("textbox", { name: /^Phonemes/ });
  await expect(phonemes).toBeVisible();
  await page.locator("#tts-text").fill("Text for Kokoro");
  const submit = page.locator("#tts-submit");

  const chunks = ["həlˈO", "wˈɜɹld"];
  await phonemes.fill(chunks.join("\n\n"));
  await submit.click();
  await expect.poll(() => backend.tasks.length).toBe(1);
  expect(backend.tasks[0].request?.options?.phonemes).toEqual(chunks);
  expect(backend.tasks[0].request?.phonemes).toBeUndefined();

  const restore = (options) =>
    page.evaluate(async (savedOptions) => {
      const { fillTtsForm } = await import("/modules/panels.js");
      const { selectedModel } = await import("/modules/state.js");
      fillTtsForm(selectedModel(), { text: "Restored", options: savedOptions });
    }, options);
  await phonemes.fill("stale");
  await restore({ phonemes: chunks });
  await expect(phonemes).toHaveValue(chunks.join("\n"));
  await restore({});
  await expect(phonemes).toHaveValue("");
  await submit.click();
  await expect.poll(() => backend.tasks.length).toBe(2);
  expect(backend.tasks[1].request?.options?.phonemes).toBeUndefined();
});
