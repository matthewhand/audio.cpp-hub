/* e2e：服务器端文件选择器走懒加载路径。
 *
 * 这条用例钉住与 stats.spec.mjs 同一类契约：
 *  1. 首屏不请求 /modules/file-browser.js（它只被 file-browser-lazy.js 动态 import）；
 *  2. 点「浏览…」后才发生该请求、弹窗打开、标题本地化；
 *  3. Esc 关闭（此时 chunk 已加载，closeTopmostOverlay 走真实模块的 cancel）。
 *
 * 它同时是 lazy 文件浏览器唯一的功能回归网：overlay 是在首次 open() 时动态创建的，
 * 改成 ES 模块后 overlay 的创建、事件绑定与 q() 查询全在一个懒加载 chunk 里，
 * 单元测试覆盖不到（见 TESTING.md「不做单元测试」那一节）。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

test("文件浏览器懒加载：首屏不取 file-browser.js，点「浏览…」后才加载并打开", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  // 记录首屏之后才发生的 chunk 请求
  const lazyRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("/modules/file-browser.js")) lazyRequests.push(r.url());
  });

  // 1) 首屏不应已经请求 file-browser.js（它只被 file-browser-lazy.js 动态 import）
  expect(lazyRequests.length).toBe(0);
  await expect(page.locator("#fb-overlay")).toHaveCount(0);

  // 2) 打开启动弹窗 → 点「浏览…」→ 动态 import 发生 + 弹窗打开
  await page.locator("#launch-open-btn").click();
  await expect(page.locator("#launch-modal")).toBeVisible();
  await page.locator("#weights-browse-btn").click();
  await expect(page.locator("#fb-overlay")).toBeVisible();
  expect(lazyRequests.length).toBeGreaterThan(0);
  // 目录模式 + zh：标题取调用点传入的 launch.weightsBrowseTitle，
  // 且「选择当前目录」按钮可见（仅 dir 模式）
  await expect(page.locator("#fb-overlay .fb-title")).toHaveText("选择模型权重目录");
  await expect(page.locator("#fb-overlay .fb-pick-current")).toBeVisible();

  // 3) Esc 关闭（capture 阶段的处理器直接 cancel，绕开 app.js 的 topmost 分派）
  await page.keyboard.press("Escape");
  await expect(page.locator("#fb-overlay")).toBeHidden();

  // 4) 再开一次：chunk 已在浏览器模块缓存里，不再产生第二次请求
  const before = lazyRequests.length;
  await page.locator("#weights-browse-btn").click();
  await expect(page.locator("#fb-overlay")).toBeVisible();
  expect(lazyRequests.length).toBe(before);
});

/* AudioPicker 是**经典脚本**，用 `import("./modules/file-browser-lazy.js")` 取同一块
   chunk（相对说明符按文档基址解析）。这条用例专门盯那条路径——它与 launch.js 的
   ES 模块调用点走的是不同的加载方式，写错基址只会在运行期 404。 */
test("AudioPicker 的本地路径页签经同一个 chunk 打开（经典脚本的动态 import）", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "citrinet_asr", lang: "zh" });
  await expect(page.locator("#panel-asr")).toBeVisible();

  const lazyRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("/modules/file-browser.js")) lazyRequests.push(r.url());
  });

  // ASR 面板的输入音频 AudioPicker → 切到「本地路径」页签 → 点「浏览…」
  const picker = page.locator("#asr-audio-picker");
  await picker.locator('.picker-tab[data-tab="path"]').click();
  await picker.locator(".path-browse").click();

  await expect(page.locator("#fb-overlay")).toBeVisible();
  expect(lazyRequests.length).toBeGreaterThan(0);
  // file 模式：不给「选择当前目录」，扩展名过滤下拉出现
  await expect(page.locator("#fb-overlay .fb-pick-current")).toBeHidden();
  await expect(page.locator("#fb-overlay .fb-ext")).toBeVisible();

  // 取消关闭（overlay 是单例，第二次 open 复用同一个 DOM）
  await page.locator("#fb-overlay .fb-cancel").click();
  await expect(page.locator("#fb-overlay")).toBeHidden();
});
