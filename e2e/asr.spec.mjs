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
  taskCount: 0
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

test("VibeVoice ASR displays real speaker IDs and sample-rate-derived timestamps", async ({
  page
}) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "vibevoice_asr", instanceName: "vibevoice_asr" }],
    asrResult: {
      text: "Hello. Hi back.",
      sample_rate: 16000,
      speaker_turns: [
        { speaker_id: 0, start_sample: 0, end_sample: 24000, text: "Hello." },
        { speaker_id: 1, start_sample: 24000, end_sample: 48000, text: "Hi back." }
      ]
    }
  });
  await openApp(page, backend, { modelId: "vibevoice_asr", lang: "en" });
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/two-speakers.wav");
  await page.locator("#asr-submit").click();
  const timeline = page.locator("#asr-speaker-timeline");
  await expect(timeline).toBeVisible({ timeout: 12000 });
  await expect(timeline.locator("li")).toHaveCount(2);
  await expect(timeline.locator("li").first()).toContainText("Speaker 0");
  await expect(timeline.locator("li").first()).toContainText("0:00.0 – 0:01.5");
  await expect(timeline.locator("li").last()).toContainText("Speaker 1");
  await expect(timeline.locator("li").last()).toContainText("0:01.5 – 0:03.0");
  await expect(page.locator("#asr-text")).toHaveText("Hello. Hi back.");
});

test("plain ASR stays transcript-only", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "citrinet_asr", lang: "en" });
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/ordinary.wav");
  await page.locator("#asr-submit").click();
  await expect(page.locator("#asr-result")).toBeVisible({ timeout: 12000 });
  await expect(page.locator("#asr-speaker-timeline")).toBeHidden();
});

test("invalid turns are skipped and speaker text cannot inject HTML", async ({ page }) => {
  const injected = '<img src=x onerror=alert("xss")>';
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "vibevoice_asr", instanceName: "vibevoice_asr" }],
    asrResult: {
      text: "Plain original.",
      sample_rate: 48000,
      speaker_turns: [
        { speaker_id: "A", start_sample: 48000, end_sample: 96000, text: injected },
        { speaker_id: "B", start_sample: -1, end_sample: 96000, text: "Bad offset" },
        { speaker_id: 1, start_sample: 48000, end_sample: 0, text: "Reversed" }
      ]
    }
  });
  await openApp(page, backend, { modelId: "vibevoice_asr", lang: "en" });
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/invalid.wav");
  await page.locator("#asr-submit").click();
  const timeline = page.locator("#asr-speaker-timeline");
  await expect(timeline).toBeVisible({ timeout: 12000 });
  await expect(timeline.locator("li")).toHaveCount(1);
  await expect(timeline).toContainText("Speaker A");
  await expect(timeline).toContainText("0:01.0 – 0:02.0");
  await expect(timeline).toContainText(injected);
  await expect(timeline.locator("img")).toHaveCount(0);
});

test("missing or invalid sample rates never produce guessed speaker times", async ({ page }) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "vibevoice_asr", instanceName: "vibevoice_asr" }],
    asrResult: {
      text: "Without timing units.",
      speaker_turns: [{ speaker_id: 0, start_sample: 0, end_sample: 16000, text: "No timestamp" }]
    }
  });
  await openApp(page, backend, { modelId: "vibevoice_asr", lang: "en" });
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/missing-sample-rate.wav");
  await page.locator("#asr-submit").click();
  await expect(page.locator("#asr-result")).toBeVisible({ timeout: 12000 });
  await expect(page.locator("#asr-speaker-timeline")).toBeHidden();
  await expect(page.locator("#asr-text")).toHaveText("Without timing units.");
});

test("Sortformer diarization submits audio and displays timed, textless speaker turns", async ({
  page
}) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "sortformer_diar", instanceName: "sortformer_diar" }],
    asrResult: {
      sample_rate: 16000,
      speaker_turns: [
        { speaker_id: "speaker_1", start_sample: 16000, end_sample: 48000 },
        { speaker_id: "speaker_0", start_sample: 0, end_sample: 24000 }
      ]
    }
  });
  await openApp(page, backend, { modelId: "sortformer_diar", lang: "en" });
  await expect(page.locator("#asr-title")).toContainText("Sortformer");
  await expect(page.locator("#asr-submit")).toHaveText("Analyze speakers");
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/two-speakers.wav");
  await page.locator("#asr-submit").click();
  await expect(page.locator("#asr-result")).toBeVisible({ timeout: 12000 });
  const timeline = page.locator("#asr-speaker-timeline");
  await expect(timeline).toBeVisible();
  await expect(timeline.locator("li")).toHaveCount(2);
  await expect(timeline.locator("li").first()).toContainText("Speaker speaker_0");
  await expect(timeline.locator("li").last()).toContainText("0:01.0 – 0:03.0");
  await expect(page.locator("#asr-text")).toContainText("does not transcribe");
  await expect(page.locator("#asr-diar-status")).toBeHidden();
  expect(backend.tasks).toHaveLength(1);
  expect(backend.tasks[0].category).toBe("asr");
});

test("Sortformer never fakes successful diarization for an unsupported backend", async ({
  page
}) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "sortformer_diar", instanceName: "sortformer_diar" }],
    asrResult: { text: "Not speaker aware" }
  });
  await openApp(page, backend, { modelId: "sortformer_diar", lang: "en" });
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/unsupported.wav");
  await page.locator("#asr-submit").click();
  await expect(page.locator("#asr-result")).toBeVisible({ timeout: 12000 });
  await expect(page.locator("#asr-speaker-timeline")).toBeHidden();
  await expect(page.locator("#asr-diar-status")).toContainText("diarization is unavailable");
});

test("Sortformer distinguishes silence from invalid timestamps", async ({ page }) => {
  const backend = new MockBackend({
    instances: [{ ...READY, modelId: "sortformer_diar", instanceName: "sortformer_diar" }],
    asrResult: { sample_rate: 16000, speaker_turns: [] }
  });
  await openApp(page, backend, { modelId: "sortformer_diar", lang: "en" });
  await pickAudioByPath(page, "#asr-audio-picker", "/audio/silent.wav");
  await page.locator("#asr-submit").click();
  await expect(page.locator("#asr-diar-status")).toContainText("No speaker turns");
});
