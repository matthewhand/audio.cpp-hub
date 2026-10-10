/* 实例卡片的「生成中」外观：胶囊脉冲环、标题行右端的活动图标 + 耗时，
   以及卡片顺序只在 (status, createdAt, name, id) 上稳定（选中 / 忙碌都不参与）。
   渲染走真实 renderInstanceList 路径（applyInstances → renderInstanceList）。
   注意 helpers/dom-stub.mjs 的选择器不支持 `>` 组合符，测试里只用单一类 / 标签。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule, readWeb } from "./helpers/vm.mjs";

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const DICT = {
  "instance.status.READY": "Ready",
  "instance.status.STARTING": "Starting",
  "instance.status.ERROR": "Error",
  "instance.generating": "Generating…",
  "instance.generatingTip": "Generating: time since this run started",
  "instance.idleFor": "idle {t}",
  "instance.idleForTip": "Idle since the last task finished",
  "instance.ready": "Ready",
  "instance.noReady": "No ready instance",
  "instance.detail": "Details",
  "instance.stop": "Stop",
  "instance.vramHead": "VRAM {text}",
  "instance.vramHeadTip": "VRAM in use across instances"
};

function t(key, params) {
  let s = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
  for (const [k, v] of Object.entries(params || {})) {
    s = s.split("{" + k + "}").join(String(v));
  }
  return s;
}

function mount(world) {
  const { el } = world;
  const body = world.document.body;
  const add = (html) => {
    const node = el(html);
    body.appendChild(node);
    return node;
  };
  const list = add('<div id="instance-list" class="card-list"></div>');
  add('<select id="instance-select"></select>');
  add('<button id="instance-stop"></button>');
  add('<button id="instance-detail"></button>');
  add('<span id="instance-pill" class="pill warn"></span>');
  add('<span id="instance-count"></span>');
  add('<span id="instance-vram" class="sec-vram num"></span>');
  add('<span id="instance-generating" class="badge generating hidden"></span>');
  const modal = add('<div id="instance-detail-modal" class="modal-overlay hidden"></div>');
  modal.appendChild(el('<button id="instance-detail-close"></button>'));
  modal.appendChild(el('<div id="instance-detail-body"></div>'));
  world.document.createElement = (tag) => new StubElement(world, tag);
  return list;
}

function load(world) {
  const elapsed = loadEsModule("modules/elapsed.js", { Date });
  const sandbox = {
    document: world.document,
    window: { dispatchEvent() {}, addEventListener() {} },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    $: world.$,
    esc,
    t,
    I18N: { pick: (o, k) => (o && o[k]) || "", num: (n) => String(n), date: (v) => String(v) },
    Api: { poll: () => () => {}, list: () => Promise.resolve([]), del: () => Promise.resolve() },
    focusDialog() {},
    renderEmptyState() {},
    renderListError() {},
    restoreDialogFocus() {},
    showSkeleton() {},
    openLaunchModal() {},
    selectModelById() {},
    getPendingInstanceId: () => null,
    setPendingInstanceId() {},
    go() {},
    modelRoute: (id) => "#/model/" + id,
    parseRoute: () => ({ view: "home", id: null }),
    activeInstanceId: null,
    setActiveInstanceId(id) { sandbox.activeInstanceId = id; },
    busyStarts: new Map(),
    runningStarts: new Map(),
    rememberStart: elapsed.rememberStart,
    taskStartMs: elapsed.taskStartMs,
    rawStartMs: elapsed.rawStartMs,
    hasActiveStarts: elapsed.hasActiveStarts,
    ELAPSED_TICK_MS: elapsed.ELAPSED_TICK_MS,
    idleFallbacks: new Map(),
    models: [],
    selectedModelId: null,
    location: { hash: "" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0,
    clearInterval() {},
    Date
  };
  const mod = loadEsModule("modules/instances.js", sandbox);
  mod.__sandbox = sandbox;
  return mod;
}

function inst(over) {
  return Object.assign({
    id: "i1",
    instanceName: "voice",
    modelId: "breeze",
    status: "READY",
    backend: "vulkan",
    device: 0,
    port: 18090,
    createdAt: "2026-10-10T00:00:00.000Z",
    weightsPath: "/w",
    executableName: "audio",
    memory: { sampledAt: 1, ramBytes: 1024, vramBytes: 2048, samples: 1 }
  }, over);
}

function markBusy(box, id, agoMs) {
  box.busyStarts.set(id, Date.now() - agoMs);
}

/* innerHTML 解析出来的节点没有 textContent（dom-stub 不建文本节点），
   卡片名字从 markup 里取——测试只读它。 */
function cardName(card) {
  const m = /card-name">([^<]*)</.exec(card ? card.innerHTML : "");
  return m ? m[1] : "";
}

function cardNames(list) {
  return list.children.map(cardName);
}

