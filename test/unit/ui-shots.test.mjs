/* Unit tests for scripts/ui-shots.mjs: the viewport matrix, the single light
 * shot, the overflow verdict and the report builder.
 *
 * What runs inside Chromium (goto, console capture, control measurement) is
 * proven by actually running the tool; this file pins the pure contract the
 * runner and the AGENTS.md "UI verification standard" checklist share. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIEWPORTS,
  LIGHT_SHOT,
  KEY_CONTROLS,
  SIDEBAR_CONTROL_IDS,
  DRAWER_MAX_WIDTH,
  shouldOpenDrawer,
  HEADER_BUTTONS_PHASES,
  SHOT_LABELS,
  resolveShotLabel,
  evaluateOverflow,
  buildReport
} from "../../scripts/ui-shots.mjs";

/* Cross-realm pitfall: assert.deepStrictEqual compares prototypes, and values
   that crossed a realm boundary (vm sandbox, JSON) fail it. Round-trip first. */
const plain = (v) => JSON.parse(JSON.stringify(v));

const EXPECTED_VIEWPORTS = [
  { name: "mobile-360x800", width: 360, height: 800 },
  { name: "mobile-390x844", width: 390, height: 844 },
  { name: "tablet-768x1024", width: 768, height: 1024 },
  { name: "laptop-1280x720", width: 1280, height: 720 },
  { name: "desktop-1920x1080", width: 1920, height: 1080 }
];

/** A raw per-viewport result as shootViewport() would hand it to buildReport. */
function rawViewport(over = {}) {
  const controls = {};
  for (const id of Object.keys(KEY_CONTROLS)) {
    controls[id] = { present: true, visible: true, reachable: true, aboveFold: true };
  }
  return {
    name: "laptop-1280x720",
    width: 1280,
    height: 720,
    consoleErrors: [],
    overflow: { scrollWidth: 1280, clientWidth: 1280 },
    controls,
    fold: { pass: true, failing: [] },
    pass: true,
    drawerOpened: false,
    headerButtons: "closed",
    overflowDrawerOpen: null,
    shots: ["laptop-1280x720-dark.png", "laptop-1280x720-light.png"],
    ...over
  };
}

test("VIEWPORTS: 视口矩阵钉死为 AGENTS.md 规定的五档", () => {
  assert.deepEqual(plain(VIEWPORTS), EXPECTED_VIEWPORTS);
  const names = VIEWPORTS.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, "视口名必须唯一（截图文件名去重）");
  for (const vp of VIEWPORTS) {
    assert.ok(vp.width > 0 && vp.height > 0, `${vp.name} 尺寸必须为正`);
  }
});

test("LIGHT_SHOT: 唯一的浅色截图落在笔记本或桌面视口", () => {
  assert.equal(["laptop-1280x720", "desktop-1920x1080"].includes(LIGHT_SHOT), true);
  assert.equal(
    VIEWPORTS.filter((v) => v.name === LIGHT_SHOT).length,
    1,
    "必须命中矩阵中的一个视口"
  );
});

test("KEY_CONTROLS: 关键控件就是 index.html 里的真实锚点", () => {
  assert.deepEqual(Object.keys(KEY_CONTROLS).sort(), [
    "activity-panel",
    "downloads-btn",
    "history-btn",
    "instance-list",
    "lang-toggle",
    "models-panel",
    "settings-btn",
    "stats-btn",
    "theme-toggle",
    "tts-submit",
    "voices-btn"
  ]);
  assert.equal(KEY_CONTROLS["tts-submit"], "#tts-submit", "合成按钮");
  assert.equal(KEY_CONTROLS["instance-list"], "#instance-list .card", "实例卡片");
  assert.equal(KEY_CONTROLS["activity-panel"], "#activity-panel", "最近活动面板");
  assert.equal(KEY_CONTROLS["models-panel"], "#model-panel", "模型面板");
});

