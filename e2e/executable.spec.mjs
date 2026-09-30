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

/* 懒加载契约：设置弹窗的三个分节是懒加载 chunk（modules/settings.js），首屏只加载
   外观层 modules/settings-lazy.js。但可执行文件登记的**数据**必须留在首屏——它被
   启动弹窗的可执行文件下拉与模型卡片的「已配置」判定共用，不能等点开设置才有。 */
test("设置懒加载：首屏不取 settings.js chunk，可执行文件下拉已可用，点 ⚙ 才加载", async ({
  page
}) => {
  const backend = new MockBackend({
    executables: [
      { id: "e1", name: "Mock CUDA", path: "/opt/audiocpp/audiocpp_server", exists: true }
    ]
  });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const chunkRequests = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/modules/settings.js")) chunkRequests.push(r.url());
  });

  // 1) 首屏不请求 chunk，但首屏常驻的可执行文件登记已经落到启动弹窗的下拉里
  expect(chunkRequests.length).toBe(0);
  await expect(page.locator("#launch-exec option")).toHaveText(["Mock CUDA"]);

  // 2) 点页头 ⚙ → 动态 import 发生 + 分节与列表渲染
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-modal")).toBeVisible();
  await page.locator('.settings-nav-item[data-section="executables"]').click();
  await expect(page.locator("#settings-pane-executables")).toBeVisible();
  await expect(page.locator("#exec-list .exec-name")).toContainText("Mock CUDA");
  expect(chunkRequests.length).toBeGreaterThan(0);

  // 3) Esc 关闭（app.js 的 closeTopmostOverlay 走外观层 → 真实模块）
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings-modal")).toBeHidden();

  // 4) 再开一次：chunk 已在浏览器模块缓存里，不再产生第二次请求
  const before = chunkRequests.length;
  await page.locator("#settings-btn").click();
  await expect(page.locator("#settings-modal")).toBeVisible();
  expect(chunkRequests.length).toBe(before);
});
