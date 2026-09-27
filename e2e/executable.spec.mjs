/* #71 e2e：登记可执行文件（设置 → audio.cpp 面板 → 新增 → 列表出现） */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("登记可执行文件后出现在设置列表", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-modal")).toBeVisible();
  await page.locator('.settings-nav-item[data-section="executables"]').click();
  await expect(page.locator("#settings-pane-executables")).toBeVisible();

  await page.locator("#exec-new-btn").click();
  await page.locator("#exec-name").fill("Mock CUDA");
  await page.locator("#exec-path").fill("/opt/audiocpp/audiocpp_server");
  await page.locator("#exec-note").fill("e2e 登记");
  await page.locator("#exec-add-btn").click();

  await expect(page.locator("#exec-list .exec-name")).toContainText("Mock CUDA");
  expect(backend.executables).toHaveLength(1);
  expect(backend.executables[0].path).toBe("/opt/audiocpp/audiocpp_server");
});
