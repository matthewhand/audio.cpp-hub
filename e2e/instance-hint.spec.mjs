/* #122: a clear model-specific readiness card and an actionable alternative. */
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

test("no ready instances: clearly explain how to start selected model", async ({ page }) => {
  await openApp(page, new MockBackend(), { modelId: selectedModelId, lang: "en" });
  const card = page.locator("#instance-context");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("aria-live", "polite");
  await expect(card).toContainText("Supertonic needs its own instance");
  await expect(card).toContainText("No instances are ready");
  await expect(page.locator("#instance-context-switch")).toBeHidden();
  await expect(page.locator("#instance-pill")).toHaveClass(/warn/);
});

test("one other model ready: explain mismatch, offer switch, capture UI", async ({ page }, testInfo) => {
  const backend = new MockBackend({ instances: [makeInstance("index_tts2")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  const card = page.locator("#instance-context");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Index TTS 2 is ready on this hub");
  const action = page.locator("#instance-context-switch");
  await expect(action).toBeVisible();
  await expect(action).toHaveText("Switch to Index TTS 2 →");
  await expect(page.locator("#instance-list .badge.ready")).toHaveCount(1);
  await testInfo.attach("readiness-card-after", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
  await action.click();
  await expect(page).toHaveURL(/#\/model\/index_tts2/);
  await expect(page.locator("#instance-context")).toBeHidden();
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/);
});

test("different other models ready: no misleading switch action", async ({ page }) => {
  const backend = new MockBackend({
    instances: [makeInstance("index_tts2"), makeInstance("miotts")]
  });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  await expect(page.locator("#instance-context")).toContainText(
    "2 instances are ready for other models"
  );
  await expect(page.locator("#instance-context-switch")).toBeHidden();
});

test("matching ready instance: card disappears and task submission enables", async ({ page }) => {
  const backend = new MockBackend({ instances: [makeInstance("index_tts2")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "zh" });
  await expect(page.locator("#instance-context")).toBeVisible();
  await expect(page.locator("#instance-context")).toContainText("需要独立的实例");
  backend.instances.push(makeInstance(selectedModelId));
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/, { timeout: 10000 });
  await expect(page.locator("#instance-context")).toBeHidden();
  await expect(page.locator("#tts-submit")).toBeEnabled();
});
