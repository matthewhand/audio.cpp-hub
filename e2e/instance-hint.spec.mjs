/* #122: alternate-model readiness and safe one-click navigation. */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const selectedModelId = "supertonic";

function makeInstance(modelId, status = "READY") {
  return {
    id: "instance-" + modelId,
    modelId,
    instanceName: modelId,
    status,
    backend: "cpu",
    device: 0,
    port: 19001,
    taskCount: 0
  };
}

test("none ready: selected model has clear guidance and no switches", async ({ page }) => {
  await openApp(page, new MockBackend(), { modelId: selectedModelId, lang: "en" });
  const card = page.locator("#instance-context");
  await expect(card).toBeVisible();
  await expect(page.locator("#instance-context-copy")).toHaveAttribute("aria-live", "polite");
  await expect(card).toContainText("Supertonic needs its own instance");
  await expect(card).toContainText("No instances are ready");
  await expect(page.locator(".instance-context-option")).toHaveCount(0);
});

test("one model ready: show one actionable alternative", async ({ page }) => {
  const backend = new MockBackend({ instances: [makeInstance("index_tts2")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  const action = page.locator(".instance-context-option");
  await expect(action).toHaveCount(1);
  await expect(action).toContainText("Index TTS 2");
  await expect(action).toContainText(":19001");
  await action.click();
  await expect(page).toHaveURL(/#\/model\/index_tts2/);
  await expect(page.locator("#instance-context")).toBeHidden();
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
});

test("two different models ready: offer both and capture UI", async ({ page }, testInfo) => {
  const backend = new MockBackend({
    instances: [makeInstance("index_tts2"), makeInstance("miotts")]
  });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  const options = page.locator(".instance-context-option");
  await expect(options).toHaveCount(2);
  await expect(page.locator("#instance-context")).toContainText("2 ready instances");
  await testInfo.attach("readiness-multi-model-after", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await options.nth(1).click();
  await expect(page).toHaveURL(/#\/model\/miotts/);
  await expect(page.locator("#instance-context")).toBeHidden();
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
});

test("unregistered ready model: never offer a broken model switch", async ({ page }) => {
  const backend = new MockBackend({ instances: [makeInstance("unknown-model")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  await expect(page.locator("#instance-context")).toContainText("not listed here");
  await expect(page.locator(".instance-context-option")).toHaveCount(0);
});

test("matching instance becomes ready: card hides and submit enables", async ({ page }) => {
  const backend = new MockBackend({ instances: [makeInstance("index_tts2")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "zh" });
  await expect(page.locator("#instance-context")).toBeVisible();
  await expect(page.locator("#instance-context")).toContainText("需要独立的实例");
  backend.instances.push(makeInstance(selectedModelId));
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/, { timeout: 10000 });
  await expect(page.locator("#instance-context")).toBeHidden();
  await expect(page.locator("#tts-submit")).toBeEnabled();
});
