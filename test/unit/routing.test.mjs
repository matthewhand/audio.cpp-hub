/* #102 单元测试：web/modules/routing.js（hash 路由解析与 applyRoute 应用）。
   web/ 无构建，模块是浏览器原生 ES module，node 无法直接 import；这里沿用
   helpers/vm.mjs 的 vm 沙箱模式：剥掉 import/export 后整体求值，把各功能模块
   （models / instances / settings / sidebar / downloads）做成桩，从而能在同一个
   realm 里同时验证「路由意图」纯函数与 applyRoute 的副作用。不修改任何前端源码。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEsModule } from "./helpers/vm.mjs";

/** 建一个全新的路由 realm；每个测试独立，避免 applyingRoute / pending* 状态串味。 */
function makeRouting({ hash = "", instances = [], selectedModelId = null } = {}) {
  const location = { hash };
  const open = new Set();
  const log = [];
  /* 面板开/关都同步 open 集合，这样 applyRoute 的 isOpen 门控与「后一帧关掉前一帧」
     才能按真实顺序被断言到。 */
  const panel = (openName, closeName, id) => ({
    open: (...a) => {
      open.add(id);
      log.push([openName, ...a]);
    },
    close: (...a) => {
      open.delete(id);
      log.push([closeName, ...a]);
    }
  });
  const history = panel("openHistoryPanel", "closeHistoryPanel", "history-panel");
  const voices = panel("openVoicesPanel", "closeVoicesPanel", "voices-panel");
  const downloads = panel("openDownloadsModal", "closeDownloadsModal", "downloads-modal");
  const stats = panel("openStatsPanel", "closeStatsPanel", "stats-panel");
  const settings = panel("openSettingsModal", "closeSettingsModal", "settings-modal");
  const detail = panel("openInstanceDetail", "closeInstanceDetail", "instance-detail-modal");
  const wired = [];
  const sandbox = {
    window: { location },
    location,
    selectedModelId,
    instances,
    isOpen: (id) => open.has(id),
    closeHistoryPanel: history.close,
    openHistoryPanel: history.open,
    /* 四个懒加载外观（stats-lazy / voices-panel-lazy / downloads-lazy / settings-lazy）
       各自负责自己的页头按钮接线，routing.js 把导航函数传进去以避开与它们的模块环。 */
    wireStatsButton: (...a) => wired.push(["wireStatsButton", ...a]),
    wireVoicesButton: (...a) => wired.push(["wireVoicesButton", ...a]),
    wireDownloadsButton: (...a) => wired.push(["wireDownloadsButton", ...a]),
    wireSettingsButtons: (...a) => wired.push(["wireSettingsButtons", ...a]),
    openVoicesPanel: voices.open,
    closeVoicesPanel: voices.close,
    closeDownloadsModal: downloads.close,
    openDownloadsModal: downloads.open,
    closeStatsPanel: stats.close,
    openStatsPanel: stats.open,
    closeSettingsModal: settings.close,
    openSettingsModal: settings.open,
    closeInstanceDetail: detail.close,
    openInstanceDetail: detail.open,
    selectModelById: (id) => log.push(["selectModelById", id])
  };
  // hashchange 监听注册在 window 上（applyRoute 是唯一应用视图的入口）
  const hashchange = [];
  sandbox.window.addEventListener = (evt, fn) => {
    if (evt === "hashchange") hashchange.push(fn);
  };
  const mod = loadEsModule("modules/routing.js", sandbox);
  return {
    ...mod,
    sandbox,
    location,
    open,
    log,
    wired,
    names: () => log.map((e) => e[0]),
    /** 模拟浏览器前进/后退：改 hash 后派发 hashchange */
    navigate: (next) => {
      location.hash = next;
      for (const fn of hashchange) fn();
    }
  };
}

/* vm realm 造出来的对象/数组原型与测试 realm 不同，deepStrictEqual 会因原型不等而失败。
   跨 realm 的返回值统一先摊平成测试 realm 的普通值再断言。 */
const plain = (v) => (Array.isArray(v) ? [...v] : { ...v });
test("routing: ROUTE_VIEWS 列出面板路由（顺序即页头按钮顺序）", () => {
  assert.deepEqual(plain(makeRouting().ROUTE_VIEWS), [
    "history",
    "voices",
    "downloads",
    "stats",
    "settings"
  ]);
});

