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

  const voice = page.locator("#tts-enum-voice_id");
  const language = page.locator("#tts-language");
  const hint = page.locator("#tts-preset-voice-hint");
  await expect(voice).toHaveValue("af_heart");
  await expect(voice.locator("optgroup")).toHaveCount(9);
  await expect(voice.locator("option")).toHaveCount(54);
  await expect(voice.locator('option[value="af_heart"]')).toHaveText("Heart · 女声");

  await language.selectOption("zh");
  await expect(voice).toHaveValue("zf_xiaobei");
  await expect(voice.locator("optgroup").first()).toHaveAttribute("label", "普通话");
  await language.selectOption("ja");
  await expect(voice).toHaveValue("jf_alpha");
  await expect(voice.locator('option[value="jf_alpha"]')).toContainText("UniDic");
  await expect(hint).toBeHidden();

  await language.selectOption("zh");
  await voice.selectOption("jf_alpha");
  await expect(hint).toContainText("日语");
  await expect(hint).toContainText("普通话");

  await language.selectOption("en-gb");
  await page.evaluate(async () => {
    const { fillTtsForm } = await import("/modules/panels.js");
    const { selectedModel } = await import("/modules/state.js");
    fillTtsForm(selectedModel(), {
      text: "Hello Kokoro",
      language: "zh",
      options: { voice_id: "jf_alpha" }
    });
  });
  await expect(language).toHaveValue("zh");
  await expect(voice).toHaveValue("jf_alpha");
  await expect(hint).toBeVisible();
  await page.locator("#tts-advanced summary").click();
  const chunkSize = page.locator("#adv-text_chunk_size");
  await expect(chunkSize).toHaveValue("");
  await expect(chunkSize).toHaveAttribute("min", "1");
  await chunkSize.fill("0");
  await page.locator("#tts-submit").click();
  expect(backend.tasks).toHaveLength(0);
  await chunkSize.fill("1.5");
  await page.locator("#tts-submit").click();
  expect(backend.tasks).toHaveLength(0);
  await chunkSize.fill("80");
  await page.locator("#tts-submit").click();

  await expect(page.locator("#tts-result")).toBeVisible({ timeout: 12000 });

  expect(backend.tasks).toHaveLength(1);
  const task = backend.tasks[0];
  expect(task.request?.language).toBe("zh");
  expect(task.request?.options?.voice_id).toBe("jf_alpha");
  expect(task.request?.voice_id).toBeUndefined();
  expect(task.request?.options?.text_chunk_size).toBe(80);
  expect(task.request?.text_chunk_size).toBeUndefined();

  await chunkSize.fill("");
  await page.locator("#tts-submit").click();
  await expect.poll(() => backend.tasks.length).toBe(2);
  expect(backend.tasks[1].request?.options?.text_chunk_size).toBeUndefined();
});

