/* 回归测试：命令面板打开后焦点必须落在搜索框上（Ctrl/Cmd-K 全程键盘可用）。
 *
 * 缺陷本体：openCommandPalette 去掉 .hidden 之后立刻 focusDialog → input.focus()，
 * 但 .modal-overlay.hidden 用 visibility:hidden 保留布局盒做淡出动画（web/style.css），
 * 而 visibility 的 CSS 过渡要到第 2 个动画帧才生效——此刻对子树里的输入框 focus() 是
 * 空操作，document.activeElement 留在 <body>，↑↓ / Enter / 直接打字全都不响应，
 * 键盘用户非得用鼠标点一下搜索框才能开始用。
 *
 * 测法：把真实的 web/modules/async-ui.js 与 web/modules/command-palette.js 加载进
 * node:vm（沿用 test/unit/helpers/vm.mjs 的 loadEsModule，不改任何前端源码），配
 * test/unit/helpers/dom-stub.mjs 这个极小 DOM 桩——它的 focus() 像浏览器一样拒绝
 * visibility:hidden / inert / 不可聚焦的元素，并且同样把 visibility 过渡建模成
 * 「第 2 帧才生效」。因此 setTimeout(…, 0) 式的盲等补丁在这里骗不过去，
 * 只有真正盯着 document.activeElement 重试的修复才能通过。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule } from "./helpers/vm.mjs";

/* 按 web/index.html 的实际结构搭出命令面板 + 会被 syncInert 置 inert 的背景区域 */
function buildDom() {
  const world = createDomWorld();
  const { el } = world;
  const body = world.document.body;
  const node = (tag) => new StubElement(world, tag);

  const header = node("header");
  const opener = el('<button id="theme-toggle" class="theme-btn"></button>');
  header.appendChild(opener);
  body.appendChild(header);

  const main = el('<main id="main-content" tabindex="-1"></main>');
  body.appendChild(main);
  body.appendChild(node("footer"));

  // <div id="command-palette" class="modal-overlay hidden" role="dialog" …>
  //   <div class="command-palette-card">
  //     <span id="command-palette-title" class="hidden">…</span>
  //     <input id="command-palette-input" …>
  //     <div id="command-palette-list" class="cp-list" role="listbox">
  const paletteEl = el(
    '<div class="modal-overlay hidden" id="command-palette" role="dialog"></div>'
  );
  const card = el('<div class="command-palette-card"></div>');
  const input = el('<input id="command-palette-input" type="text"></input>');
  const list = el('<div class="cp-list" id="command-palette-list" role="listbox"></div>');
  card.appendChild(el('<span class="hidden" id="command-palette-title"></span>'));
  card.appendChild(input);
  card.appendChild(list);
  paletteEl.appendChild(card);
  body.appendChild(paletteEl);
  body.appendChild(el('<div class="drawer-overlay hidden" id="drawer-overlay"></div>'));

  return { world, opener, paletteEl, input, list };
}

/* 真实的两个模块 + 它们的外部依赖桩（models / instances / go / t / I18N …） */
function loadModules(world) {
  const base = {
    document: world.document,
    $: world.$,
    el: world.el,
    requestAnimationFrame: world.requestAnimationFrame,
    cancelAnimationFrame: world.cancelAnimationFrame,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    I18N: { pick: (o, k) => o[k] },
    t: (key) => key,
    models: [
      { id: "supertonic", family: "supertonic", displayName: "Supertonic", category: "tts" },
      { id: "chatterbox", family: "chatterbox", displayName: "Chatterbox", category: "tts" }
    ],
    instances: [{ id: "i1", modelId: "supertonic", instanceName: "supertonic", status: "READY" }],
    categoryName: (c) => c,
    statusText: (s) => s,
    modelRoute: (id) => "#/model/" + id,
    Api: { poll: () => () => {} },
    navigated: []
  };
  base.go = (hash) => base.navigated.push(hash);

  const asyncUi = loadEsModule("modules/async-ui.js", { ...base });
  const palette = loadEsModule("modules/command-palette.js", {
    ...base,
    focusDialog: asyncUi.focusDialog,
    isOpen: asyncUi.isOpen,
    restoreDialogFocus: asyncUi.restoreDialogFocus
  });
  return { asyncUi, palette, navigated: base.navigated };
}

function setup() {
  const dom = buildDom();
  return { ...dom, ...loadModules(dom.world) };
}

const active = (w) => w.world.document.activeElement;
const activeName = (w) =>
  active(w) === w.world.document.body ? "BODY" : active(w).id || active(w).tagName;

