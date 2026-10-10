/* Regression: RAM/VRAM meters vanished from instance cards because
   renderInstanceList passed the whole instance to memBlockHtml, which reads
   the memory object. withSparkSeries must return that object. The deployed
   hub does not send ramSeries/vramSeries; the client sparkStore appends one
   point per changed memory.sampledAt and keeps at most 60. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule, readWeb } from "./helpers/vm.mjs";

const MIB = 1024 * 1024;

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DICT = {
  "instance.idleFor": "idle {t}",
  "instance.idleForTip": "Idle since the last task finished",
  "instance.status.READY": "Ready",
  "instance.generating": "Generating…",
  "instance.ready": "Ready",
  "instance.noReady": "No ready instance",
  "instance.vramHead": "VRAM {text}",
  "instance.vramHeadTip": "VRAM in use across instances",
  "instance.memStatIdle": "Idle",
  "instance.memStatPeak": "Peak",
  "instance.memStatAvg": "Avg",
  "instance.memLegendTitle": "Memory markers:",
  "instance.memKeyRam": "RAM",
  "instance.memKeyVram": "VRAM",
  "instance.memNow": "now"
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
  add('<div id="mem-markers" class="mem-markers hidden"></div>');
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
    I18N: {
      pick: (o, k) => (o && o[k]) || "",
      num: (n) => String(n),
      date: (v) => String(v)
    },
    Api: {
      poll: () => () => {},
      list: () => Promise.resolve([]),
      del: () => Promise.resolve()
    },
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
    setActiveInstanceId(id) {
      sandbox.activeInstanceId = id;
    },
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
  // models / selectedModelId / busyStarts are free bindings, not exports.
  mod.__sandbox = sandbox;
  return mod;
}

function inst(memory) {
  return {
    id: "i1",
    instanceName: "voice",
    modelId: "supertonic",
    status: "READY",
    backend: "cpu",
    device: 0,
    port: 7001,
    createdAt: "2026-01-01T00:00:00.000Z",
    weightsPath: "/weights",
    executableName: "audio",
    threads: 4,
    memory
  };
}

function memory(i, sampledAt, over) {
  return Object.assign(
    {
      sampledAt,
      ramBytes: (942 + i) * MIB,
      ramPeakBytes: 988 * MIB,
      ramAvgBytes: 700 * MIB,
      vramBytes: (400 + i) * MIB,
      vramPeakBytes: (400 + i) * MIB,
      vramAvgBytes: (400 + i) * MIB,
      samples: i + 1,
      busy: false,
      vramSource: "none"
    },
    over
  );
}

function sparkPointsOf(root, kind) {
  const svg = root.querySelector("svg.spark." + kind);
  const poly = svg && svg.querySelector("polyline");
  return poly ? poly.getAttribute("points") : null;
}

test("instance card renders memory meters and client sparklines", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  let current;
  const poll = (mem) => {
    current = inst(mem);
    mod.applyInstances([current]);
    return list.querySelector(".card");
  };

  const card0 = poll(memory(0, 1000));
  assert.ok(card0, "poll renders a card");
  assert.equal(card0.querySelectorAll('[role="meter"]').length, 2);
  assert.equal(card0.querySelector("[data-w]").getAttribute("data-w"), "76.3");
  assert.equal(card0.querySelector("[data-l]").getAttribute("data-l"), "80");
  assert.match(card0.innerHTML, /data-l="56\.7"/);
  assert.equal(card0.querySelector("[data-w]").style.width, "76.3%");
  assert.equal(sparkPointsOf(card0, "ram"), null, "one sample is not a line");
  assert.doesNotMatch(card0.innerHTML, /style=/);

  // Same sampledAt (SSE-triggered redraw, or a repeated payload) must not push.
  const cardSame = poll(memory(0, 1000, { ramBytes: 100 * MIB, vramBytes: MIB }));
  assert.match(cardSame.innerHTML, />100 MiB</);
  assert.equal(cardSame.querySelectorAll('[role="meter"]').length, 2);
  assert.equal(sparkPointsOf(cardSame, "ram"), null, "sampledAt did not change");

  const card2 = poll(memory(1, 2000));
  const ram2 = mod.sparkPoints([942 * MIB, 943 * MIB]);
  const vram2 = mod.sparkPoints([400 * MIB, 401 * MIB]);
  const spark = card2.querySelector("svg.spark");
  assert.ok(spark && spark.querySelector("polyline"), "svg.spark polyline");
  assert.equal(sparkPointsOf(card2, "ram"), ram2);
  assert.equal(sparkPointsOf(card2, "vram"), vram2);
  assert.equal(ram2.split(/\s+/).length, 2);
  assert.doesNotMatch(card2.innerHTML, /style=/);

  mod.renderInstanceDetail(current);
  const detail = world.$("instance-detail-body");
  assert.equal(detail.querySelectorAll('[role="meter"]').length, 2);
  assert.equal(sparkPointsOf(detail, "ram"), ram2);

  const cardDup = poll(memory(1, 2000, { ramBytes: 5 * MIB, vramBytes: 5 * MIB }));
  assert.equal(sparkPointsOf(cardDup, "ram"), ram2, "repeat sampledAt does not grow the line");

  let card = cardDup;
  for (let i = 2; i <= 69; i++) card = poll(memory(i, 1000 * (i + 1)));
  const ram = [];
  const vram = [];
  for (let i = 10; i <= 69; i++) {
    ram.push((942 + i) * MIB);
    vram.push((400 + i) * MIB);
  }
  assert.equal(sparkPointsOf(card, "ram").split(/\s+/).length, 60);
  assert.equal(sparkPointsOf(card, "ram"), mod.sparkPoints(ram));
  assert.equal(sparkPointsOf(card, "vram"), mod.sparkPoints(vram));

  const frozen = sparkPointsOf(card, "ram");
  const cardLast = poll(memory(69, 1000 * 70, { ramBytes: 2 * MIB, vramBytes: 2 * MIB }));
  assert.equal(sparkPointsOf(cardLast, "ram"), frozen);
  assert.equal(cardLast.querySelectorAll('[role="meter"]').length, 2);
  assert.doesNotMatch(cardLast.innerHTML, /style=/);

  mod.renderInstanceDetail(current);
  assert.equal(sparkPointsOf(world.$("instance-detail-body"), "ram"), frozen);
  assert.equal(world.$("instance-detail-body").querySelectorAll('[role="meter"]').length, 2);
});

test("instance card shows idle marker, VRAM total, GPU subtitle, and one badge", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const box = mod.__sandbox;
  box.models.push({ id: "breeze", displayName: "BreezeTTS 2" });
  box.selectedModelId = "breeze";
  const GiB = 1024 * MIB;
  const since = Date.now() - 4 * 60 * 1000;
  const row = inst({
    sampledAt: 3000,
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    ramIdleBytes: 598 * MIB,
    vramBytes: 3.6 * GiB,
    vramPeakBytes: 4 * GiB,
    vramAvgBytes: 3 * GiB,
    vramIdleBytes: 3.6 * GiB,
    vramTotalBytes: 8 * GiB,
    gpuName: "GTX 1080",
    idleSinceMs: since,
    samples: 4,
    busy: false,
    vramSource: "nvidia-smi"
  });
  row.modelId = "breeze";
  row.instanceName = "voice";
  row.backend = "vulkan";
  row.device = 0;
  row.port = 18090;
  mod.applyInstances([row]);
  const shown = list.querySelector(".card");
  assert.ok(shown);
  assert.match(shown.innerHTML, /Idle 598/);
  assert.match(shown.innerHTML, /\/ 8\.0 GiB/);
  assert.match(shown.innerHTML, /BreezeTTS 2 · GTX 1080 · vulkan:0 · :18090/);
  assert.match(shown.innerHTML, /idle 4m/);
  assert.equal(shown.querySelectorAll(".badge.ready").length, 1);
  assert.equal(shown.querySelectorAll(".badge.generating").length, 0);
  assert.doesNotMatch(shown.innerHTML, /style=/);
  const pill = world.$("instance-pill");
  assert.equal(pill.classList.contains("hidden"), false);
  assert.match(world.$("instance-vram").textContent, /VRAM 3\.6 \/ 8\.0 GiB/);

  box.busyStarts.set(row.id, Date.now() - 3200);
  mod.applyInstances([row]);
  const busy = list.querySelector(".card");
  assert.equal(busy.querySelectorAll(".badge.generating").length, 1);
  assert.equal(busy.querySelectorAll(".badge.ready").length, 0);
  assert.equal(busy.querySelectorAll(".idle-for").length, 0);
  assert.equal(pill.classList.contains("hidden"), true);
  assert.equal(world.$("instance-generating").classList.contains("hidden"), false);
  assert.doesNotMatch(busy.innerHTML, /style=/);
});

/* 内存条上的空闲记号（空心圆）+ 列表上方那行图例。位置全部走 data-l，
   由 applyMemBars 用 CSSOM 写成 left——markup 里不出现 style=""。 */