test("routing: parseRoute 表驱动——模型 / 实例 / 面板 / 兜底", () => {
  const { parseRoute } = makeRouting();
  const cases = [
    // 模型与实例带 id
    ["#/model/qwen3-tts", { view: "model", id: "qwen3-tts" }],
    ["#/model/qwen3_tts-0.6B", { view: "model", id: "qwen3_tts-0.6B" }],
    ["#/instance/ab12cd34", { view: "instance", id: "ab12cd34" }],
    // 面板视图不带 id
    ["#/history", { view: "history" }],
    ["#/voices", { view: "voices" }],
    ["#/downloads", { view: "downloads" }],
    ["#/stats", { view: "stats" }],
    ["#/settings", { view: "settings" }],
    // 空 / 畸形 hash → home
    ["", { view: "home" }],
    ["#", { view: "home" }],
    ["#/", { view: "home" }],
    [undefined, { view: "home" }],
    [null, { view: "home" }],
    ["#/nope", { view: "home" }],
    ["#/model", { view: "home" }],
    ["#/model/", { view: "home" }],
    ["#/instance", { view: "home" }],
    ["#/instance/", { view: "home" }],
    ["#/MODEL/x", { view: "home" }], // 大小写敏感
    ["#/settingss", { view: "home" }] // 不做前缀匹配
  ];
  for (const [hash, want] of cases) {
    assert.deepEqual(plain(parseRoute(hash)), want, `parseRoute(${JSON.stringify(hash)})`);
  }
});

test("routing: parseRoute 容忍缺省斜杠、多余段与空段", () => {
  const { parseRoute } = makeRouting();
  assert.deepEqual(plain(parseRoute("#model/x")), { view: "model", id: "x" }, "缺 / 也认");
  assert.deepEqual(plain(parseRoute("#/model/a/b")), { view: "model", id: "a" }, "只取第二段");
  assert.deepEqual(plain(parseRoute("#/history/extra")), { view: "history" }, "面板忽略多余段");
  assert.deepEqual(plain(parseRoute("#/model//x")), { view: "model", id: "x" }, "空段被过滤");
  assert.deepEqual(
    plain(parseRoute("#/model/a%3Fb")),
    { view: "model", id: "a?b" },
    "带 query 的 id"
  );
});

test("routing: parseRoute 对 id 做 URL 解码（与 modelRoute 互逆）", () => {
  const { parseRoute, modelRoute } = makeRouting();
  for (const id of ["a b", "a/b", "中文模型", "qwen+plus", "100%", "a#b"]) {
    const hash = modelRoute(id);
    assert.equal(parseRoute(hash).id, id, `往返 ${JSON.stringify(id)}`);
  }
  assert.equal(parseRoute("#/model/a%20b").id, "a b");
  assert.equal(parseRoute("#/model/a%2Fb").id, "a/b");
  assert.equal(parseRoute("#/model/%E4%B8%AD%E6%96%87").id, "中文");
});

test("routing: modelRoute 编码 id 并回退到当前选中模型", () => {
  const r = makeRouting({ selectedModelId: "cosyvoice2" });
  assert.equal(r.modelRoute("qwen3 tts"), "#/model/qwen3%20tts");
  assert.equal(r.modelRoute("a/b"), "#/model/a%2Fb");
  assert.equal(r.modelRoute("a-b_c.d"), "#/model/a-b_c.d", "encodeURIComponent 不转义这些");
  // 不传 id → 用 state.selectedModelId
  assert.equal(r.modelRoute(), "#/model/cosyvoice2");
  assert.equal(r.modelRoute(""), "#/model/cosyvoice2", "空串同样回退");
  // 两者都空 → 首页
  r.sandbox.selectedModelId = "";
  assert.equal(r.modelRoute(), "#/");
  assert.equal(r.defaultRoute(), "#/", "defaultRoute 就是 modelRoute()");
});

test("routing: go 换 hash 交给 hashchange，同 hash 则重放 applyRoute", () => {
  const r = makeRouting({ hash: "#/model/a" });
  r.go("#/history");
  assert.equal(r.location.hash, "#/history");
  assert.deepEqual(r.log, [], "换 hash 不立即应用视图（由 hashchange 驱动）");

  r.go("#/history");
  assert.equal(r.location.hash, "#/history");
  assert.deepEqual(r.names(), ["openHistoryPanel"], "同 hash 直接重放（用于重试）");
});

test("routing: goPanel 再次点击同一面板即收起回默认路由", () => {
  const r = makeRouting({ hash: "", selectedModelId: "m1" });
  r.goPanel("voices");
  assert.equal(r.location.hash, "#/voices");

  r.goPanel("voices");
  assert.equal(r.location.hash, "#/model/m1", "收起回默认模型路由");
  assert.deepEqual(r.log, [], "收起同样只改 hash");

  r.location.hash = "#/settings";
  r.goPanel("voices");
  assert.equal(r.location.hash, "#/voices", "从别的面板点开目标面板");
});

