/* 单元测试：三个「点击才打开」面板的懒加载外观层
 * （web/modules/voices-panel-lazy.js / downloads-lazy.js / settings-lazy.js）。
 *
 * 这一轮把音色库、下载、设置三块从首屏模块图挪到懒加载 chunk，沿用 stats-lazy /
 * file-browser-lazy 已有的形状，因此外观层要守住的契约完全一致：
 *   - 真模块只经 import("./x.js") 拉取，且并发打开共享同一次网络往返；
 *   - 同步路径（Esc 关最上层弹窗、applyRoute 的关闭分支、语言切换重画）在 chunk
 *     从未加载时必须是 no-op 或「只收起外壳」，不能抛错、不能卡住；
 *   - 「外壳先出、chunk 后填」的打开路径：外壳同步可见，点击反馈不等人；
 *   - 首屏就看得见的东西不许被懒加载（下载角标 + 它的 2s 轮询、可执行文件登记）；
 *   - 经典脚本 voice-select.js 依赖的 window.openVoicesPanel 仍挂得上。
 *
 * 与 stats-lazy.test.mjs 一样用 vm 沙箱：剥掉 import/export，再把
 * `import("./chunk.js")` 换成 sandbox 里的可控桩（vm 上下文不支持动态 import）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEsModule, readWeb } from "./helpers/vm.mjs";
import { modulepreloads, precached } from "../../scripts/perf-budget.mjs";

/* 把 `inflight = import("./chunk.js")` 重写成可控桩：锚在 `inflight = ` 上，
   以免改到文件头注释里同样的文本。 */
const stubImport = (chunk) => (src) =>
  src.replace(new RegExp(`inflight = import\\("\\./${chunk}"\\)`), "inflight = __load()");

/* ---------- 通用小工具：够用的 DOM / Api 桩 ---------- */
function fakeEl(extra = {}) {
  return {
    textContent: "",
    value: "",
    innerHTML: "",
    dataset: {},
    classList: {
      _on: new Set(),
      add(c) {
        this._on.add(c);
      },
      remove(c) {
        this._on.delete(c);
      },
      contains(c) {
        return this._on.has(c);
      },
      toggle(c, on) {
        if (on === undefined) on = !this._on.has(c);
        if (on) this._on.add(c);
        else this._on.delete(c);
      }
    },
    ...extra
  };
}
function makeElMap(ids) {
  const map = {};
  for (const id of ids) map[id] = fakeEl();
  return map;
}

/* 记录调用的桩，返回 [fn, calls] */
function spy(log, name, ret) {
  return (...args) => {
    log.push([name, ...args]);
    return ret;
  };
}

/* =================== 音色库：modules/voices-panel-lazy.js =================== */
function makeVoicesLazy({ importImpl } = {}) {
  const log = [];
  const els = makeElMap(["voices-btn"]);
  const btn = els["voices-btn"];
  const mod = {
    openVoicesPanel: spy(log, "mod.openVoicesPanel"),
    closeVoicesPanel: spy(log, "mod.closeVoicesPanel")
  };
  let loads = 0;
  const sandbox = {
    console: { error: (...a) => log.push(["error", ...a]) },
    $: (id) => els[id] || null,
    document: { getElementById: (id) => els[id] || null },
    window: {},
    __load: () => {
      loads++;
      return importImpl ? importImpl() : Promise.resolve(mod);
    }
  };
  sandbox.globalThis = sandbox;
  const api = loadEsModule("modules/voices-panel-lazy.js", sandbox, stubImport("voices-panel.js"));
  return { api, sandbox, btn, log, loads: () => loads };
}

test("voices-lazy: 求值期就挂上 window.openVoicesPanel / closeVoicesPanel", () => {
  /* web/voice-select.js 是经典脚本，import 不了 ES 模块，它按下拉的「管理」按钮走
     window.openVoicesPanel —— 外观层是这块全局的唯一挂载点，删掉就静默失效。 */
  const { api, sandbox } = makeVoicesLazy();
  assert.equal(sandbox.window.openVoicesPanel, api.openVoicesPanel);
  assert.equal(sandbox.window.closeVoicesPanel, api.closeVoicesPanel);
});

test("voices-lazy: closeVoicesPanel 在 chunk 未加载时是安全空操作", () => {
  const { api, log } = makeVoicesLazy();
  api.closeVoicesPanel(); // 面板不可能开着（它只能由 chunk 打开）→ 不抛错也不调真实模块
  assert.deepEqual(log, []);
});