test("memory bars: idle hollow circle, clamped, and omitted when unknown", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const GiB = 1024 * MIB;
  const mem = {
    sampledAt: 10,
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    ramIdleBytes: 598 * MIB,
    vramBytes: 3.6 * GiB,
    vramPeakBytes: 4 * GiB,
    vramAvgBytes: 3 * GiB,
    vramIdleBytes: 3.6 * GiB,
    vramTotalBytes: 8 * GiB
  };
  mod.applyInstances([inst(mem)]);
  const card = list.querySelector(".card");
  assert.ok(card);

  // 位置与 memRowModel 算出来的同一把尺（RAM 无总量 → 比例尺 max(peak,cur)*1.25）
  const ramRow = mod.memRowModel("ram", mem);
  const vramRow = mod.memRowModel("vram", mem);
  assert.ok(ramRow.idlePct > 0 && ramRow.idlePct < 100);
  assert.equal(ramRow.idlePct, 48.4);
  assert.equal(vramRow.idlePct, 45);
  const idles = card.querySelectorAll(".idle");
  assert.equal(idles.length, 2, "两行各一个空心圆");
  assert.equal(idles[0].getAttribute("data-l"), String(ramRow.idlePct));
  assert.equal(idles[1].getAttribute("data-l"), String(vramRow.idlePct));
  assert.equal(idles[0].style.left, ramRow.idlePct + "%", "applyMemBars 用 CSSOM 写 left");
  assert.equal(idles[0].getAttribute("aria-hidden"), "true");
  // 空闲圆排在均值刻度之后，同一条 data-l 通路
  assert.ok(card.innerHTML.indexOf('class="idle"') > card.innerHTML.indexOf('class="avg"'));
  assert.doesNotMatch(card.innerHTML, /style=/);

  // 每卡图例拿到 Idle 那一项（与统计行同一组词）
  assert.match(card.innerHTML, /<i class="id"><\/i>Idle<\/span>/);
  assert.match(card.innerHTML, /<i class="pk"><\/i>Peak<\/span>/);
  assert.match(card.innerHTML, /<i class="avg"><\/i>Avg<\/span>/);

  // 空闲值超过分母：钳到比例尺末端（100），不画到条外
  mod.applyInstances([
    inst({ sampledAt: 11, ramBytes: 10 * MIB, ramPeakBytes: 20 * MIB, ramIdleBytes: 100 * GiB })
  ]);
  const clamped = list.querySelector(".card");
  const clampedIdle = clamped.querySelectorAll(".idle");
  assert.equal(clampedIdle.length, 1);
  assert.equal(clampedIdle[0].getAttribute("data-l"), "100");

  // 一个空闲样本都没有（旧 hub / 还没闲过）：整项省略，图例里也不承诺它
  mod.applyInstances([inst({ sampledAt: 12, ramBytes: 942 * MIB, vramBytes: 2 * MIB })]);
  const plain = list.querySelector(".card");
  assert.equal(plain.querySelectorAll(".idle").length, 0);
  assert.doesNotMatch(plain.innerHTML, /<i class="id">/);
  assert.match(plain.innerHTML, /<i class="pk"><\/i>Peak<\/span>/);

  // 详情弹窗共用同一渲染路径
  const detail = inst(mem);
  mod.applyInstances([detail]);
  mod.renderInstanceDetail(detail);
  const detailIdles = world.$("instance-detail-body").querySelectorAll(".idle");
  assert.equal(detailIdles.length, 2);
  assert.equal(detailIdles[0].style.left, ramRow.idlePct + "%");
});

