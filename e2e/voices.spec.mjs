/* #71 e2e：音色库添加音色（名称 + 本地路径音频）。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp, pickAudioByPath } from "./helpers.mjs";

test("音色库：添加音色后列表出现", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  await page.locator("#voices-btn").click();
  await expect(page.locator("#voices-panel")).toBeVisible();
  await expect(page.locator("#voices-list")).toContainText("暂无音色");

  await page.locator("#voice-add-name").fill("Alice");
  await page.locator("#voice-add-text").fill("这是参考文本");
  await pickAudioByPath(page, "#voice-add-picker", "/audio/alice.wav");
  await page.locator("#voice-add-btn").click();

  await expect(page.locator("#voices-list .voice-row .voice-name")).toHaveText("Alice");
  expect(backend.voices).toHaveLength(1);
  expect(backend.voices[0]).toMatchObject({ name: "Alice", text: "这是参考文本" });
});

/* 懒加载契约：音色库面板曾是以 <script src> 加载的经典脚本（首屏就下载 9.2 KiB），
   现在是懒加载 chunk（modules/voices-panel.js），首屏只加载外观层
   modules/voices-panel-lazy.js。页头 🎙 与 #/voices 路由在 chunk 到位前就能用，
   而经典脚本 voice-select.js 依赖的 window.openVoicesPanel 仍挂在外观层上。 */
test("音色库懒加载：首屏不取 voices-panel.js chunk，点 🎙 才加载并可用 Esc 关闭", async ({
  page
}) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const chunkRequests = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/modules/voices-panel.js")) chunkRequests.push(r.url());
  });

  // 1) 首屏不请求 chunk（也不该再有经典脚本 /voices-panel.js 的请求）
  expect(chunkRequests.length).toBe(0);
  await expect(page.locator("#voices-panel")).toBeHidden();

  // 2) 点页头 🎙 → 动态 import 发生 + 列表渲染
  await page.locator("#voices-btn").click();
  await expect(page.locator("#voices-panel")).toBeVisible();
  await expect(page.locator("#voices-list")).toContainText("暂无音色");
  expect(chunkRequests.length).toBeGreaterThan(0);

  // 3) Esc 关闭（app.js 的 closeTopmostOverlay 走外观层 → 真实模块）
  await page.keyboard.press("Escape");
  await expect(page.locator("#voices-panel")).toBeHidden();

  // 4) 再开一次：chunk 已在浏览器模块缓存里，不再产生第二次请求
  const before = chunkRequests.length;
  await page.locator("#voices-btn").click();
  await expect(page.locator("#voices-panel")).toBeVisible();
  expect(chunkRequests.length).toBe(before);
});

/* 深链接冷启动也要能打开懒加载面板：#/voices 由 app.js 末尾的 applyRoute() 经
   外观层触发——旧实现靠经典脚本末尾补跑一次 hubApplyRoute()，现在外观层是模块图
   的一部分，求值期就在 applyRoute() 之前就绪。 */
test("音色库深链接：#/voices 冷启动后经懒加载外观打开面板", async ({ page }) => {
  const backend = new MockBackend();
  await openApp(page, backend, { modelId: "supertonic", lang: "zh", hash: "#/voices" });
  await expect(page.locator("#voices-panel")).toBeVisible();
  await expect(page.locator("#voices-list")).toContainText("暂无音色");
});
