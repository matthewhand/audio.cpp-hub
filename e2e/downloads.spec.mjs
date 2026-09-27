/* #71 e2e：下载管理暂停 / 续传。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("下载管理：暂停 → 续传", async ({ page }) => {
  const backend = new MockBackend({
    downloads: [{
      id: "d1", modelId: "supertonic", targetDir: "supertonic", status: "RUNNING",
      percent: 42, downloadedBytes: 420, totalBytes: 1000, speedBps: 1024,
      completedFiles: 1, fileCount: 3
    }]
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