test("voices-lazy: openVoicesPanel 等 chunk 到位后交给真实模块", async () => {
  const { api, log } = makeVoicesLazy();
  await api.openVoicesPanel();
  assert.ok(log.some(([k]) => k === "mod.openVoicesPanel"));
});

test("voices-lazy: 并发打开共享同一次动态 import（只加载一次）", async () => {
  const { api, loads } = makeVoicesLazy();
  await Promise.all([api.openVoicesPanel(), api.openVoicesPanel(), api.openVoicesPanel()]);
  assert.equal(loads(), 1);
});

test("voices-lazy: import 失败时记录错误而不抛出（点击不静默失效）", async () => {
  const { api, log } = makeVoicesLazy({ importImpl: () => Promise.reject(new Error("network")) });
  await api.openVoicesPanel();
  assert.ok(log.some(([k]) => k === "error"));
  // 失败不缓存：下次点击还能重试
  assert.equal(log.filter(([k]) => k === "error").length, 1);
});

test("voices-lazy: closeVoicesPanel 在加载后转发到真实模块", async () => {
  const { api, log } = makeVoicesLazy();
  await api.openVoicesPanel();
  log.length = 0;
  api.closeVoicesPanel();
  assert.ok(log.some(([k]) => k === "mod.closeVoicesPanel"));
});

test("voices-lazy: wireVoicesButton 把页头 🎙 接到 goPanel", () => {
  const { api, btn } = makeVoicesLazy();
  let route = null;
  api.wireVoicesButton((r) => {
    route = r;
  });
  assert.equal(typeof btn.onclick, "function");
  btn.onclick();
  assert.equal(route, "voices");
});

/* ===================== 下载：modules/downloads-lazy.js ===================== */
function makeDownloadsLazy({ importImpl, hidden = { "downloads-modal": true } } = {}) {
  const log = [];
  const els = makeElMap(["dl-badge", "downloads-modal", "dl-list", "downloads-btn"]);
  for (const [id, on] of Object.entries(hidden)) {
    if (on) els[id].classList.add("hidden");
  }
  let pollerCb = null;
  const Api = {
    poll: (url, onData) => {
      log.push(["Api.poll", url]);
      pollerCb = onData;
      return {
        refresh: () => Promise.resolve()
      };
    },
    list: () => Promise.resolve([])
  };
  const mod = {
    openDownloadsModal: spy(log, "mod.openDownloadsModal"),
    closeDownloadsModal: spy(log, "mod.closeDownloadsModal"),
    closeModelDlModal: spy(log, "mod.closeModelDlModal"),
    renderDownloadList: spy(log, "mod.renderDownloadList"),
    relocalize: spy(log, "mod.relocalize")
  };
  let loads = 0;
  const sandbox = {
    console: { error: (...a) => log.push(["error", ...a]) },
    $: (id) => els[id] || null,
    document: { getElementById: (id) => els[id] || null },
    // 外观层在「chunk 未加载就关闭」时会回退路由（与真实模块的 closeX 同一语义）
    window: { hubPanelClosed: (view) => log.push(["hubPanelClosed", view]) },
    isOpen: (id) => !!(els[id] && !els[id].classList.contains("hidden")),
    focusDialog: spy(log, "focusDialog"),
    restoreDialogFocus: spy(log, "restoreDialogFocus"),
    renderStateError: spy(log, "renderStateError"),
    Api,
    __load: () => {
      loads++;
      return importImpl ? importImpl() : Promise.resolve(mod);
    }
  };
  sandbox.globalThis = sandbox;
  const api = loadEsModule("modules/downloads-lazy.js", sandbox, stubImport("downloads.js"));
  return {
    api,
    els,
    log,
    loads: () => loads,
    feed: (data) => pollerCb && pollerCb(data)
  };
}

const dlRow = (status) => ({ id: "d" + status, status, targetDir: "x" });

