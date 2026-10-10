/* #122: context when the selected model has no compatible ready instance. */
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

test("no running instance: show actionable model-specific hint", async ({ page }) => {
  await openApp(page, new MockBackend(), { modelId: selectedModelId, lang: "en" });
  const hint = page.locator("#instance-context-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("No ready instance for");
  await expect(hint).toContainText("Launch this model");
  await expect(page.locator("#instance-pill")).toHaveClass(/warn/);
});

test("other model ready: clarify why selected model cannot submit", async ({ page }, testInfo) => {
  const backend = new MockBackend({ instances: [makeInstance("index_tts2")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  const hint = page.locator("#instance-context-hint");
  await expect(hint).toBeVisible();
  await expect(hint).toContainText("Another model has a ready instance");
  await expect(page.locator("#instance-pill")).toHaveClass(/warn/);
  await expect(page.locator("#instance-list .badge.ready")).toHaveCount(1);
  await testInfo.attach("updated-context-hint", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png"
  });
});

test("two other models ready: show a count", async ({ page }) => {
  const backend = new MockBackend({
    instances: [makeInstance("index_tts2"), makeInstance("miotts")]
  });
  await openApp(page, backend, { modelId: selectedModelId, lang: "en" });
  await expect(page.locator("#instance-context-hint")).toContainText(
    "2 other instances are ready"
  );
});

test("matching ready instance: hint disappears and submission enables", async ({ page }) => {
  const backend = new MockBackend({ instances: [makeInstance("index_tts2")] });
  await openApp(page, backend, { modelId: selectedModelId, lang: "zh" });
  await expect(page.locator("#instance-context-hint")).toBeVisible();
  backend.instances.push(makeInstance(selectedModelId));
  await expect(page.locator("#instance-pill")).toHaveClass(/ok/, { timeout: 10000 });
  await expect(page.locator("#instance-context-hint")).toBeHidden();
  await expect(page.locator("#tts-submit")).toBeEnabled();
});
