/* #71 e2e：下载管理暂停 / 续传。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("下载管理：暂停 → 续传", async ({ page }) => {
  const backend = new MockBackend({
    downloads: [
      {
        id: "d1",
        modelId: "supertonic",
        targetDir: "supertonic",
        status: "RUNNING",
        percent: 42,
        downloadedBytes: 420,
        totalBytes: 1000,
        speedBps: 1024,
        completedFiles: 1,
        fileCount: 3
      }
    ]
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  await page.locator("#downloads-btn").click();
  await expect(page.locator("#downloads-modal")).toBeVisible();
  await expect(page.locator("#dl-list .dl-row")).toHaveCount(1);
  await expect(page.locator("#dl-list .dl-row")).toContainText("42");

  await page.locator('#dl-list .dl-act[data-act="pause"]').click();
  await expect(page.locator('#dl-list .dl-act[data-act="resume"]')).toBeVisible({ timeout: 10000 });
  expect(backend.downloads[0].status).toBe("PAUSED");

  await page.locator('#dl-list .dl-act[data-act="resume"]').click();
  await expect(page.locator('#dl-list .dl-act[data-act="pause"]')).toBeVisible({ timeout: 10000 });
  expect(backend.downloads[0].status).toBe("RUNNING");
});

/* 懒加载契约（与 stats.spec / file-browser.spec 同一类）：弹窗的渲染代码是懒加载
   chunk（modules/downloads.js），首屏只加载外观层 modules/downloads-lazy.js；
   但页头角标与它的 2s 轮询留在首屏，因此「没打开过面板也能看到进行中的下载数」。 */
test("下载面板懒加载：首屏不取 downloads.js chunk，角标先动，点开才加载", async ({ page }) => {
  const backend = new MockBackend({
    downloads: [
      {
        id: "d1",
        modelId: "supertonic",
        targetDir: "supertonic",
        status: "RUNNING",
        percent: 42,
        downloadedBytes: 420,
        totalBytes: 1000,
        speedBps: 1024,
        completedFiles: 1,
        fileCount: 3
      }
    ]
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const chunkRequests = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/modules/downloads.js")) chunkRequests.push(r.url());
  });

  // 1) 首屏不请求 chunk，但角标（首屏常驻）已经在数进行中的任务
  expect(chunkRequests.length).toBe(0);
  await expect(page.locator("#dl-badge")).toHaveText("1");
  await expect(page.locator("#downloads-modal")).toBeHidden();

  // 2) 点开 → 动态 import 发生 + 列表渲染
  await page.locator("#downloads-btn").click();
  await expect(page.locator("#downloads-modal")).toBeVisible();
  await expect(page.locator("#dl-list .dl-row")).toHaveCount(1);
  expect(chunkRequests.length).toBeGreaterThan(0);

  // 3) Esc 关闭（此时 chunk 已加载，closeTopmostOverlay 走真实模块的 close）
  await page.keyboard.press("Escape");
  await expect(page.locator("#downloads-modal")).toBeHidden();

  // 4) 再开一次：chunk 已在浏览器模块缓存里，不再产生第二次请求
  const before = chunkRequests.length;
  await page.locator("#downloads-btn").click();
  await expect(page.locator("#downloads-modal")).toBeVisible();
  expect(chunkRequests.length).toBe(before);
});
