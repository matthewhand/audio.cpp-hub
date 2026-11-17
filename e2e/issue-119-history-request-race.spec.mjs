import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

function record(id, text) {
  return {
    taskId: id,
    text,
    time: Date.now(),
    ok: true,
    voice: { kind: "default" },
    result: { durationSec: 1, size: 100 }
  };
}

test("history refresh never replaces newer rows with a delayed older response", async ({
  page
}) => {
  const backend = new MockBackend({ history: { sanotts: [record("old-take", "OLDER_RESULT")] } });
  await openApp(page, backend, { modelId: "sanotts", lang: "en" });
  let releaseOld;
  let firstSeen;
  const oldBlocked = new Promise((resolve) => {
    releaseOld = resolve;
  });
  const firstRequest = new Promise((resolve) => {
    firstSeen = resolve;
  });
  let requests = 0;
  await page.route("**/api/history/sanotts", async (route) => {
    requests += 1;
    if (requests === 1) {
      firstSeen();
      await oldBlocked;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([record("old-take", "OLDER_RESULT")])
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([record("new-take", "NEWER_RESULT")])
    });
  });
  try {
    await page.locator("#history-btn").click();
    await firstRequest;
    await page.locator("#history-refresh").click();
    await expect(page.locator("#history-list")).toContainText("NEWER_RESULT");
    releaseOld();
    await expect(page.locator("#history-list")).not.toContainText("OLDER_RESULT");
    await expect(page.locator("#history-list .history-row")).toHaveCount(1);
    await expect(page.locator("#history-list")).toContainText("NEWER_RESULT");
  } finally {
    releaseOld();
  }
});

async function holdRestore(page, modelId, item) {
  let release;
  let markRequested;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const requested = new Promise((resolve) => {
    markRequested = resolve;
  });
  await page.route(`**/api/history/${modelId}/${item.taskId}`, async (route) => {
    markRequested();
    await blocked;
    await route.fulfill({ status: 200, json: item });
  });
  return { requested, release };
}

function startSlowLoad(page, text) {
  // Await the actual row handler after releasing its request, including form updates.
  return page
    .locator(".history-row", { hasText: text })
    .getByRole("button", { name: "Load", exact: true })
    .evaluate((button) => button.onclick());
}

test("a delayed Load cannot overwrite a newer history Load", async ({ page }) => {
  const modelId = "kokoro_tts";
  const older = record("old-load", "OLD_TAKE");
  const newer = record("new-load", "NEW_TAKE");
  const backend = new MockBackend({ history: { [modelId]: [older, newer] } });
  await openApp(page, backend, { modelId, lang: "en" });
  const slow = await holdRestore(page, modelId, older);
  await page.locator("#history-btn").click();
  const pending = startSlowLoad(page, older.text);
  try {
    await slow.requested;
    await page
      .locator(".history-row", { hasText: newer.text })
      .getByRole("button", { name: "Load", exact: true })
      .click();
    await expect(page.locator("#tts-text")).toHaveValue(newer.text);
  } finally {
    slow.release();
    await pending;
  }
  await expect(page.locator("#tts-text")).toHaveValue(newer.text, { timeout: 1000 });
});

test("a history Load started before a round-trip model switch cannot overwrite the draft", async ({
  page
}) => {
  const modelId = "kokoro_tts";
  const older = record("old-load", "OLD_TAKE");
  const backend = new MockBackend({ history: { [modelId]: [older] } });
  await openApp(page, backend, { modelId, lang: "en" });
  const slow = await holdRestore(page, modelId, older);
  await page.locator("#history-btn").click();
  const pending = startSlowLoad(page, older.text);
  try {
    await slow.requested;
    await page.locator("#history-close").click();
    await page.locator('[data-model-id="supertonic"].model-select-target').click();
    await expect(page).toHaveURL(/#\/model\/supertonic$/);
    await page.locator('[data-model-id="kokoro_tts"].model-select-target').click();
    await expect(page).toHaveURL(/#\/model\/kokoro_tts$/);
    await page.locator("#tts-text").fill("NEW_DRAFT");
  } finally {
    slow.release();
    await pending;
  }
  await expect(page.locator("#tts-text")).toHaveValue("NEW_DRAFT", { timeout: 1000 });
});

test("a newer Breeze Remix wins over a slow Load and keeps its recipe", async ({ page }) => {
  const modelId = "breeze-tts";
  const older = record("old-load", "OLD_TAKE");
  const newer = {
    ...record("remix", "REMIX_TAKE"),
    options: { seed: 12, instruction: "Read softly." }
  };
  const backend = new MockBackend({ history: { [modelId]: [older, newer] } });
  await openApp(page, backend, { modelId, lang: "en" });
  const slow = await holdRestore(page, modelId, older);
  await page.locator("#history-btn").click();
  const pending = startSlowLoad(page, older.text);
  try {
    await slow.requested;
    await page
      .locator(".history-row", { hasText: newer.text })
      .getByRole("button", { name: "Remix", exact: true })
      .click();
    await expect(page.locator("#adv-seed")).toHaveValue("13");
  } finally {
    slow.release();
    await pending;
  }
  await expect(page.locator("#tts-text")).toHaveValue("", { timeout: 1000 });
  await expect(page.locator("#tts-instruction")).toHaveValue("Read softly.");
  await expect(page.locator("#adv-seed")).toHaveValue("13");
});
