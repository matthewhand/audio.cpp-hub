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

function t(key, params) {
  let s = key;
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
    models: [],
    selectedModelId: null,
    location: { hash: "" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0,
    clearInterval() {},
    Date
  };
  return loadEsModule("modules/instances.js", sandbox);
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
  assert.equal(card0.querySelector("[data-w]").getAttribute("data-w"), "68.1");
  assert.equal(card0.querySelector("[data-l]").getAttribute("data-l"), "71.4");
  assert.match(card0.innerHTML, /data-l="50\.6"/);
  assert.equal(card0.querySelector("[data-w]").style.width, "68.1%");
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
