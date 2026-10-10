/* 左栏模型区折叠：默认态（有实例就收起）+ localStorage 记忆 + 真实渲染路径
   （loadModels → renderModelList，详情 / HF 菜单 / 计数徽标一概不少）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule, readWeb } from "./helpers/vm.mjs";

const MODELS = [
  {
    id: "supertonic",
    category: "tts",
    family: "supertonic",
    displayName: "Supertonic",
    description: "fast tts",
    hfUrl: "https://huggingface.co/x/supertonic"
  },
  {
    id: "citrinet_asr",
    category: "asr",
    family: "citrinet",
    displayName: "Citrinet ASR",
    description: "stt",
    hfUrl: "https://huggingface.co/x/citrinet"
  }
];

const DICT = {
  "category.tts": "TTS",
  "category.asr": "ASR",
  "model.unconfigured": "unconfigured",
  "model.unconfiguredTip": "not configured",
  "model.empty": "no models",
  "common.retry": "retry",
  "dl.cardBtn": "download weights",
  "model.hfRepo": "hugging face repo"
};

function t(key, params) {
  let s = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
  for (const [k, v] of Object.entries(params || {})) {
    s = s.split("{" + k + "}").join(String(v));
  }
  return s;
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mount(world) {
  const panel = world.el('<details id="model-panel" class="model-panel" open=""></details>');
  const summary = world.el('<summary><span class="model-panel-title">Models</span></summary>');
  const list = world.el('<div id="model-list" class="card-list"></div>');
  panel.appendChild(summary);
  panel.appendChild(list);
  world.document.body.appendChild(panel);
  world.document.body.appendChild(world.el('<span id="model-count" class="sec-count num"></span>'));
  world.document.body.appendChild(world.el('<span id="quick-launch-model"></span>'));
  world.document.createElement = (tag) => new StubElement(world, tag);
  return { panel, summary, list };
}

function loadModule(world, opts = {}) {
  const store = new Map();
  const win = new Map();
  const sandbox = {
    document: world.document,
    window: {
      addEventListener(type, cb) {
        if (!win.has(type)) win.set(type, []);
        win.get(type).push(cb);
      },
      prompt: () => "",
      confirm: () => true,
      innerHeight: 900,
      innerWidth: 1200
    },
    $: world.$,
    t,
    esc,
    Api: {
      list: () => Promise.resolve(MODELS),
      get: () => Promise.resolve([]),
      ...(opts.Api || {})
    },
    I18N: { pick: (o, k) => (o && o[k]) || "", num: (n) => String(n) },
    localStorage: opts.throwOnWrite
      ? {
          getItem: () => null,
          setItem() {
            throw new Error("denied");
          },
          removeItem() {
            throw new Error("denied");
          }
        }
      : {
          getItem: (k) => (store.has(k) ? store.get(k) : null),
          setItem: (k, v) => store.set(k, String(v)),
          removeItem: (k) => store.delete(k)
        },
    location: { hash: "" },
    history: { replaceState() {} },
    // state.js 的活绑定：直接动 sandbox 上的值即改模块看到的清单
    models: [],
    selectedModelId: null,
    selectedModel: () => sandbox.models.find((m) => m.id === sandbox.selectedModelId) || null,
    setModels(next) {
      sandbox.models = next;
    },
    setSelectedModelId(id) {
      sandbox.selectedModelId = id;
    },
    modelConfigured: () => true,
    instances: [],
    // 其余 import 边：桩掉，避免把整张模块图拖进这个用例
    bindMenuKeys() {},
    renderEmptyState() {},
    renderStateError() {},
    showSkeleton() {},
    safeHttpUrl: (u) => u,
    openModelDlModal() {},
    maybeAutoSelectReadyModel() {},
    refreshInstances() {},
    restoreWeightsPath() {},
    renderWorkspace() {},
    getPendingModelId: () => null,
    setPendingModelId() {},
    go() {},
    modelRoute: (id) => "#/model/" + id,
    parseRoute: () => ({ view: "home", id: null }),
    closeDrawer() {}
  };
  const mod = loadEsModule("modules/models.js", sandbox);
  mod.__sandbox = sandbox;
  mod.__store = store;
  mod.__win = win;
  return mod;
}

const fireInstances = (mod, count) => {
  mod.__sandbox.instances = Array.from({ length: count }, (_, i) => ({ id: "i" + i }));
  for (const cb of mod.__win.get("hub-instances-updated") || []) cb();
};

test("defaultModelsOpen：有实例就收起，没有就展开", () => {
  const world = createDomWorld();
  mount(world);
  const mod = loadModule(world);
  assert.equal(mod.defaultModelsOpen(0), true);
  assert.equal(mod.defaultModelsOpen(1), false);
  assert.equal(mod.defaultModelsOpen(14), false);
  assert.equal(mod.defaultModelsOpen("2"), false);
  assert.equal(mod.defaultModelsOpen(undefined), true);
  assert.equal(mod.defaultModelsOpen(-1), true);
});

test("模型区：默认态、localStorage 记忆、实例到达后改默认", async () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = loadModule(world);

  // 还没有实例：展开（这时模型清单正是要找东西的地方）
  mod.startModelsPanel();
  assert.equal(ui.panel.open, true);
  await mod.loadModels();
  assert.equal(ui.panel.open, true);

  // 模型清单照常渲染：分类标题、卡片、下载 / HF 入口一个不少
  const cards = ui.list.querySelectorAll(".card");
  assert.equal(cards.length, 2);
  assert.deepEqual(
    ui.list.querySelectorAll(".group-title").map((n) => n.textContent),
    ["TTS", "ASR"]
  );
  assert.equal(ui.list.querySelectorAll(".dl-link").length, 2);
  assert.equal(ui.list.querySelectorAll(".hf-link").length, 2);
  assert.ok(
    cards.every((c) => !/style=/.test(c.innerHTML)),
    "no inline style attrs"
  );
  // summary 上的计数徽标跟着清单走（折叠时也看得出有几个模型）
  assert.equal(world.$("model-count").textContent, "2");

  // 实例列表就绪（窗口事件）：没有用户记录时改成「收起」
  fireInstances(mod, 1);
  assert.equal(ui.panel.open, false);
  // 重复广播是幂等的
  fireInstances(mod, 2);
  assert.equal(ui.panel.open, false);

  // 用户手动展开：记进 localStorage，之后的实例广播不再改它
  ui.panel.open = true;
  world.fire(ui.panel, "toggle");
  assert.equal(mod.__store.get("hub-models-open"), "1");
  fireInstances(mod, 3);
  assert.equal(ui.panel.open, true);

  // 重新加载模块（模拟刷新页面）：记录还在，直接按记录的展开
  const again = loadModule(world);
  again.startModelsPanel();
  assert.equal(ui.panel.open, true);

  // 记住的是「收起」时同样管用，且不依赖当前有没有实例
  mod.__store.set("hub-models-open", "0");
  mod.startModelsPanel();
  assert.equal(ui.panel.open, false);
  fireInstances(mod, 0);
  assert.equal(ui.panel.open, false);
});

test("模型区：localStorage 写入被拒（private mode）时不崩，仍按默认态渲染", async () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = loadModule(world, { throwOnWrite: true });
  mod.startModelsPanel();
  await mod.loadModels();
  assert.equal(ui.panel.open, true, "读不出记录时按默认态（无实例 → 展开）");
  assert.equal(ui.list.querySelectorAll(".card").length, 2);
  assert.doesNotThrow(() => world.fire(ui.panel, "toggle"));
  // 没有落下记录，实例到达后仍然按默认值收起
  fireInstances(mod, 1);
  assert.equal(ui.panel.open, false);
});

test("模型区折叠的 DOM / CSS 契约：summary 计数与箭头、活动面板在上、图标齐全", () => {
  const html = readWeb("index.html");
  const block = /<details id="model-panel"[\s\S]*?<\/details>/.exec(html);
  assert.ok(block, "model-panel details exists");
  assert.match(block[0], /<summary>/);
  assert.match(block[0], /class="model-panel-title" data-i18n="nav\.models"/);
  assert.match(block[0], /id="model-count" class="sec-count num"/);
  assert.match(block[0], /<use href="#i-chevron-down"\/>/);
  // 最近活动面板排在模型区之前（长列表不再把活动挤出屏幕）
  assert.ok(html.indexOf('id="activity-panel"') < html.indexOf('id="model-panel"'));
  assert.match(html, /<symbol id="i-clock" viewBox="0 0 24 24">/);
  assert.match(html, /<symbol id="i-chevron-down" viewBox="0 0 24 24">/);

  const css = readWeb("style.css");
  assert.match(
    css,
    /\.model-panel\[open\] > summary \.chev\s*\{[^}]*transform:\s*rotate\(180deg\)/
  );
  assert.match(css, /\.model-panel > summary \.chev\s*\{[^}]*transition:\s*transform/);
});
