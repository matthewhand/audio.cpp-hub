/* Regression: RAM/VRAM meters vanished from instance cards because
   renderInstanceList passed the whole instance to memBlockHtml, which reads
   the memory object. withSparkSeries must return that object. The deployed
   hub does not send ramSeries/vramSeries; the client sparkStore appends one
   point per changed memory.sampledAt and keeps at most 60. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule } from "./helpers/vm.mjs";

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
