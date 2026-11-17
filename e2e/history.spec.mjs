/* #71 e2e：历史加载 / 删除 / 分组（新建、删除分组）。 */
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

function historyItem(taskId, text) {
  return {
    taskId,
    time: Date.now(),
    text,
    ok: true,
    result: { durationSec: 1.2, size: 48044 },
    instanceName: "supertonic",
    groupId: null,
    voice: { kind: "default" }
  };
}

test("历史：加载列表 → 新建分组 → 删除分组 → 删除记录", async ({ page }) => {
  const backend = new MockBackend({
    instances: [
      {
        id: "i1",
        modelId: "supertonic",
        instanceName: "supertonic",
        status: "READY",
        backend: "cpu",
        device: 0,
        port: 19001,
        taskCount: 0
      }
    ],
    history: { supertonic: [historyItem("h1", "第一条"), historyItem("h2", "第二条")] },
    groups: { supertonic: [] }
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  await page.locator("#history-btn").click();
  await expect(page.locator("#history-panel")).toBeVisible();
  await expect(page.locator("#history-list .history-row")).toHaveCount(2);

  // 新建分组（window.prompt）
  page.once("dialog", (d) => d.accept("Group A"));
  await page.locator("#history-group-new").click();
  await expect(page.locator("#history-list")).toContainText("Group A");
  expect(backend.groups.supertonic).toHaveLength(1);

  // 删除分组（window.confirm）
  page.once("dialog", (d) => d.accept());
  await page.locator("#history-list .history-group-header .group-btns .stop-btn").click();
  await expect(page.locator("#history-list")).not.toContainText("Group A");
  expect(backend.groups.supertonic).toHaveLength(0);

  // 删除一条记录
  await page.locator("#history-list .history-row .history-del").first().click();
  await expect(page.locator("#history-list .history-row")).toHaveCount(1);
  expect(backend.history.supertonic).toHaveLength(1);
});

test("Kokoro history downloads phoneme groups and sample rate", async ({ page }) => {
  const item = historyItem("kokoro-take", "Hello");
  const words = [{ word: "həlˈO", start_sample: 0, end_sample: 12000, confidence: 0 }];
  item.result = { ...item.result, sampleRate: 24000, words };
  const backend = new MockBackend({ history: { kokoro_tts: [item] } });
  await openApp(page, backend, { modelId: "kokoro_tts", lang: "en" });
  await page.locator("#history-btn").click();
  const row = page.locator("#history-list .history-row");
  await row.getByRole("button", { name: "Details", exact: true }).click();
  const button = row.getByRole("button", { name: "Download phoneme timestamps" });
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(download.suggestedFilename()).toBe("kokoro-take.timestamps.json");
  expect(JSON.parse(await readFile(await download.path(), "utf8"))).toEqual({
    sample_rate: 24000,
    words
  });
  await page.locator("#history-privacy").click();
  await expect(button).toHaveCount(0);
});