test("routing: applyRoute 按视图开面板 / 选模型（表驱动）", () => {
  const cases = [
    ["#/history", ["openHistoryPanel"]],
    ["#/voices", ["openVoicesPanel"]],
    ["#/downloads", ["openDownloadsModal"]],
    ["#/stats", ["openStatsPanel"]],
    ["#/settings", ["openSettingsModal"]],
    ["#/model/qwen3-tts", ["selectModelById"]],
    ["#/nope", []],
    ["", []]
  ];
  for (const [hash, want] of cases) {
    const r = makeRouting({ hash });
    r.applyRoute();
    assert.deepEqual(r.names(), want, `applyRoute(${JSON.stringify(hash)})`);
  }
});

test("routing: applyRoute 只关「确实打开且非目标」的其它面板", () => {
  const r = makeRouting({ hash: "#/settings" });
  r.open.add("history-panel");
  r.open.add("voices-panel");
  r.open.add("downloads-modal");
  r.open.add("settings-modal");
  r.applyRoute();
  assert.deepEqual(
    r.names(),
    ["closeHistoryPanel", "closeVoicesPanel", "closeDownloadsModal", "openSettingsModal"],
    "settings 是目标 → 不自关；未打开的不动"
  );
});

test("routing: applyRoute 对未打开的面板不调用关闭函数", () => {
  const r = makeRouting({ hash: "#/history" });
  r.applyRoute();
  assert.deepEqual(r.names(), ["openHistoryPanel"], "isOpen 为假 → 不关，避免误触焦点还原");
});

test("routing: 四个懒加载外观的页头按钮接线在模块求值时各调一次", () => {
  /* 看板 / 音色库 / 下载 / 设置都是「点开才拉 chunk」的弹窗，页头按钮必须在 chunk
     到位前就能用，因此由 routing.js 在求值期把 go / goPanel 交给各自外观层接线。
     漏掉任何一个，页头按钮就会静默失灵（chunk 里绑了 onclick 也没人加载它）。 */
  const r = makeRouting();
  assert.deepEqual(
    r.wired.map(([name]) => name),
    ["wireStatsButton", "wireVoicesButton", "wireDownloadsButton", "wireSettingsButtons"]
  );
  // 传下去的是 routing.js 自己的导航函数（设了 window.hub* 钩子的那几个）
  for (const [, ...args] of r.wired) {
    for (const fn of args) assert.equal(typeof fn, "function");
  }
});

test("routing: applyRoute 打开音色库走懒加载外观（异步 import 的那一侧）", () => {
  /* voices-panel.js 是懒加载 chunk，routing.js 只 import 外观层：面板的打开因此是
     「发起加载 + 异步渲染」，路由本身仍是同步的（不阻塞 hashchange 返回）。 */
  const r = makeRouting({ hash: "#/voices" });
  r.applyRoute();
  assert.deepEqual(r.names(), ["openVoicesPanel"]);
  assert.equal(r.sandbox.window.openVoicesPanel, undefined, "不再经 window 全局转发");
});

test("routing: applyRoute 设置分节用 pendingSettingsSection 且用后即清", () => {
  const r = makeRouting({ hash: "#/settings" });
  r.applyRoute();
  assert.deepEqual(r.log[0], ["openSettingsModal", "general"], "缺省分节 general");

  r.setPendingSettingsSection("devices");
  assert.equal(r.getPendingSettingsSection(), "devices");
  r.applyRoute();
  assert.deepEqual(r.log.at(-1), ["openSettingsModal", "devices"]);
  assert.equal(r.getPendingSettingsSection(), null, "消费后清空，避免下次误用");
});

test("routing: applyRoute 实例详情——命中即打开，未命中记 pending", () => {
  const inst = { id: "ab12cd34" };
  const known = makeRouting({ hash: "#/instance/ab12cd34", instances: [inst] });
  known.applyRoute();
  assert.deepEqual(known.log, [["openInstanceDetail", inst]], "传入整个实例对象");
  assert.equal(known.getPendingInstanceId(), null, "命中后无需 pending");

  const unknown = makeRouting({ hash: "#/instance/zz99zz99", instances: [inst] });
  unknown.applyRoute();
  assert.deepEqual(unknown.log, [], "数据未到时先记 pending，不开面板");
  assert.equal(unknown.getPendingInstanceId(), "zz99zz99");
});