test("generating card: pulse ring, accent class, elapsed at the card header's right", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const box = mod.__sandbox;
  // 工具栏胶囊只对这一台（选中模型下的 READY 实例）显示，先让选中模型对上
  box.selectedModelId = "breeze";
  const row = inst({ id: "ab12", instanceName: "voice" });
  markBusy(box, row.id, 3200);
  mod.applyInstances([row]);
  const card = list.querySelector(".card");
  assert.ok(card);

  // 生成中的卡片有强调色 class（与 .selected 分开，CSS 里各自上色）
  assert.equal(card.classList.contains("generating"), true);
  assert.equal(card.classList.contains("selected"), false);

  // 胶囊：脉冲环 + 文案，胶囊里不再放计时
  const badge = card.querySelector(".badge.generating");
  assert.ok(badge, "generating pill is rendered");
  assert.equal(badge.querySelectorAll(".badge-elapsed").length, 0, "pill keeps no elapsed text");
  const pulse = badge.querySelector(".pulse");
  assert.ok(pulse, "pulse node");
  assert.equal(pulse.children.length, 3, "one dot plus two rings");
  assert.equal(pulse.children[0].hasAttribute("class"), false, "the dot carries no class");
  assert.equal(pulse.children[1].getAttribute("class"), "r1");
  assert.equal(pulse.children[2].getAttribute("class"), "r2");
  assert.match(card.innerHTML, />Generating…</);
  // 胶囊自身（到右端片段之前）不含计时片段，避免同一处出现两个跳动数字
  const pillFrom = card.innerHTML.indexOf('<span class="badge generating">');
  const rightFrom = card.innerHTML.indexOf('<span class="card-elapsed"');
  assert.ok(pillFrom >= 0 && rightFrom > pillFrom, "pill comes before the right-hand clock");
  assert.doesNotMatch(card.innerHTML.slice(pillFrom, rightFrom), /badge-elapsed/);

  // 标题行右端：活动图标 + 与徽标同一张表的计时（同一个 data-elapsed-id）
  const right = card.querySelector(".card-elapsed");
  assert.ok(right, "elapsed moves to the card header's right");
  assert.equal(right.getAttribute("title"), "Generating: time since this run started");
  const live = right.querySelector("[data-elapsed-id]");
  assert.ok(live, "elapsed node carries the shared painter's key");
  assert.equal(live.getAttribute("data-elapsed-id"), row.id);
  const startAttr = live.getAttribute("data-start");
  assert.ok(Number(startAttr) > 0, "data-start is the stored anchor");
  assert.equal(live.getAttribute("class"), "badge-elapsed num");
  // 数字在第一帧就写好（dom-stub 不给嵌套节点建文本节点，读 markup）
  assert.match(card.innerHTML, new RegExp('data-elapsed-id="' + row.id + '"[^>]*>3\\.2s<'));
  // 图标走雪碧图，stroke 由 currentColor 给（CSP style-src 'self' 不许 inline style）
  const icon = right.querySelector("svg");
  assert.ok(icon, "activity icon");
  assert.equal(icon.getAttribute("class"), "icon");
  assert.equal(icon.getAttribute("stroke"), "currentColor");
  const use = icon.querySelector("use");
  assert.ok(use);
  assert.equal(use.getAttribute("href"), "#i-activity");
  assert.equal(right.getAttribute("style"), null);

  // 生成中不再有 Ready 徽标，也没有 idle 标签
  assert.equal(card.querySelectorAll(".badge.ready").length, 0);
  assert.equal(card.querySelectorAll(".idle-for").length, 0);
  assert.doesNotMatch(card.innerHTML, /style=/);
  // 右端片段排在徽标之后
  assert.ok(card.innerHTML.indexOf("card-elapsed") > card.innerHTML.indexOf("badge generating"));

  // 工具栏胶囊：同一形状 + 计时（那一侧没有标题行可放）
  const gen = world.$("instance-generating");
  assert.equal(gen.classList.contains("hidden"), false);
  assert.equal(gen.querySelector(".pulse").children.length, 3);
  const barLive = gen.querySelector("[data-elapsed-id]");
  assert.ok(barLive);
  assert.equal(barLive.getAttribute("data-elapsed-id"), row.id);
  assert.match(gen.innerHTML, new RegExp('data-elapsed-id="' + row.id + '"[^>]*>3\\.2s<'));

  // 空闲后：胶囊变成 Ready，右端回到 idle 标签，卡片去掉强调 class
  box.busyStarts.clear();
  mod.applyInstances([inst({
    id: "ab12",
    instanceName: "voice",
    memory: { sampledAt: 2, ramBytes: 1024, idleSinceMs: Date.now() - 4 * 60 * 1000 }
  })]);
  const idleCard = list.querySelector(".card");
  assert.equal(idleCard.classList.contains("generating"), false);
  assert.equal(idleCard.querySelectorAll(".card-elapsed").length, 0);
  assert.equal(idleCard.querySelectorAll(".badge.ready").length, 1);
  assert.match(idleCard.innerHTML, /badge ready">Ready</);
  assert.equal(idleCard.querySelectorAll(".idle-for").length, 1);
  assert.equal(gen.classList.contains("hidden"), true);
});

