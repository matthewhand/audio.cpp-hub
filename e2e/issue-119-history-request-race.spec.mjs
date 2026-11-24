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

async function holdRestore(page, modelId, item, status = 200) {
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
    await route.fulfill({ status, json: item });
  });
  return { requested, release };
}

function startSlowLoad(page, text, action = "Load") {
  // Await the actual row handler after releasing its request, including form updates.
  return page
    .locator(".history-row", { hasText: text })
    .getByRole("button", { name: action, exact: true })
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

async function formValues(page) {
  return page
    .locator("#panel-tts")
    .evaluate((root) =>
      [...root.querySelectorAll("input, textarea, select")].map((input) => [
        input.id || input.className,
        input.value,
        input.checked
      ])
    );
}

for (const action of ["Load", "Remix"]) {
  for (const [selector, value] of [
    ["#tts-text", "DRAFT"],
    ["#tts-instruction", "Manual instruction"],
    ["#tts-reference-text", "Manual reference"],
    ["#adv-seed", "42"],
    ["#tts-enum-history_choice", "manual"],
    ["#adv-history_flag", true],
    ["#tts-breeze-mode", "voice_clone"],
    ["#voice-picker .vs-select", "manual-voice"]
  ]) {
    test(`${action} preserves same-model edits to ${selector}`, async ({ page }) => {
      const modelId = "breeze-tts";
      const item = {
        ...record("held", "SAVED_TAKE"),
        options: {
          seed: 9,
          instruction: "Saved instruction",
          history_choice: "saved",
          history_flag: false
        }
      };
      const backend = new MockBackend({
        history: { [modelId]: [item] },
        voices: [
          {
            vid: "manual-voice",
            name: "Manual voice",
            path: "/mock/manual.wav",
            text: "Manual transcript"
          }
        ]
      });
      const model = backend.model(modelId);
      model.paramSchema = {
        ...model.paramSchema,
        history_choice: { type: "enum", values: ["saved", "manual"], default: "saved" },
        history_flag: { type: "boolean", default: false }
      };
      await openApp(page, backend, { modelId, lang: "en" });
      await page.locator("#tts-text").fill("DRAFT");
      if (selector === "#tts-reference-text" || selector === "#voice-picker .vs-select") {
        await page.locator("#tts-breeze-mode").selectOption("voice_clone");
      }
      if (selector === "#adv-seed" || selector === "#adv-history_flag") {
        await page.locator("#tts-advanced > summary").click();
      }
      if (selector === "#voice-picker .vs-select") {
        await expect(page.locator('#voice-picker option[value="manual-voice"]')).toBeAttached();
      }
      const slow = await holdRestore(page, modelId, item);
      await page.locator("#history-btn").click();
      const pending = startSlowLoad(page, item.text, action);
      try {
        await slow.requested;
        await page.locator("#history-close").click();
        if (selector === "#voice-picker .vs-select") {
          // Match the non-bubbling change contract used by "Use for TTS".
          await page.locator(selector).evaluate((select) => {
            select.value = "manual-voice";
            select.dispatchEvent(new Event("change"));
          });
        } else if (typeof value === "boolean") await page.locator(selector).setChecked(value);
        else if (selector === "#tts-enum-history_choice" || selector === "#tts-breeze-mode") {
          await page.locator(selector).selectOption(value);
        } else await page.locator(selector).fill(value);
        if (selector === "#tts-text") {
          await page.locator(selector).fill("AWAY");
          await page.locator(selector).fill("DRAFT");
        }
        await page.locator("#tts-instruction").focus();
        const before = await formValues(page);
        slow.release();
        await pending;
        expect(await formValues(page)).toEqual(before);
        await expect(page.locator("#tts-instruction")).toBeFocused();
        await expect(page.locator("#toast-root")).toHaveText("");
      } finally {
        slow.release();
        await pending;
      }
      await page.locator("#history-btn").click();
      await startSlowLoad(page, item.text);
      await expect(page.locator("#tts-text")).toHaveValue(item.text);
      await expect(page.locator("#adv-seed")).toHaveValue("9");
      await expect(page.locator("#tts-instruction")).toHaveValue("Saved instruction");
    });
  }
}

for (const edit of ["text", "add", "remove"]) {
  test(`a pending Load preserves speaker ${edit} edits`, async ({ page }) => {
    const modelId = "breeze-tts";
    const item = record("held", "Speaker 1: SAVED_LINE");
    const backend = new MockBackend({ history: { [modelId]: [item] } });
    backend.model(modelId).family = "vibevoice";
    await openApp(page, backend, { modelId, lang: "en" });
    await page.locator("#tts-speaker-add").click();
    await expect(page.locator(".speaker-row")).toHaveCount(2);
    await page.locator(".speaker-lines").first().fill("DRAFT");
    const slow = await holdRestore(page, modelId, item);
    await page.locator("#history-btn").click();
    const pending = startSlowLoad(page, item.text);
    try {
      await slow.requested;
      await page.locator("#history-close").click();
      if (edit === "text") await page.locator(".speaker-lines").first().fill("EDITED");
      else if (edit === "add") await page.locator("#tts-speaker-add").click();
      else await page.locator(".speaker-remove").last().click();
      const before = await formValues(page);
      slow.release();
      await pending;
      expect(await formValues(page)).toEqual(before);
      await expect(page.locator(".speaker-row")).toHaveCount(
        edit === "add" ? 3 : edit === "remove" ? 1 : 2
      );
      await expect(page.locator("#toast-root")).toHaveText("");
    } finally {
      slow.release();
      await pending;
    }
  });
}

test("an edited draft suppresses a stale error and accepts a fresh Load", async ({ page }) => {
  const modelId = "kokoro_tts";
  const older = record("failed-load", "FAILED_TAKE");
  const newer = record("fresh-load", "FRESH_TAKE");
  const backend = new MockBackend({ history: { [modelId]: [older, newer] } });
  await openApp(page, backend, { modelId, lang: "en" });
  const slow = await holdRestore(page, modelId, older, 500);
  await page.locator("#history-btn").click();
  const pending = startSlowLoad(page, older.text);
  try {
    await slow.requested;
    await page.locator("#history-close").click();
    await page.locator("#tts-text").fill("DRAFT");
    await page.locator("#tts-text").focus();
  } finally {
    slow.release();
    await pending;
  }
  await expect(page.locator("#tts-text")).toHaveValue("DRAFT");
  await expect(page.locator("#tts-text")).toBeFocused();
  await expect(page.locator("#toast-root")).toHaveText("");
  await page.locator("#history-btn").click();
  await startSlowLoad(page, newer.text);
  await expect(page.locator("#tts-text")).toHaveValue(newer.text);
});