test("downloads-lazy: 角标与 2s 轮询留在首屏（不随面板一起懒加载）", () => {
  /* 页头 ⬇️ 的角标在首屏就看得见，app.js 启动时必须建立轮询——这块数据因此不能进
     懒加载 chunk，否则没打开过下载面板的用户就永远看不到进行中的下载数。 */
  const d = makeDownloadsLazy();
  d.api.startDownloadsPolling();
  assert.ok(d.log.some(([k, url]) => k === "Api.poll" && url === "/api/downloads"));
  d.feed([dlRow("RUNNING"), dlRow("PENDING"), dlRow("DONE")]);
  assert.equal(d.els["dl-badge"].textContent, 2);
  assert.equal(d.els["dl-badge"].classList.contains("hidden"), false);
  d.feed([dlRow("DONE")]);
  assert.equal(d.els["dl-badge"].textContent, 0);
  assert.equal(d.els["dl-badge"].classList.contains("hidden"), true, "无进行中任务即隐藏角标");
  assert.equal(d.api.getDownloads().length, 1, "chunk 经 getDownloads() 读到同一份数据");
});

test("downloads-lazy: 打开时外壳同步可见，chunk 到位后再填内容", async () => {
  const d = makeDownloadsLazy();
  const p = d.api.openDownloadsModal();
  assert.equal(d.els["downloads-modal"].classList.contains("hidden"), false, "外壳同步显示");
  assert.ok(
    d.log.some(([k]) => k === "focusDialog"),
    "焦点在等待 chunk 时就移进弹窗"
  );
  await p;
  assert.ok(d.log.some(([k]) => k === "mod.openDownloadsModal"));
});

test("downloads-lazy: 关闭路径——chunk 在路上只收外壳，加载后转发真实模块", async () => {
  // Esc 落在「外壳已开、chunk 还在路上」那一帧：不抛错，把外壳收回并配平焦点栈
  const mid = makeDownloadsLazy();
  mid.api.openDownloadsModal(); // 不同步 await：正是 chunk 尚未到位的那一帧
  mid.log.length = 0;
  mid.api.closeDownloadsModal();
  assert.equal(mid.els["downloads-modal"].classList.contains("hidden"), true);
  assert.equal(
    mid.log.some(([k]) => k === "mod.closeDownloadsModal"),
    false,
    "chunk 未加载时不调真实模块"
  );
  assert.ok(
    mid.log.some(([k]) => k === "restoreDialogFocus"),
    "focusDialog 压过栈，关闭时要弹回来"
  );
  assert.ok(
    mid.log.some(([k, v]) => k === "hubPanelClosed" && v === "downloads"),
    "外壳收起时也要回退 hash，否则页头按钮与路由状态不一致"
  );
  // chunk 落地后不得再把面板打开（否则「按了 Esc 面板又弹出来」）
  await mid.api;
  assert.equal(
    mid.log.some(([k]) => k === "mod.openDownloadsModal"),
    false,
    "已请求关闭时，打开路径应放弃打开"
  );

  const loaded = makeDownloadsLazy();
  await loaded.api.openDownloadsModal();
  loaded.log.length = 0;
  loaded.api.closeDownloadsModal();
  assert.ok(loaded.log.some(([k]) => k === "mod.closeDownloadsModal"));
});

test("downloads-lazy: 关闭从未显示的外壳不误触焦点还原 / 路由回退", () => {
  const d = makeDownloadsLazy();
  d.api.closeDownloadsModal();
  assert.deepEqual(d.log, [], "弹窗从没打开过就别动焦点栈与 hash");
});

test("downloads-lazy: 轮询数据到达时，面板已开才重画列表", async () => {
  const d = makeDownloadsLazy();
  d.api.startDownloadsPolling();
  d.feed([dlRow("RUNNING")]);
  assert.equal(
    d.log.some(([k]) => k === "mod.renderDownloadList"),
    false,
    "面板没开就不渲染"
  );
  await d.api.openDownloadsModal();
  d.log.length = 0;
  d.feed([dlRow("RUNNING")]);
  assert.ok(
    d.log.some(([k]) => k === "mod.renderDownloadList"),
    "面板开着则实时重画"
  );
});

test("downloads-lazy: relocalize / closeModelDlModal 在未加载时是空转，加载后转发", async () => {
  const unloaded = makeDownloadsLazy();
  unloaded.api.relocalizeDownloads();
  unloaded.api.closeModelDlModal();
  assert.deepEqual(unloaded.log, []);

  const loaded = makeDownloadsLazy();
  await loaded.api.openDownloadsModal();
  loaded.log.length = 0;
  loaded.api.relocalizeDownloads();
  loaded.api.closeModelDlModal();
  assert.ok(loaded.log.some(([k]) => k === "mod.relocalize"));
  assert.ok(loaded.log.some(([k]) => k === "mod.closeModelDlModal"));
});