test("打开命令面板后焦点落在搜索框上（回归）", () => {
  const w = setup();
  w.palette.openCommandPalette();

  // 与浏览器一致：刚摘掉 .hidden 那一帧，遮罩的 visibility 过渡还没生效，焦点落不上去
  assert.equal(active(w), w.world.document.body, "打开的同步阶段焦点就该还没落上——这是缺陷的现场");

  w.world.flushFrames(2);
  assert.equal(active(w), w.input, "过渡生效后重试必须把焦点补到搜索框上");
  assert.equal(activeName(w), "command-palette-input");

  // 焦点一落上就不再排下一帧：一个 rAF 都不多等
  const queued = w.world.rafQueue.length;
  w.world.flushFrames(5);
  assert.equal(w.world.rafQueue.length, queued, "焦点落上后不该继续重试");
});

test("焦点目标显式指定：弹窗外的 preferred 被忽略", () => {
  const w = setup();
  w.palette.openCommandPalette();
  w.world.flushFrames(2);
  assert.equal(active(w), w.input);

  // opener 在 header 里，不在弹窗内 → 退回「第一个可聚焦元素」，本例同样是搜索框
  w.asyncUi.focusDialog(w.paletteEl, w.opener);
  w.world.flushFrames(2);
  assert.equal(active(w), w.input);
  assert.equal(w.asyncUi.isOpen("command-palette"), true);
});

test("焦点落上后 ↑↓ / Enter / 打字立即可用（aria-activedescendant 联动）", () => {
  const w = setup();
  w.palette.openCommandPalette();
  w.world.flushFrames(2);
  assert.equal(active(w), w.input);

  w.input.value = "supertonic";
  w.world.fire(w.input, "input", {});
  assert.equal(
    w.list.querySelectorAll(".cp-item").length,
    2,
    "过滤后应剩 supertonic 的模型项与实例项"
  );
  assert.equal(w.input.getAttribute("aria-activedescendant"), "cp-opt-0");

  w.world.fire(w.input, "keydown", { key: "ArrowDown" });
  assert.equal(w.input.getAttribute("aria-activedescendant"), "cp-opt-1");
  assert.equal(w.list.querySelector(".cp-item.active").getAttribute("aria-selected"), "true");
  assert.equal(w.list.querySelector(".cp-item.active").getAttribute("id"), "cp-opt-1");

  w.world.fire(w.input, "keydown", { key: "Enter" });
  assert.deepEqual(w.navigated, ["#/instance/i1"], "Enter 应执行当前高亮项");
  assert.equal(w.asyncUi.isOpen("command-palette"), false, "执行后弹窗应关闭");

  // 过滤到空：aria-activedescendant 必须撤掉，否则读屏会指向不存在的选项
  w.palette.openCommandPalette();
  w.world.flushFrames(2);
  w.input.value = "zzz-无匹配";
  w.world.fire(w.input, "input", {});
  assert.equal(w.list.querySelectorAll(".cp-item").length, 0);
  assert.equal(w.input.getAttribute("aria-activedescendant"), null);
});

test("关闭后焦点还原到触发元素；触发元素是 body 时交回文档开头", () => {
  const w = setup();
  w.opener.focus();
  w.palette.openCommandPalette();
  w.world.flushFrames(2);
  assert.equal(active(w), w.input);

  w.palette.closeCommandPalette();
  assert.equal(active(w), w.opener, "关闭后应回到打开它的按钮");

  // Ctrl/Cmd-K 从没聚焦过的页面唤起：栈里存的是 body，body.focus() 是空操作，
  // 不兜底的话焦点就滞留在 visibility:hidden 的输入框里（看不见也 Tab 不到）
  w.opener.blur();
  w.palette.openCommandPalette();
  w.world.flushFrames(2);
  assert.equal(active(w), w.input);
  w.palette.closeCommandPalette();
  assert.equal(active(w), w.world.document.body);
});

test("立刻关闭：排队的焦点重试不会把焦点抢回去", () => {
  const w = setup();
  w.opener.focus();
  w.palette.openCommandPalette();
  w.palette.closeCommandPalette(); // 同一帧内开又关
  w.world.flushFrames(10);
  assert.equal(active(w), w.opener, "已关闭的弹窗不得在后续帧抢焦点");
});

test("焦点重试有帧预算兜底：目标始终接不住焦点时收敛而不是无限跑", () => {
  const w = setup();
  // 一个永远打不开的弹窗（带 .hidden → 整棵子树 visibility:hidden），目标永远接不住焦点
  const stuck = w.world.el('<div class="modal-overlay hidden" id="stuck-overlay"></div>');
  const target = w.world.el('<input id="stuck-input" type="text"></input>');
  stuck.appendChild(w.world.el('<div class="busy-box"></div>')).appendChild(target);
  w.world.document.body.appendChild(stuck);

  w.asyncUi.focusDialog(stuck, target);
  assert.ok(w.world.rafQueue.length > 0, "落不上焦点时应改为逐帧重试，而不是静默放弃");
  w.world.flushFrames(60);
  assert.equal(w.world.rafQueue.length, 0, "超过帧预算后应停止重试");
  assert.notEqual(active(w), target, "不可聚焦的目标不该拿到焦点");
});