/* 列表上方那一行图例：真的画出内存条才出现，没有 memory 读数时整行藏起来 */
test("memory marker legend above the instance list follows the rendered bars", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const markers = world.$("mem-markers");
  assert.equal(markers.classList.contains("hidden"), true, "初始隐藏");

  mod.applyInstances([inst({ sampledAt: 1, ramBytes: 942 * MIB, vramBytes: 2 * MIB })]);
  assert.equal(markers.classList.contains("hidden"), false);
  assert.match(markers.innerHTML, /Memory markers:/);
  assert.match(markers.innerHTML, /<i class="pk"><\/i>Peak/);
  assert.match(markers.innerHTML, /<i class="avg"><\/i>Avg/);
  assert.match(markers.innerHTML, /<i class="id"><\/i>Idle/);
  assert.doesNotMatch(markers.innerHTML, /style=/);

  // 实例没有 memory（旧 hub / 尚未采样）：不画内存条，也就不放图例
  mod.applyInstances([inst()]);
  assert.equal(list.querySelectorAll(".mem").length, 0);
  assert.equal(markers.classList.contains("hidden"), true);
});

/* 就绪卡片右端的空闲小胶囊：时钟图标 + 弱化配色，生成中整块让位给耗时 */
test("ready card shows the idle pill with a clock icon, hidden while generating", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const row = inst({
    sampledAt: 5,
    ramBytes: 300 * MIB,
    vramBytes: 2 * MIB,
    idleSinceMs: Date.now() - 6 * 60 * 60 * 1000
  });
  mod.applyInstances([row]);
  const card = list.querySelector(".card");
  const pill = card.querySelector(".idle-for");
  assert.ok(pill, "idle pill is rendered");
  assert.equal(pill.getAttribute("title"), "Idle since the last task finished");
  assert.match(card.innerHTML, /idle 6h/);
  const icon = pill.querySelector("svg");
  assert.ok(icon, "clock icon");
  assert.equal(icon.getAttribute("class"), "icon");
  const use = icon.querySelector("use");
  assert.ok(use);
  assert.equal(use.getAttribute("href"), "#i-clock");
  assert.equal(icon.getAttribute("stroke"), "currentColor");
  // 胶囊在卡片标题行右端，且不在生成中卡片上出现
  assert.equal(card.querySelectorAll(".card-elapsed").length, 0);
  assert.doesNotMatch(card.innerHTML, /style=/);

  mod.__sandbox.busyStarts.set(row.id, Date.now() - 3200);
  mod.applyInstances([row]);
  const busy = list.querySelector(".card");
  assert.equal(busy.querySelectorAll(".idle-for").length, 0);
  assert.equal(busy.querySelectorAll(".card-elapsed").length, 1);

  // 雪碧图里有时钟符号，形状与其它 Lucide 路径同风格
  const symbol = /<symbol id="i-clock"[\s\S]*?<\/symbol>/.exec(readWeb("index.html"));
  assert.ok(symbol, "i-clock symbol exists in the sprite");
  assert.match(symbol[0], /viewBox="0 0 24 24"/);
  assert.match(symbol[0], /<circle /);
  assert.doesNotMatch(symbol[0], /\son[a-z]+=/i);
});

