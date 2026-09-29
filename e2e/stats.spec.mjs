/* #74 e2e：用量与性能看板走懒加载路径。
 *
 * 这条用例钉住「首屏不加载 stats.js、点击后才动态 import」这个契约：
 *  1. 首屏在 #stats-lazy.js 加载后，stats.js 尚未被请求（真正的懒加载）；
 *  2. 点击页头 📊 后动态 import 发生、面板打开、渲染出模型卡片；
 *  3. Esc 关闭面板（closeStatsPanel 在已加载后走真实模块）；
 *  4. samplesForPerf = 0 的模型不展示性能行。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("看板懒加载：首屏不取 stats.js，点击 📊 后才加载并渲染", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend);

  // 记录首屏之后才发生的模块请求
  const lazyRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("/modules/stats.js")) lazyRequests.push(r.url());
  });

  // 1) 首屏不应已经请求 stats.js（它只被 stats-lazy.js 动态 import）
  await expect(page.locator("#stats-panel")).toHaveClass(/hidden/);
  expect(lazyRequests.length).toBe(0);

  // 2) 点击页头 📊 → 动态 import 发生 + 面板打开 + 渲染
  await page.locator("#stats-btn").click();
  await expect(page.locator("#stats-panel")).toBeVisible();
  await expect(page.locator("#stats-body .stats-models .stats-model")).toHaveCount(2);
  // 懒加载请求确实发生过
  expect(lazyRequests.length).toBeGreaterThan(0);
  // 总量卡片出现（任务总数 / 成功率等）
  await expect(page.locator("#stats-body .stats-total").first()).toBeVisible();

  // 3) 面板标题本地化（默认语言是 en）
  await expect(page.locator("#stats-panel-title")).toHaveText("Usage & performance");

  // 4) samplesForPerf > 0 的模型展示 RTF 性能行；= 0 的不展示
  //    （用单元格数量而非中文标签断言，避免与默认语言耦合）
  const breezeCard = page.locator(".stats-model", { hasText: "breeze2tts" });
  const indexCard = page.locator(".stats-model", { hasText: "index2" });
  // 有样本：5 行用量 + 4 行性能 = 9；无样本：只有 5 行用量
  await expect(breezeCard.locator(".stats-cell")).toHaveCount(9);
  await expect(indexCard.locator(".stats-cell")).toHaveCount(5);
  await expect(indexCard.locator(".stats-note")).toHaveCount(0);

  // 5) Esc 关闭（走真实 closeStatsPanel + 焦点还原）
  await page.keyboard.press("Escape");
  await expect(page.locator("#stats-panel")).toHaveClass(/hidden/);
});
