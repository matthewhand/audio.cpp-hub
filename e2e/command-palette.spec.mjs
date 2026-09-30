/* e2e：命令面板（Ctrl/Cmd-K）的懒加载契约。
 *
 * 命令面板没有任何入口按钮——唯一入口是全局和弦，因此懒加载它的风险比带按钮的面板高一档：
 * 快捷键必须在 chunk 到位前就有效，否则首按必然失灵。真模块
 * modules/command-palette.js 由外观层 modules/command-palette-lazy.js 在首次按键时
 * import()，首屏只加载外观层。
 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const CHUNK = "/modules/command-palette.js";

test("命令面板懒加载：首屏不取 chunk，Ctrl-K 首按即开，再按即关", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const chunkRequests = [];
  page.on("request", (r) => {
    if (r.url().endsWith(CHUNK)) chunkRequests.push(r.url());
  });

  // 1) 首屏不请求 chunk，面板也不可见
  expect(chunkRequests.length).toBe(0);
  await expect(page.locator("#command-palette")).toBeHidden();

  // 2) 首次 Ctrl-K：动态 import 发生 + 面板真的打开（快捷键归外观层，首按不能失灵）
  await page.keyboard.press("Control+k");
  await expect(page.locator("#command-palette")).toBeVisible();
  expect(chunkRequests.length).toBeGreaterThan(0);
  await expect(page.locator("#command-palette-list .cp-item").first()).toBeVisible();

  // 3) 焦点落在搜索框上，键盘全程可用（#88 的焦点回归契约）
  await expect(page.locator("#command-palette-input")).toBeFocused();

  // 4) 再按一次 Ctrl-K 应关闭。这条同时钉住「和弦只有一个监听器」：外观层与 chunk 各注册
  //    一份的话，这一次按键会被处理两遍（打开又立刻关掉），第 2 步的面板就会一闪而过。
  await page.keyboard.press("Control+k");
  await expect(page.locator("#command-palette")).toBeHidden();

  // 5) 再开一次：chunk 已在浏览器模块缓存里，不再产生第二次请求
  const before = chunkRequests.length;
  await page.keyboard.press("Control+k");
  await expect(page.locator("#command-palette")).toBeVisible();
  expect(chunkRequests.length).toBe(before);
});

test("命令面板：Esc 关闭（app.js 的 Esc 走外观层 → 真实模块）", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  await page.keyboard.press("Control+k");
  await expect(page.locator("#command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#command-palette")).toBeHidden();
});