test("routing: applyRoute 离开实例视图时清 pending 并关详情", () => {
  const r = makeRouting({ hash: "#/model/m1", instances: [{ id: "ab12cd34" }] });
  r.setPendingInstanceId("zz99zz99");
  r.open.add("instance-detail-modal");
  r.applyRoute();
  assert.equal(r.getPendingInstanceId(), null, "离开实例视图即丢弃 pending");
  assert.ok(r.names().includes("closeInstanceDetail"));
});

test("routing: applyRoute 停在实例视图时保留 pending 且不关详情", () => {
  const r = makeRouting({ hash: "#/instance/zz99zz99", instances: [] });
  r.setPendingInstanceId("zz99zz99");
  r.applyRoute();
  assert.equal(r.getPendingInstanceId(), "zz99zz99");
  assert.ok(!r.names().includes("closeInstanceDetail"));
});

test("routing: applyingRoute 防重入——关闭回调里再进 applyRoute 不递归", () => {
  const r = makeRouting({ hash: "#/settings" });
  let reentered = 0;
  r.open.add("history-panel");
  r.sandbox.closeHistoryPanel = () => {
    r.log.push(["closeHistoryPanel"]);
    r.sandbox.window.hubApplyRoute(); // 模拟 closeX 误触发导航
    reentered++;
  };
  r.applyRoute();
  assert.equal(reentered, 1, "重入的 applyRoute 立即返回，不递归");
  assert.deepEqual(r.names(), ["closeHistoryPanel", "openSettingsModal"]);
});

test("routing: applyingRoute 在 applyRoute 期间拦下 hubPanelClosed", () => {
  const r = makeRouting({ hash: "#/history" });
  r.sandbox.closeHistoryPanel = () => {
    r.log.push(["closeHistoryPanel"]);
    r.sandbox.window.hubPanelClosed("history"); // 自动关闭不得误导航
  };
  r.open.add("history-panel");
  r.location.hash = "#/settings";
  r.applyRoute();
  assert.equal(r.location.hash, "#/settings", "应用路由期间面板自关不改变 hash");
});

test("routing: hubPanelClosed 只在当前路由仍指向该面板时回退", () => {
  const r = makeRouting({ hash: "#/history", selectedModelId: "m1" });
  r.sandbox.window.hubPanelClosed("voices");
  assert.equal(r.location.hash, "#/history", "非当前面板 → 不动");

  r.sandbox.window.hubPanelClosed("history");
  assert.equal(r.location.hash, "#/model/m1", "当前面板被关 → 回默认路由");
});

test("routing: window.hub* 钩子与 hashchange 监听都已挂上", () => {
  const r = makeRouting({ hash: "" });
  assert.equal(r.sandbox.window.hubNavigate, r.go);
  assert.equal(r.sandbox.window.hubTogglePanel, r.goPanel);
  assert.equal(r.sandbox.window.hubApplyRoute, r.applyRoute);
  assert.equal(typeof r.sandbox.window.hubPanelClosed, "function");
});

test("routing: 浏览器前进/后退经 hashchange 重放历史视图", () => {
  const r = makeRouting({ hash: "" });
  r.sandbox.window.hubNavigate("#/history");
  r.navigate("#/history");
  r.sandbox.window.hubNavigate("#/settings");
  r.navigate("#/settings");
  r.navigate("#/history"); // 后退
  assert.deepEqual(
    r.log.map(([name]) => name),
    [
      "openHistoryPanel",
      "closeHistoryPanel",
      "openSettingsModal",
      "closeSettingsModal",
      "openHistoryPanel"
    ],
    "前进/后退逐帧还原面板开关"
  );
});

test("routing: pending* 三个意图读写对称（模型 / 实例 / 设置分节）", () => {
  const r = makeRouting();
  assert.deepEqual(
    [r.getPendingModelId(), r.getPendingInstanceId(), r.getPendingSettingsSection()],
    [null, null, null]
  );
  r.setPendingModelId("m1");
  r.setPendingInstanceId("i1");
  r.setPendingSettingsSection("voices");
  assert.deepEqual(
    [r.getPendingModelId(), r.getPendingInstanceId(), r.getPendingSettingsSection()],
    ["m1", "i1", "voices"]
  );
  r.setPendingModelId(null);
  r.setPendingInstanceId(null);
  r.setPendingSettingsSection(null);
  assert.deepEqual(
    [r.getPendingModelId(), r.getPendingInstanceId(), r.getPendingSettingsSection()],
    [null, null, null]
  );
});
