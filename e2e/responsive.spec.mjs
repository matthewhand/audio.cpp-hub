/* 响应式修复（Phase R1）e2e：mobile 360x800 / 390x844 与 tablet 768x1024。
 *
 * 钉住三件事：
 *   1) 没有横向溢出（documentElement.scrollWidth <= clientWidth）；
 *   2) 页头 7 个操作按钮全部可见且触摸目标 >= 40x40（这些按钮是并排可见的
 *      小图标行，不是溢出菜单，所以直接量它们自己）；
 *   3) 模型 / 实例 / 最近活动在汉堡抽屉里（#menu-toggle 打开），抽屉自身可滚、
 *      打开它不会把页面撑出横向滚动；
 *   4) 360x800 首屏就能看见合成按钮（sticky 底部操作条）。
 * Phase R2 追加两档：1280x720 矮笔记本（合成按钮吸底 + 左栏压缩）与
 * 1920x1080 宽屏内容限幅（1680px 居中）。
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
    const backend = new MockBackend({
      instances: [READY, Object.assign({}, READY, { id: "i2", instanceName: "siren", port: 19002 })]
    });
    await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

    const metrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(
      metrics.scrollWidth,
      `scrollWidth ${metrics.scrollWidth} 超出 clientWidth ${metrics.clientWidth}`
    ).toBeLessThanOrEqual(metrics.clientWidth);

    for (const selector of HEADER_BUTTONS) {
      const btn = page.locator(selector);
      await expect(btn, selector).toBeVisible();
      const box = await btn.boundingBox();
      expect(box, selector).not.toBeNull();
      expect(box.width, `${selector} 宽度 ${box.width}`).toBeGreaterThanOrEqual(40);
      expect(box.height, `${selector} 高度 ${box.height}`).toBeGreaterThanOrEqual(40);
      expect(box.x, `${selector} 左边缘 ${box.x}`).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, `${selector} 右边缘 ${box.x + box.width}`).toBeLessThanOrEqual(
        vp.width + 0.5
      );
    }
  });
}

test("抽屉：#menu-toggle 打开后实例 / 最近活动 / 模型三个面板都在，且可滚动、不撑宽页面", async ({
  page
}) => {
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
  const textHeight = await page.evaluate(
    () => document.querySelector("#tts-text").getBoundingClientRect().height
  );
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

/* ---------- Phase R2：1280x720 矮笔记本 + 1920x1080 宽屏限幅 ----------
   钉住四件事：合成按钮与合成文本框在首屏内且面板没有被动过（scrollTop 仍是 0）；
   最近活动标题与模型摘要行在视口内、也没被左栏滚动容器裁掉；1920x1080 下内容
   限幅 ≤1700px 且左右边距对称；两档都不横向溢出。 */
test("1280x720：合成按钮 / 文本框首屏可见无需滚动，最近活动标题与模型摘要可见", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const backend = new MockBackend({
    instances: [READY, Object.assign({}, READY, { id: "i2", instanceName: "siren", port: 19002 })]
  });
  await openApp(page, backend, { modelId: "breeze-tts", lang: "zh" });

  const m = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    rightScrollTop: document.querySelector("#right").scrollTop,
    submit: document.querySelector("#tts-submit").getBoundingClientRect().toJSON(),
    text: document.querySelector("#tts-text").getBoundingClientRect().toJSON(),
    vh: document.documentElement.clientHeight
  }));
  expect(
    m.scrollWidth,
    `scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth}`
  ).toBeLessThanOrEqual(m.clientWidth);
  // 面板没有被滚动过：首屏就够（sticky 吸底，滚动才看得到是另一回事）
  expect(m.rightScrollTop, "右栏面板应停在顶部，说明首屏放得下").toBe(0);
  expect(m.submit.y).toBeGreaterThan(0);
  expect(m.submit.bottom, `合成按钮底边 ${m.submit.bottom} 超出视口高 ${m.vh}`).toBeLessThanOrEqual(
    m.vh
  );
  expect(m.text.y, "合成文本框应在视口内").toBeGreaterThan(0);
  expect(m.text.bottom).toBeLessThanOrEqual(m.vh);

  // 底部操作条 sticky 吸在面板滚动区底部，实底 + 细顶线（不透背景，内容不从底下透上来）
  const bar = page.locator("#panel-tts .tts-action-bar");
  await expect(bar).toHaveCSS("position", "sticky");
  const bg = await bar.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg, `操作条背景 ${bg} 应是不透的实底`).toMatch(/^rgb\(\d+, \d+, \d+\)$/);

  // 最近活动默认收起（标题 + 计数还在），模型行以收起态紧随其后
  await expect(page.locator("#activity-panel")).toHaveJSProperty("open", false);
  await expect(page.locator("#model-panel")).toHaveJSProperty("open", false);

  // 两者的标题都在视口内，且没有被左栏滚动容器裁掉（左栏自己滚但不滚动时就在首屏）
  for (const sel of ["#activity-panel summary", "#model-panel summary", "#model-panel"]) {
    const box = await page.locator(sel).boundingBox();
    expect(box, sel).not.toBeNull();
    expect(box.y, `${sel} 顶边 ${box.y}`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${sel} 底边 ${box.y + box.height}`).toBeLessThanOrEqual(720);
  }
  await expect(page.locator("#activity-panel summary")).toBeVisible();
  await expect(page.locator("#model-panel .model-panel-title")).toBeVisible();
  await expect(page.locator("#model-panel .sec-count")).toBeVisible();

  // 左栏在矮视口下自己滚：overflow-y 可用 + 高度顶住视口（不是页面整体滚）
  const left = await page.evaluate(() => {
    const el = document.querySelector("#left");
    const s = getComputedStyle(el);
    return { overflowY: s.overflowY, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
  expect(["auto", "scroll", "overlay"]).toContain(left.overflowY);
  expect(left.clientHeight, "左栏高度应小于整页高（由 header / footer 挤出来）").toBeLessThan(720);
});

test("1920x1080：内容限幅 ≤1700px 且水平居中，左右边距对称，不横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const backend = new MockBackend({ instances: [READY] });
  await openApp(page, backend, { modelId: "supertonic", lang: "zh" });

  const m = await page.evaluate(() => {
    const main = document.querySelector("main");
    const header = document.querySelector("header");
    const footer = document.querySelector("footer");
    const r = (el) => el.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      main: r(main).toJSON(),
      header: r(header).toJSON(),
      footer: r(footer).toJSON(),
      sidebar: r(document.querySelector("#left")).toJSON(),
      vw: window.innerWidth,
      // 矮视口限幅不生效：底部操作条保持普通流内布局
      barPosition: getComputedStyle(document.querySelector("#panel-tts .tts-action-bar")).position,
      activityOpen: document.querySelector("#activity-panel").open
    };
  });
  expect(m.scrollWidth).toBeLessThanOrEqual(m.clientWidth);
  for (const [name, box] of [
    ["main", m.main],
    ["header", m.header],
    ["footer", m.footer]
  ]) {
    expect(box.width, `${name} 宽度 ${box.width} 超过 1700px 上限`).toBeLessThanOrEqual(1700);
    const left = box.x;
    const right = m.vw - box.x - box.width;
    expect(
      Math.abs(left - right),
      `${name} 左右边距 ${left} / ${right} 不对称`
    ).toBeLessThanOrEqual(2);
  }
  // 限幅不改变左栏宽度，两栏仍然贴着内容走
  expect(m.sidebar.width).toBe(360);
  expect(m.barPosition, "1080px 高的视口不吸底").toBe("static");
  expect(m.activityOpen, "高视口下最近活动默认展开").toBe(true);
});