test("downloads-lazy: wireDownloadsButton 把页头 ⬇️ 接到 goPanel", () => {
  /* 页头按钮在 chunk 到位前就点得到：绑定必须在外观层，不能留在 chunk 里。 */
  const d = makeDownloadsLazy();
  let route = null;
  d.api.wireDownloadsButton((r) => {
    route = r;
  });
  assert.equal(typeof d.els["downloads-btn"].onclick, "function");
  d.els["downloads-btn"].onclick();
  assert.equal(route, "downloads");
  assert.equal(d.loads(), 0, "接线本身不触发任何下载");
});

/* ===================== 设置：modules/settings-lazy.js ===================== */
function makeSettingsLazy({ importImpl, execList = [] } = {}) {
  const log = [];
  const els = makeElMap([
    "settings-modal",
    "exec-list",
    "launch-exec",
    "launch-btn",
    "exec-empty-hint",
    "settings-btn",
    "exec-goto-btn",
    "exec-form-section",
    "exec-msg",
    "exec-name",
    "exec-path",
    "exec-note",
    "exec-env",
    "exec-form-title",
    "exec-add-btn",
    "launch-adv-options"
  ]);
  els["settings-modal"].classList.add("hidden");
  const opts = [];
  els["launch-exec"].appendChild = (o) => opts.push(o);
  const executables = execList;
  const mod = {
    openSettingsModal: spy(log, "mod.openSettingsModal"),
    closeSettingsModal: spy(log, "mod.closeSettingsModal"),
    renderExecList: spy(log, "mod.renderExecList"),
    relocalize: spy(log, "mod.relocalize")
  };
  let loads = 0;
  const sandbox = {
    console: { error: (...a) => log.push(["error", ...a]) },
    $: (id) => els[id] || null,
    document: { createElement: (tag) => fakeEl({ tag }) },
    // 外观层在「chunk 未加载就关闭」时会回退路由（与真实模块的 closeX 同一语义）
    window: { hubPanelClosed: (view) => log.push(["hubPanelClosed", view]) },
    isOpen: (id) => !!(els[id] && !els[id].classList.contains("hidden")),
    focusDialog: spy(log, "focusDialog"),
    restoreDialogFocus: spy(log, "restoreDialogFocus"),
    renderListError: spy(log, "renderListError"),
    Api: { list: () => Promise.resolve(execList.slice()) },
    executables,
    models: [{ id: "m1" }],
    setExecutables: (list) => {
      executables.length = 0;
      executables.push(...list);
      log.push(["setExecutables", list.length]);
    },
    renderModelList: spy(log, "renderModelList"),
    t: (k) => k,
    __load: () => {
      loads++;
      return importImpl ? importImpl() : Promise.resolve(mod);
    }
  };
  sandbox.globalThis = sandbox;
  const api = loadEsModule("modules/settings-lazy.js", sandbox, stubImport("settings.js"));
  return { api, els, log, opts, loads: () => loads, mod };
}

test("settings-lazy: 可执行文件登记留在首屏（启动弹窗下拉 + 模型卡片已配置态）", async () => {
  const d = makeSettingsLazy({ execList: [{ id: "e1", name: "CUDA", exists: true }] });
  await d.api.loadExecutables(); // app.js 首屏启动就调
  assert.ok(d.log.some(([k, n]) => k === "setExecutables" && n === 1));
  assert.deepEqual(
    d.opts.map((o) => o.textContent),
    ["CUDA"],
    "启动弹窗的下拉被填上"
  );
  assert.equal(d.els["launch-btn"].disabled, false);
  assert.ok(
    d.log.some(([k]) => k === "renderModelList"),
    "模型卡片已配置态跟着刷新"
  );
  assert.equal(
    d.log.some(([k]) => k === "mod.renderExecList"),
    false,
    "chunk 未加载时列表不渲染（打开设置时 loadExecutables 会补上）"
  );
});

test("settings-lazy: 打开时外壳同步可见，chunk 到位后带分节交给真实模块", async () => {
  const d = makeSettingsLazy();
  const p = d.api.openSettingsModal("executables");
  assert.equal(d.els["settings-modal"].classList.contains("hidden"), false);
  assert.ok(d.log.some(([k]) => k === "focusDialog"));
  await p;
  assert.ok(
    d.log.some(([a, b]) => a === "mod.openSettingsModal" && b === "executables"),
    "路由意图里的分节要透传给 chunk"
  );
});

