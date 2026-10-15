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
