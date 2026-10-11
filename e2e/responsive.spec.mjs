/* 响应式修复（Phase R1）e2e：mobile 360x800 / 390x844 与 tablet 768x1024。
 *
 * 钉住三件事：
 *   1) 没有横向溢出（documentElement.scrollWidth <= clientWidth）；
 *   2) 页头 7 个操作按钮全部可见且触摸目标 >= 40x40（这些按钮是并排可见的
 *      小图标行，不是溢出菜单，所以直接量它们自己）；
 *   3) 模型 / 实例 / 最近活动在汉堡抽屉里（#menu-toggle 打开），抽屉自身可滚、
 *      打开它不会把页面撑出横向滚动；
 *   4) 360x800 首屏就能看见合成按钮（sticky 底部操作条）。
 * 无 Go / 无 GPU / 无模型：后端走 MockBackend。 */
import { test, expect } from "@playwright/test";
import { MockBackend } from "./mock-backend.mjs";
import { openApp } from "./helpers.mjs";

const READY = {
  id: "i1",
  modelId: "supertonic",
  instanceName: "breeze",
  status: "READY",
  backend: "cpu",
  device: 0,
  port: 19001,
  taskCount: 0
};

/** 页头一排操作按钮（菜单键 #menu-toggle 单独处理）。 */
const HEADER_BUTTONS = [
  "#voices-btn",
  "#history-btn",
  "#downloads-btn",
  "#stats-btn",
  "#lang-toggle",
  "#settings-btn",
  "#theme-toggle"
];

const MOBILE = [
  { name: "mobile-360x800", width: 360, height: 800 },
  { name: "mobile-390x844", width: 390, height: 844 },
  { name: "tablet-768x1024", width: 768, height: 1024 }
];

for (const vp of MOBILE) {
  test(`${vp.name}：无横向溢出，页头按钮全部可见且触摸目标 ≥40px`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const backend = new MockBackend({ instances: [READY, Object.assign({}, READY, { id: "i2", instanceName: "siren", port: 19002 })] });
    await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(metrics.scrollWidth, `scrollWidth ${metrics.scrollWidth} 超出 clientWidth ${metrics.clientWidth}`).toBeLessThanOrEqual(metrics.clientWidth);

    for (const selector of HEADER_BUTTONS) {
      const btn = page.locator(selector);
      await expect(btn, selector).toBeVisible();
      const box = await btn.boundingBox();
      expect(box, selector).not.toBeNull();
      expect(box.width, `${selector} 宽度 ${box.width}`).toBeGreaterThanOrEqual(40);
      expect(box.height, `${selector} 高度 ${box.height}`).toBeGreaterThanOrEqual(40);
      expect(box.x, `${selector} 左边缘 ${box.x}`).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, `${selector} 右边缘 ${box.x + box.width}`).toBeLessThanOrEqual(vp.width + 0.5);
    }
  });
}

test("抽屉：#menu-toggle 打开后实例 / 最近活动 / 模型三个面板都在，且可滚动、不撑宽页面", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const drawer = page.locator("#left");
  await expect(drawer).not.toHaveClass(/open/);

  await page.locator("#menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "true");

  // 左栏三块都在抽屉里渲染出来
  await expect(page.locator("#instance-list .card").first()).toBeVisible();
  await expect(page.locator("#activity-panel")).toBeVisible();
  await expect(page.locator("#model-panel")).toBeVisible();

  // 抽屉自己滚：overflow-y 可用 + 高度顶住动态视口；把窗口压矮后内容确实在抽屉内滚动
  const scroll = await page.evaluate(() => {
    const el = document.querySelector("#left");
    const style = getComputedStyle(el);
    return { overflowY: style.overflowY, maxHeight: style.maxHeight };
  });
  expect(["auto", "scroll", "overlay"]).toContain(scroll.overflowY);
  expect(scroll.maxHeight).not.toBe("none");

  await page.setViewportSize({ width: 360, height: 420 });
  const scrollable = await page.evaluate(() => {
    const el = document.querySelector("#left");
    return el.scrollHeight > el.clientHeight;
  });
  expect(scrollable, "矮视口下抽屉内容应比抽屉高（靠 overflow-y 自己滚）").toBe(true);

  // 关闭键真实存在且可点：点它抽屉收起
  const close = page.locator("#drawer-close");
  await expect(close).toBeVisible();
  await close.click();
  await expect(drawer).not.toHaveClass(/open/);
  await expect(page.locator("#menu-toggle")).toHaveAttribute("aria-expanded", "false");

  // 打开抽屉不会让页面横向溢出
  await page.locator("#menu-toggle").click();
  await expect(drawer).toHaveClass(/open/);
  const open = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(open.scrollWidth).toBeLessThanOrEqual(open.clientWidth);

  // Esc 也能收起（web/app.js 的全局按键 → closeDrawer）
  await page.keyboard.press("Escape");
  await expect(drawer).not.toHaveClass(/open/);
});

test("360x800：合成按钮 sticky 在视口内，无需滚动即可点到", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const bar = page.locator("#panel-tts .tts-action-bar");
  await expect(bar).toHaveCSS("position", "sticky");
  const submit = page.locator("#tts-submit");
  await expect(submit).toBeVisible();
  const box = await submit.boundingBox();
  expect(box).not.toBeNull();
  // 未滚动就在视口里（首屏可见），且是 sticky 底栏的一部分
  expect(box.y + box.height).toBeLessThanOrEqual(800);
  expect(box.y).toBeGreaterThan(0);
  // 触控目标 ≥44px（≤720px 一档）
  expect(box.height).toBeGreaterThanOrEqual(44);

  // 文本框从 4 行压到 3 行左右（不把首屏挤没）
  const textHeight = await page.evaluate(() => document.querySelector("#tts-text").getBoundingClientRect().height);
  expect(textHeight).toBeLessThan(90);
  expect(textHeight).toBeGreaterThan(40);
});

test("1280x720（laptop）与 1920x1080（desktop）布局不因本次改动回归", async ({ page }) => {
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: width === 1280 ? 720 : 1080 });
    const backend = new MockBackend({ instances: [READY] });
    await openApp(page, backend, { modelId: "supertonic", lang: "zh" });
    const m = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
    // 宽屏没有抽屉：汉堡键不渲染，左栏是常驻列
    await expect(page.locator("#menu-toggle")).toBeHidden();
    await expect(page.locator("#drawer-close")).toBeHidden();
    await expect(page.locator("#left")).toBeVisible();
    await expect(page.locator("#instance-list .card").first()).toBeVisible();
    // 页头不换行（单行布局保持原样）
    await expect(page.locator("header")).toHaveCSS("flex-wrap", "nowrap");
  }
});
