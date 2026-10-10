/* 渲染路径上的实例卡片排序：5 次重画之间来回换选中实例与忙碌态，卡片顺序必须
   每次都一样——2s 轮询重画时卡片在列表里跳位（选中的一张一会儿在顶部一会儿在
   底部）是最难排查的那类视觉 bug。纯函数层面的全序由 instance-order.test.mjs
   覆盖，这里走 applyInstances 的真实渲染路径。 */
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
  "instance.create": "create",
  "instance.detail": "detail",
  "instance.empty": "empty",
  "instance.generating": "generating",
  "instance.generatingTip": "generating",
  "instance.idleFor": "idle {t}",
  "instance.idleForTip": "idle",
  "instance.memKeyRam": "RAM",
  "instance.memKeyVram": "VRAM",
  "instance.memNow": "now",
  "instance.memStatAvg": "avg",
  "instance.memStatIdle": "idle",
  "instance.memStatPeak": "peak",
  "instance.noReady": "no ready",
  "instance.port": "port",
  "instance.ready": "ready",
  "instance.stop": "stop",
  "instance.vramHead": "VRAM {text}",
  "instance.vramHeadTip": "vram"
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
    selectedModelId: "model",
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

function mem(mib, busy) {
  return { sampledAt: 1000, ramBytes: mib * MIB, samples: 1, busy: !!busy };
}

function inst(over) {
  return Object.assign(
    {
      id: "r1",
      instanceName: "r1",
      modelId: "model",
      status: "READY",
      createdAt: "2026-01-01T00:00:00.000Z",
      memory: mem(111)
    },
    over
  );
}

/* DOM 桩不建文本节点，所以用内存条上的 aria-valuenow（每台实例一个唯一读数）认卡片 */
function ramNowOf(card) {
  const meter = card.querySelector('[role="meter"]');
  return meter ? meter.getAttribute("aria-valuenow") : "";
}

const cardOrder = (list) => list.children.map(ramNowOf).join(",");
const cardShape = (list) => list.children.map((c) => c.className).join("|");

test("render path：选中 / 忙碌来回换，卡片顺序每次都一样", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const box = mod.__sandbox;
  const rows = [
    inst({ id: "r1", status: "READY", createdAt: "2026-01-01T00:00:09.000Z", memory: mem(111) }),
    inst({ id: "r2", status: "READY", createdAt: "2026-01-01T00:00:01.000Z", memory: mem(222) }),
    inst({ id: "r3", status: "STARTING", createdAt: "2026-01-01T00:00:05.000Z", memory: mem(333) }),
    inst({ id: "r4", status: "ERROR", createdAt: "", errorMessage: "boom", memory: mem(444) }),
    inst({ id: "r5", status: "STOPPED", createdAt: "2026-01-01T00:00:02.000Z", memory: mem(555) })
  ];
  // 就绪（按 createdAt）→ 启动中 → 其它（空 createdAt 排在前）；与 sortInstances 同一套全序
  const want = "222,111,333,444,555";
  const seen = [];
  const shapes = new Set();
  for (let round = 0; round < 5; round++) {
    box.activeInstanceId = rows[round % rows.length].id; // 换选中实例
    const payload = rows.map((r, n) => ({
      ...r,
      taskCount: (round + n) % 3 === 0 ? 1 : 0, // 忙碌徽标每轮换人
      memory: mem([111, 222, 333, 444, 555][n], n === round)
    }));
    mod.applyInstances(payload);
    assert.equal(list.children.length, rows.length);
    seen.push(cardOrder(list));
    shapes.add(cardShape(list));
  }
  for (const order of seen) assert.equal(order, want);
  assert.ok(shapes.size > 1, "选中态 / 忙碌态确实每轮都在换，否则这一轮什么也没测");
  // 输入顺序打乱也一样（后端 map 迭代顺序随机）
  const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]].map((r, n) => ({
    ...r,
    taskCount: n === 0 ? 2 : 0,
    memory: mem([444, 111, 555, 333, 222][n], n === 4)
  }));
  box.activeInstanceId = "r1";
  mod.applyInstances(shuffled);
  assert.equal(cardOrder(list), want);
  assert.equal(mod.__sandbox.activeInstanceId, "r1");
});

test("render path：忙碌态只换徽标，不动卡片位置", () => {
  const world = createDomWorld();
  const list = mount(world);
  const mod = load(world);
  const rows = ["a", "b", "c", "d"].map((id, n) =>
    inst({
      id,
      instanceName: id,
      createdAt: `2026-01-01T00:00:0${n}.000Z`,
      memory: mem((n + 1) * 100)
    })
  );
  const want = "100,200,300,400";
  mod.applyInstances(rows);
  assert.equal(cardOrder(list), want);
  // 每轮只把忙碌挪到另一张卡上（taskCount / 采样忙位都给），顺序必须纹丝不动
  for (let round = 0; round < 6; round++) {
    const payload = rows.map((r, n) => ({
      ...r,
      taskCount: n === round % 4 ? 1 : 0,
      memory: mem((n + 1) * 100, n === round % 4)
    }));
    mod.applyInstances(payload);
    assert.equal(cardOrder(list), want);
    assert.equal(list.querySelectorAll(".badge.generating").length, 1);
  }
});