test("Kokoro voice blends round-trip through the form and task options", async ({ page }) => {
  const backend = new MockBackend({
    instances: [{ ...READY, id: "kokoro-ready", modelId: "kokoro_tts", instanceName: "kokoro" }]
  });
  await openApp(page, backend, { modelId: "kokoro_tts", lang: "en" });
  await expect(page.locator("#tts-submit")).toBeEnabled();
  await page.locator("#tts-advanced summary").click();
  const blend = page.getByRole("textbox", { name: /^Voice blend/ });
  const preset = page.locator("#tts-enum-voice_id");
  const expression = "af_heart(2)+af_bella(1)";
  await expect(blend).toHaveValue("");
  const presetHint = page.locator("#tts-preset-voice-hint");
  await preset.selectOption("jf_alpha");
  await expect(presetHint).toBeVisible();
  await blend.fill("  " + expression + "  ");
  await expect(presetHint).toBeHidden();
  await page.locator("#tts-text").fill("Hello Kokoro");
  await page.locator("#tts-submit").click();
  await expect.poll(() => backend.tasks.length).toBe(1);
  expect(backend.tasks[0].request?.options?.voice_id).toBe(expression);
  expect(backend.tasks[0].request?.options?.voice_blend).toBeUndefined();
  expect(backend.tasks[0].request?.voice_id).toBeUndefined();

  await blend.fill("");
  await expect(presetHint).toBeVisible();
  const restore = (voiceId) =>
    page.evaluate(async (saved) => {
      const { fillTtsForm } = await import("/modules/panels.js");
      const { selectedModel } = await import("/modules/state.js");
      fillTtsForm(selectedModel(), {
        text: "Saved take",
        language: "en-us",
        options: { voice_id: saved }
      });
    }, voiceId);
  await restore(expression);
  await expect(blend).toHaveValue(expression);
  await expect(preset).toHaveValue("af_heart");
  await restore("af_nova");
  await expect(blend).toHaveValue("");
  await expect(preset).toHaveValue("af_nova");
  await page.locator("#tts-submit").click();
  await expect.poll(() => backend.tasks.length).toBe(2);
  expect(backend.tasks[1].request?.options?.voice_id).toBe("af_nova");
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

test("Kokoro timestamps are opt-in and restored from history", async ({ page }) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "kokoro_tts", instanceName: "kokoro" }]
  });
  await openApp(page, backend, { modelId: "kokoro_tts", lang: "en" });
  await page.locator("#tts-advanced summary").click();
  const timestamps = page.getByRole("checkbox", { name: "Save phoneme-group timestamps" });
  await expect(timestamps).not.toBeChecked();
  await page.locator("#tts-text").fill("Hello Kokoro");

  const submit = page.locator("#tts-submit");
  await submit.click();
  await expect.poll(() => backend.tasks.length).toBe(1);
  expect(backend.tasks[0].request?.options?.return_timestamps).toBeUndefined();

  await timestamps.check();
  await submit.click();
  await expect.poll(() => backend.tasks.length).toBe(2);
  expect(backend.tasks[1].request?.options?.return_timestamps).toBe(true);
  expect(backend.tasks[1].request?.return_timestamps).toBeUndefined();

  const restore = (options) =>
    page.evaluate(async (savedOptions) => {
      const { fillTtsForm } = await import("/modules/panels.js");
      const { selectedModel } = await import("/modules/state.js");
      fillTtsForm(selectedModel(), { text: "Restored", options: savedOptions });
    }, options);
  await timestamps.uncheck();
  await restore({ return_timestamps: "yes" });
  await expect(timestamps).toBeChecked();
  await restore({});
  await expect(timestamps).not.toBeChecked();
});

test("VibeVoice submits the catalog's dialogue tags and renumbers voice pickers", async ({
  page
}) => {
  const modelId = "vibevoice";
  const backend = new MockBackend({
    instances: [{ ...READY, modelId, instanceName: "vibevoice" }]
  });
  const { speakerTagFormat, speakerIndexBase, maxSpeakers } = backend.models.find(
    (card) => card.id === modelId
  ).capabilities;
  await openApp(page, backend, { modelId, lang: "en" });
  const add = page.locator("#tts-speaker-add");
  const speakers = page.locator("#tts-speakers-list .speaker-row");
  await expect(speakers).toHaveCount(1);
  const turns = [];
  for (let i = 0; i < maxSpeakers; i++) {
    if (i > 0) {
      await add.click();
      await expect(speakers).toHaveCount(i + 1);
      await speakers.nth(i).locator("summary").click();
    }
    const line = `Turn ${i + 1}.`;
    await speakers.nth(i).locator(".speaker-lines").fill(line);
    const tag = speakerTagFormat.replace("{n}", String(speakerIndexBase + i));
    turns.push(`${tag} ${line}`);
  }
  await expect(add).toBeDisabled();
  await page.locator("#tts-submit").click();
  await expect.poll(() => backend.tasks.length).toBe(1);
  expect(backend.tasks[0].request.text).toBe(turns.join("\n"));

  await speakers.nth(1).locator(".speaker-remove").click();
  await expect(speakers).toHaveCount(maxSpeakers - 1);
  await expect(speakers.nth(1).locator(".speaker-label")).toHaveText("Speaker 2");
  await expect(speakers.nth(1).locator(".vs-select")).toHaveAttribute("aria-label", "Speaker 2");
  await expect(speakers.nth(1).locator(".speaker-lines")).toHaveValue("Turn 3.");
  await expect(add).toBeEnabled();
});