/* 形状契约：空心圆 / 2px 最小填充 / 小胶囊都由 CSS 令牌实现，
   两套主题都定义了这些令牌（CSP style-src 'self' 不允许 inline style）。 */
test("idle marker, fill sliver and idle pill styles exist in both themes", () => {
  const css = readWeb("style.css");
  assert.match(css, /\.bar \.idle\s*\{[^}]*border-radius:\s*50%/);
  assert.match(css, /\.bar \.idle\s*\{[^}]*border:[^;]*var\(--text-dim\)/);
  assert.match(css, /\.bar \.fill\[data-w\]:not\(\[data-w="0"\]\)\s*\{[^}]*min-width:\s*2px/);
  assert.match(css, /\.mem-legend i\.id\s*\{[^}]*border-radius:\s*50%/);
  assert.match(css, /\.idle-for\s*\{[^}]*border-radius:\s*999px/);
  assert.match(css, /\.idle-for\s*\{[^}]*color:\s*var\(--text-dim\)/);
  assert.match(css, /\.idle-for \.icon\s*\{[^}]*width:\s*12px/);
  assert.match(css, /\.mem-markers\s*\{[^}]*display:\s*flex/);

  // 减少动态效果：模型区 summary 上的箭头不旋转
  const mq = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/g;
  let saw = null;
  for (let mm; (mm = mq.exec(css));) if (mm[1].includes(".model-panel")) saw = mm[1];
  assert.ok(saw, "a reduced-motion block mentions the model panel");
  assert.match(saw, /\.model-panel > summary \.chev[^{]*\{[^}]*transition:\s*none/);
});
