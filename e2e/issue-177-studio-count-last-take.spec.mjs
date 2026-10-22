/* #177: Voice Studio character/word count and the Last take strip. */
/* global document */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const READY = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "Studio box",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 0
};

test("character and word count follows the script text", async ({ page }) => {
  await openApp(page, new MockBackend({ instances: [READY] }), {
    modelId: "supertonic",
    lang: "en"
  });
  const count = page.locator("#tts-char-count");
  await expect(count).toHaveText("0 chars · 0 words");
  await page.locator("#tts-text").fill("Hello there, brave new world");
  await expect(count).toHaveText("28 chars · 5 words");
  await expect(count).toHaveAttribute("aria-live", "polite");
});

test("Last take strip stays hidden until a TTS result, then plays the same history URL", async ({
  page
}) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  const strip = page.locator("#last-take");
  await expect(strip).toBeHidden();

  await page.locator("#tts-text").fill("One more take");
  await page.locator("#tts-submit").click();
  await expect(page.locator("#tts-result")).toBeVisible({ timeout: 12000 });

  await expect(strip).toBeVisible();
  await expect(page.locator("#last-take-title")).toHaveText("Last take");
  await expect(page.locator("#last-take-ago")).toHaveText("just now");
  await expect(page.locator("#last-take-wave rect")).toHaveCount(80);
  const src = await page.locator("#tts-player").getAttribute("src");
  await expect(page.locator("#last-take-download")).toHaveAttribute("href", src);
  await expect(page.locator("#last-take-wave")).toHaveAttribute("role", "slider");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("Last take reappears after a reload from the task list", async ({ page }) => {
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "en" });
  await page.locator("#tts-text").fill("Persisted take");
  await page.locator("#tts-submit").click();
  await expect(page.locator("#last-take")).toBeVisible({ timeout: 12000 });
  await page.reload();
  await expect(page.locator("#model-list .card-title").first()).toBeVisible();
  await expect(page.locator("#last-take")).toBeVisible({ timeout: 10000 });
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 360, height: 800 }
]) {
  test(`Last take controls stay inside the strip at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openApp(page, new MockBackend({ instances: [READY] }), {
      modelId: "supertonic",
      lang: "en"
    });
    await page.locator("#tts-text").fill("Contained take");
    await page.locator("#tts-submit").click();
    await expect(page.locator("#last-take")).toBeVisible({ timeout: 12000 });
    const escapes = await page.locator("#last-take").evaluate((strip) => {
      const outer = strip.getBoundingClientRect();
      const col = strip.closest(".studio-controls").getBoundingClientRect();
      const out = [...strip.children]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.left < outer.left - 1 || r.right > outer.right + 1;
        })
        .map((el) => el.id || el.className);
      if (outer.right > col.right + 1) out.push("strip escapes .studio-controls");
      return out;
    });
    expect(escapes).toEqual([]);
  });
}