test("settings-lazy: 关闭与语言切换在未加载时是空转 / 只收外壳", async () => {
  const unloaded = makeSettingsLazy();
  unloaded.api.closeSettingsModal();
  unloaded.api.relocalizeSettings();
  assert.deepEqual(unloaded.log, []);

  const d = makeSettingsLazy();
  await d.api.openSettingsModal("general");
  d.log.length = 0;
  d.api.relocalizeSettings();
  assert.ok(d.log.some(([k]) => k === "mod.relocalize"));

  // 外壳已开、chunk 还在路上时按 Esc：只收外壳并把焦点栈配平
  const mid = makeSettingsLazy();
  mid.api.openSettingsModal();
  mid.log.length = 0;
  mid.api.closeSettingsModal();
  assert.equal(mid.els["settings-modal"].classList.contains("hidden"), true);
  assert.ok(mid.log.some(([k]) => k === "restoreDialogFocus"));
  await mid.api;
  assert.equal(
    mid.log.some(([k]) => k === "mod.openSettingsModal"),
    false,
    "已请求关闭时，打开路径应放弃打开"
  );
});

test("settings-lazy: wireSettingsButtons 同时接页头 ⚙ 与启动弹窗的跳转按钮", () => {
  const d = makeSettingsLazy();
  const calls = [];
  const go = (h) => calls.push(["go", h]);
  const goPanel = (r) => calls.push(["goPanel", r]);
  const setPending = (s) => calls.push(["setPending", s]);
  d.api.wireSettingsButtons(go, goPanel, setPending);

  d.els["settings-btn"].onclick();
  assert.deepEqual(calls.at(-1), ["goPanel", "settings"]);
  d.els["exec-goto-btn"].onclick();
  assert.deepEqual(calls.at(-2), ["setPending", "executables"]);
  assert.deepEqual(calls.at(-1), ["go", "#/settings"]);
});

/* ============ 形状闸门：chunk 走 import()，且只进预缓存不进 modulepreload ============ */
test("三块 chunk 都由外观层 import() 拉取（不是首屏静态 import）", () => {
  /* 「点开才付」是这轮改动的全部意义。改成静态 import 就会被拽回首屏模块图，
     perf:budget 的体积预算会立刻超标——这里先给出更直接的指向。 */
  const facades = {
    "modules/voices-panel-lazy.js": "voices-panel.js",
    "modules/downloads-lazy.js": "downloads.js",
    "modules/settings-lazy.js": "settings.js"
  };
  for (const [facade, chunk] of Object.entries(facades)) {
    const src = readWeb(facade);
    assert.match(src, new RegExp(`import\\("\\./${chunk}"\\)`), `${facade} 应 import ${chunk}`);
    assert.match(src, /if \(!inflight\)/, `${facade} 应做并发去重`);
  }
});

test("三块 chunk 进 sw.js 预缓存但不进 index.html 的 modulepreload", () => {
  /* modulepreload 会把懒加载的收益全部抵消（首屏就并行取完）；但离线冷启动点开面板
     又必须能拿到 chunk，因此只能进 PRECACHE_URLS。 */
  const preloads = new Set(modulepreloads());
  const precache = new Set(precached());
  for (const chunk of [
    "/modules/voices-panel.js",
    "/modules/downloads.js",
    "/modules/settings.js"
  ]) {
    assert.equal(preloads.has(chunk), false, `${chunk} 不该被预载`);
    assert.equal(precache.has(chunk), true, `${chunk} 必须在预缓存里（离线冷启动）`);
  }
  // 外观层反过来：必须在首屏（按钮接线与同步路径都在那里）
  for (const facade of [
    "/modules/voices-panel-lazy.js",
    "/modules/downloads-lazy.js",
    "/modules/settings-lazy.js"
  ]) {
    assert.equal(preloads.has(facade), true, `${facade} 属于首屏模块图`);
  }
});

test("音色库不再以经典脚本形式出现在 index.html / sw.js 预缓存", () => {
  /* voices-panel.js 曾是首屏就下载的经典脚本；改成懒加载 chunk 后连 <script> 标签
     都要撤掉，否则「首屏不取它」的契约会在检查之外被悄悄破掉。 */
  assert.doesNotMatch(readWeb("index.html"), /<script src="\/voices-panel\.js">/);
  assert.equal(precached().includes("/voices-panel.js"), false, "旧的经典脚本路径不该再预缓存");
});
