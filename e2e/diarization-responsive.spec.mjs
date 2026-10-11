import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp, pickAudioByPath } from "./helpers.mjs";

for (const viewport of [
  { name: "mobile", width: 390, height: 844 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1920, height: 1080 }
]) {
  test(`Sortformer responsive speaker timeline: ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const backend = new MockBackend({
      instances: [
        {
          id: "diar-ready",
          modelId: "sortformer_diar",
          instanceName: "sortformer_diar",
          status: "READY",
          backend: "cpu",
          port: 19002
        }
      ],
      asrResult: {
        sample_rate: 16000,
        speaker_turns: [
          { speaker_id: "speaker_0", start_sample: 0, end_sample: 32000 },
          { speaker_id: "speaker_1", start_sample: 25000, end_sample: 48000 }
        ]
      }
    });
    await openApp(page, backend, { modelId: "sortformer_diar", lang: "en" });
    await pickAudioByPath(page, "#asr-audio-picker", "/audio/two-speakers.wav");
    await page.locator("#asr-submit").click();
    await expect(page.locator("#asr-speaker-timeline")).toBeVisible({ timeout: 12000 });
    await expect(page.locator("#asr-speaker-timeline li")).toHaveCount(2);
    await page.screenshot({
      path: `docs/screenshots/diarization-${viewport.name}.png`,
      fullPage: true
    });
  });
}
