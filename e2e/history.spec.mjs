/* #71 e2e：历史加载 / 删除 / 分组（新建、删除分组）。 */
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
    voice: { kind: "default" },
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
        taskCount: 0,
      },
    ],
    history: { supertonic: [historyItem("h1", "第一条"), historyItem("h2", "第二条")] },
    groups: { supertonic: [] },
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