test("selected + generating card keeps both rings visible", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const box = mod.__sandbox;
  markBusy(box, "i1", 1200);
  mod.applyInstances([inst({ id: "i1" })]);
  box.setActiveInstanceId("i1");
  mod.applyInstances([inst({ id: "i1" })]);
  const card = list.querySelector(".card");
  // 选中与生成中同时存在：两个 class 都在，CSS 用不同颜色 / 粗细区分
  assert.equal(card.classList.contains("selected"), true);
  assert.equal(card.classList.contains("generating"), true);
  assert.doesNotMatch(card.innerHTML, /style=/);
});

test("card order never follows selection or busy across re-renders", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const box = mod.__sandbox;
  const rows = [
    inst({ id: "a", instanceName: "alpha", status: "STOPPED", createdAt: "2026-10-10T00:00:00.000Z" }),
    inst({ id: "b", instanceName: "beta", status: "READY", createdAt: "2026-10-10T00:00:05.000Z" }),
    inst({ id: "c", instanceName: "gamma", status: "READY", createdAt: "2026-10-10T00:00:01.000Z" }),
    inst({ id: "d", instanceName: "delta", status: "STARTING", createdAt: "2026-10-10T00:00:09.000Z" }),
    inst({ id: "e", instanceName: "epsilon", status: "ERROR", createdAt: "" })
  ];
  // 先落一个基准：状态 → createdAt → name → id（与 sortInstances 的单测同一把尺）
  const apply = () => mod.applyInstances(rows.map(r => ({ ...r })));
  apply();
  const base = cardNames(list);
  // ERROR 与 STOPPED 同权重，空 createdAt 排在前（与 instance-order.test.mjs 同一把尺）
  assert.deepEqual(base, ["gamma", "beta", "delta", "epsilon", "alpha"]);

  // 5 轮重画：轮换选中态 + 忙碌态 + 任务起点，顺序必须一成不变
  for (let round = 0; round < 5; round++) {
    box.setActiveInstanceId(rows[round % rows.length].id);
    for (const [i, r] of rows.entries()) {
      if ((round + i) % 3 === 0) markBusy(box, r.id, 900 + i * 250);
      else box.busyStarts.delete(r.id);
      box.runningStarts.set(r.id, (round + i) % 2 ? Date.now() - 4000 : 0);
    }
    apply();
    assert.deepEqual(cardNames(list), base, "round " + round + " re-ordered the cards");
    // 忙碌的卡片徽标真的换了（证明这一轮的状态确实在变）
    assert.equal(list.querySelectorAll(".card.generating").length > 0, true);
  }
  // 静止一轮后回到基准，顺序仍不变
  box.setActiveInstanceId(null);
  box.busyStarts.clear();
  apply();
  assert.deepEqual(cardNames(list), base);
});

test("activity icon, accent tokens and reduced-motion downgrade", () => {
  const html = readWeb("index.html");
  const symbol = /<symbol id="i-activity"[\s\S]*?<\/symbol>/.exec(html);
  assert.ok(symbol, "i-activity symbol exists in the sprite");
  assert.match(symbol[0], /viewBox="0 0 24 24"/);
  // 与雪碧图里其它 Lucide 路径数据同一风格：纯几何，无事件属性 / 外链
  assert.doesNotMatch(symbol[0], /\son[a-z]+=/i);
  assert.match(symbol[0], /<path /);

  const css = readWeb("style.css");
  assert.match(css, /\.card\.generating\s*\{[^}]*border-color:\s*var\(--accent-live\)/);
  assert.match(css, /\.card\.generating\s*\{[^}]*box-shadow:[^;]*var\(--accent-ring\)/);
  assert.match(css, /\.card\.generating\.selected\s*\{[^}]*var\(--accent-ring\)/);
  assert.match(css, /\.card-elapsed\s*\{[^}]*color:\s*var\(--accent-live\)/);
  assert.match(css, /\.card-elapsed\s*\{[^}]*margin-left:\s*auto/);
  assert.match(css, /\.badge\.generating\s*\{[^}]*background:\s*var\(--accent-soft\)/);
  assert.match(css, /\.badge\.generating\s*\{[^}]*color:\s*var\(--accent-text\)/);
  assert.match(css, /\.pulse i\.r1\s*\{[^}]*animation:\s*pulse-ring/);
  assert.match(css, /\.pulse i\.r2\s*\{[^}]*animation:\s*pulse-ring/);
  assert.match(css, /@keyframes pulse-ring/);
  // 两套主题都定义了生成中那一组令牌，且没有动到既有 --accent 的含义
  for (const theme of ["dark", "light"]) {
    const block = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(block, theme + " theme block");
    for (const token of ["--accent-live", "--accent-soft", "--accent-ring", "--accent-text"]) {
      assert.match(block[1], new RegExp(token + ":"));
    }
    assert.match(block[1], /--accent:/);
  }

  // 减少动态效果：两圈涟漪停下，条纹上的运行条也停下
  const mq = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g;
  let saw = null;
  for (let mm; (mm = mq.exec(css)); ) if (mm[1].includes(".pulse")) saw = mm[1];
  assert.ok(saw, "a reduced-motion block mentions the pulse");
  assert.match(saw, /\.pulse i\.r1[^{]*\{[^}]*animation:\s*none/);
  assert.match(saw, /\.act-rect\.running[^{]*\{[^}]*animation:\s*none/);
});