test("SIDEBAR_CONTROL_IDS: 抽屉里的三个控件必须都在 KEY_CONTROLS 里", () => {
  assert.deepEqual(plain(SIDEBAR_CONTROL_IDS), ["instance-list", "activity-panel", "models-panel"]);
  for (const id of SIDEBAR_CONTROL_IDS) {
    assert.equal(typeof KEY_CONTROLS[id], "string", `${id} 缺少选择器`);
  }
});

test("shouldOpenDrawer: 只有 ≤ DRAWER_MAX_WIDTH 的视口先开抽屉", () => {
  assert.equal(DRAWER_MAX_WIDTH, 900);
  assert.equal(shouldOpenDrawer(360), true);
  assert.equal(shouldOpenDrawer(390), true);
  assert.equal(shouldOpenDrawer(768), true);
  assert.equal(shouldOpenDrawer(900), true);
  assert.equal(shouldOpenDrawer(901), false);
  assert.equal(shouldOpenDrawer(1280), false);
  assert.equal(shouldOpenDrawer(1920), false);
  assert.equal(shouldOpenDrawer(0), false, "0 不是有效宽度");
  assert.equal(shouldOpenDrawer(-1), false);
  assert.equal(shouldOpenDrawer(NaN), false);
  assert.equal(shouldOpenDrawer(undefined), false);
  // 矩阵里 mobile / tablet 三档开抽屉，laptop / desktop 两档不开
  assert.deepEqual(
    plain(VIEWPORTS.map((v) => shouldOpenDrawer(v.width))),
    [true, true, true, false, false]
  );
});

test("resolveShotLabel: 默认 production，显式 mock-backend，未知值报错", () => {
  assert.equal(resolveShotLabel(undefined), "production");
  assert.equal(resolveShotLabel(""), "production");
  assert.equal(resolveShotLabel("   "), "production");
  assert.equal(resolveShotLabel("mock-backend"), "mock-backend");
  assert.equal(resolveShotLabel(" production "), "production");
  assert.deepEqual(plain(SHOT_LABELS), ["production", "mock-backend"]);
  assert.throws(() => resolveShotLabel("live"), /LABEL must be one of/);
});

test("HEADER_BUTTONS_PHASES: 页头按钮的测量阶段只有两种取值", () => {
  assert.deepEqual(plain(HEADER_BUTTONS_PHASES), ["closed", "overflow-open"]);
});

test("evaluateOverflow: 宽度相等即通过", () => {
  const result = evaluateOverflow({ scrollWidth: 1280, clientWidth: 1280 });
  assert.equal(result.pass, true);
  assert.equal(result.scrollWidth, 1280);
  assert.equal(result.clientWidth, 1280);
});

test("evaluateOverflow: 横向多出 1px 即失败", () => {
  assert.equal(evaluateOverflow({ scrollWidth: 1281, clientWidth: 1280 }).pass, false);
});

test("evaluateOverflow: 取不到度量时判失败（未知不等于通过）", () => {
  assert.equal(evaluateOverflow(null).pass, false);
  assert.equal(evaluateOverflow(undefined).pass, false);
});

test("buildReport: 全部通过时 overall 为 true", () => {
  const report = buildReport([rawViewport()], { baseUrl: "http://127.0.0.1:4173" });
  assert.equal(report.overall, true);
  assert.equal(report.viewports[0].pass, true);
  assert.equal(report.viewports[0].fold.pass, true);
  assert.equal(report.baseUrl, "http://127.0.0.1:4173");
  assert.equal(typeof report.generatedAt, "string");
});

test("buildReport: 任一视口不通过 overall 即为 false", () => {
  const bad = rawViewport({
    name: "mobile-360x800",
    width: 360,
    height: 800,
    consoleErrors: ["console.error: boom"]
  });
  const report = buildReport([rawViewport(), bad]);
  assert.equal(report.overall, false);
  assert.equal(report.viewports[0].pass, true, "其它视口不受牵连");
  assert.equal(report.viewports[1].pass, false);
});

test("buildReport: 只有控件不可达也会让该视口不通过", () => {
  const controls = rawViewport().controls;
  controls["tts-submit"] = { present: true, visible: true, reachable: false, aboveFold: false };
  const report = buildReport([rawViewport({ controls })]);
  assert.equal(report.viewports[0].pass, false);
  assert.equal(report.overall, false);
  assert.equal(report.viewports[0].fold.failing.includes("tts-submit"), true);
});

test("buildReport: 仅首屏折叠失败不判失败，但必须被记录下来", () => {
  const controls = rawViewport().controls;
  controls["activity-panel"] = { present: true, visible: true, reachable: true, aboveFold: false };
  const report = buildReport([rawViewport({ controls })]);
  assert.equal(report.viewports[0].pass, true, "折叠是独立结果，不影响通过判定");
  assert.equal(report.overall, true);
  assert.deepEqual(plain(report.viewports[0].fold), { pass: false, failing: ["activity-panel"] });
});

test("buildReport: 溢出判定由 evaluateOverflow 重新派生，不信任传入的 pass", () => {
  const report = buildReport([rawViewport({ overflow: { scrollWidth: 1281, clientWidth: 1280 } })]);
  assert.equal(report.viewports[0].overflow.pass, false);
  assert.equal(report.viewports[0].pass, false);
  assert.equal(report.overall, false);
});

test("buildReport: 抽屉字段与图片标注只做增量，顶层 JSON 形状不变", () => {
  const mobile = rawViewport({
    name: "mobile-360x800",
    width: 360,
    height: 800,
    drawerOpened: true,
    headerButtons: "closed",
    overflowDrawerOpen: { scrollWidth: 360, clientWidth: 360 },
    shots: ["mobile-360x800-dark.png", "mobile-360x800-drawer-open-dark.png"]
  });
  const report = buildReport([mobile], { baseUrl: "http://127.0.0.1:4173", label: "production" });
  const vp = report.viewports[0];
  assert.equal(vp.drawerOpened, true);
  assert.equal(vp.headerButtons, "closed");
  assert.deepEqual(plain(vp.shotsLabelled), {
    "mobile-360x800-dark.png": "production",
    "mobile-360x800-drawer-open-dark.png": "production"
  });
  assert.deepEqual(plain(vp.overflowDrawerOpen), {
    pass: true,
    scrollWidth: 360,
    clientWidth: 360
  });
  // 没开抽屉的视口：overflowDrawerOpen 为 null，drawerOpened 为 false
  const laptop = buildReport([rawViewport()], { label: "mock-backend" }).viewports[0];
  assert.equal(laptop.drawerOpened, false);
  assert.equal(laptop.overflowDrawerOpen, null);
  assert.deepEqual(plain(laptop.shotsLabelled), {
    "laptop-1280x720-dark.png": "mock-backend",
    "laptop-1280x720-light.png": "mock-backend"
  });
});

test("buildReport: 开抽屉后横向溢出同样让该视口不通过", () => {
  const report = buildReport([
    rawViewport({
      name: "tablet-768x1024",
      width: 768,
      height: 1024,
      drawerOpened: true,
      overflow: { scrollWidth: 768, clientWidth: 768 },
      overflowDrawerOpen: { scrollWidth: 900, clientWidth: 768 }
    })
  ]);
  assert.equal(report.viewports[0].overflow.pass, true, "关闭态本身没溢出");
  assert.equal(report.viewports[0].overflowDrawerOpen.pass, false, "抽屉态溢出了");
});

test("buildReport: 截图清单与形状保持稳定（可 JSON 序列化）", () => {
  const report = buildReport([rawViewport()]);
  const round = JSON.parse(JSON.stringify(report));
  assert.deepEqual(round.viewports[0].shots, [
    "laptop-1280x720-dark.png",
    "laptop-1280x720-light.png"
  ]);
  assert.deepEqual(Object.keys(round), ["baseUrl", "generatedAt", "viewports", "overall"]);
  /* 视口条目只增不改：新字段追加在中间，老字段的顺序与含义不动 */
  assert.deepEqual(Object.keys(round.viewports[0]), [
    "name",
    "width",
    "height",
    "consoleErrors",
    "overflow",
    "controls",
    "fold",
    "drawerOpened",
    "headerButtons",
    "overflowDrawerOpen",
    "shotsLabelled",
    "pass",
    "shots"
  ]);
});
