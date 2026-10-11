/* Now / Queue 状态条（web/modules/nowqueue.js）：
   纯函数（describeNowQueue / snippet / waitSeconds / capacityFrom / shouldHideStrip）
   + 真实 renderNowQueue 渲染路径（运行中 chip / 排队 chip / free chip / 取消键）。
   任务行喂的是 activity.js 归约后的形状（status 小写 running|queued）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { extractFunction, loadEsModule, readWeb } from "./helpers/vm.mjs";

const NOW = 1_800_000_000_000;

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DICT = {
  "nq.title": "Now / Queue",
  "nq.aria": "{n} of {cap} in flight, {q} queued",
  "nq.inflight": "In flight {n} / {cap}",
  "nq.queued": "Queued {n}",
  "nq.free": "free",
  "nq.freeTip": "Free concurrency slot",
  "nq.cancel": "Cancel task on {name}",
  "nq.tipRunning": "{name} · {id} · running",
  "nq.tipQueued": "{name} · {id} · queued at #{pos}"
};

function t(key, params) {
  let s = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
  for (const [k, v] of Object.entries(params || {})) {
    s = s.split("{" + k + "}").join(String(v));
  }
  return s;
}

/* instances.formatBusyElapsed 是真源码（计时文本全站只有 elapsed.js 那张表在写，
   但格式化函数住在这里，抽出来在 vm 里求值，避免测试里另写一份格式）。 */
const formatBusyElapsed = new Function(
  `"use strict"; ${extractFunction(readWeb("modules/instances.js"), "formatBusyElapsed")}; return formatBusyElapsed;`
)();

function running(id, over) {
  return Object.assign(
    { taskId: id, status: "running", instanceId: "i1", instanceName: "breeze", startedAt: NOW - 3200 },
    over
  );
}

function queued(id, over) {
  return Object.assign(
    { taskId: id, status: "queued", instanceId: "i1", instanceName: "breeze", createdAt: NOW - 4000 },
    over
  );
}

const READY = [{ id: "i1", instanceName: "breeze", status: "READY" }];

function pure(rows, farm, list) {
  return loadEsModule("modules/nowqueue.js", {
    $: () => null,
    Api: { poll: () => ({ stop() {} }) },
    esc,
    t,
    formatBusyElapsed,
    instances: list || READY,
    rememberStart() {},
    syncBusyTimer() {},
    cancelTask: () => Promise.resolve(),
    isTaskStreamLive: () => true,
    activeActivityRows: () => rows || [],
    pullActivityTasks() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    Date,
    document: { querySelectorAll: () => [] },
    window: { addEventListener() {} }
  });
}

/* ---- 渲染路径：真实的 #now-queue 外壳 + 模块的 renderNowQueue ---- */

function mount(world) {
  const { el } = world;
  const body = world.document.body;
  const add = (html) => {
    const node = el(html);
    body.appendChild(node);
    return node;
  };
  // 与 web/index.html 的静态外壳同形：标题图标 + 文案（走 data-i18n），右侧 .nq-body 由模块填
  const root = add('<div id="now-queue" class="nq hidden"></div>');
  root.appendChild(el('<span class="nq-body"></span>'));
  world.document.createElement = (tag) => new StubElement(world, tag);
  return root;
}

function mountLoad(world, opts) {
  const o = opts || {};
  const mod = loadEsModule("modules/nowqueue.js", {
    $: world.$,
    esc,
    t,
    formatBusyElapsed,
    instances: o.instances || READY,
    rememberStart: o.rememberStart || (() => {}),
    syncBusyTimer: o.syncBusyTimer || (() => {}),
    cancelTask: o.cancelTask || (() => Promise.resolve()),
    isTaskStreamLive: () => true,
    farmSummary: () => o.farm || null,
    activeActivityRows: () => o.rows || [],
    pullActivityTasks() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => o.intervalFn || 0,
    clearInterval: () => {},
    Date,
    document: world.document,
    window: { addEventListener() {} }
  });
  return mod;
}

/* 模块只重建 .nq-body 里的 chip（标题与图标是 index.html 的静态外壳），
   所以断言都从 body 节点取。dom-stub 的 innerHTML getter 只返回该节点上被直接
   赋过的 HTML，正好就是这一段。 */
/* 模块的取消链是 Promise.resolve(...).catch().then()，两次微任务跳转之后才重画。
   固定次数的 await 会和队列赛跑，用 setImmediate 把整条微任务队列排空再断言。 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function box(root) {
  return root.querySelector(".nq-body");
}

function chipsOf(root) {
  return box(root).querySelectorAll(".nq-slot");
}

function qchipsOf(root) {
  return box(root).querySelectorAll(".nq-qchip");
}

test("capacityFrom reads the farm cap and falls back to 2", () => {
  const mod = pure([]);
  assert.equal(mod.capacityFrom({ inFlightCap: 4 }), 4);
  assert.equal(mod.capacityFrom({ inFlightCap: 1 }), 1);
  assert.equal(mod.capacityFrom({}), mod.DEFAULT_CAP, "absent -> default");
  assert.equal(mod.capacityFrom(null), mod.DEFAULT_CAP);
  assert.equal(mod.capacityFrom({ inFlightCap: "3" }), 3, "numeric string is accepted");
  assert.equal(mod.capacityFrom({ inFlightCap: 0 }), mod.DEFAULT_CAP, "0 means no capacity, not 0 slots");
  assert.equal(mod.capacityFrom({ inFlightCap: -1 }), mod.DEFAULT_CAP);
  assert.equal(mod.capacityFrom({ inFlightCap: "many" }), mod.DEFAULT_CAP);
  assert.equal(mod.capacityFrom({ inFlightCap: NaN }), mod.DEFAULT_CAP);
});

test("snippet collapses whitespace and truncates with an ellipsis", () => {
  const mod = pure([]);
  assert.equal(mod.snippet("Welcome back to the studio"), "Welcome back t…", "14 chars then an ellipsis");
  assert.equal(mod.snippet("short"), "short");
  assert.equal(mod.snippet("  lots   of\n\tspace  here  "), "lots of space…");
  assert.equal(mod.snippet(""), "");
  assert.equal(mod.snippet(null), "");
  assert.equal(mod.snippet("x".repeat(40), 5), "xxxxx…");
  assert.equal(
    mod.snippet("x".repeat(40), 0),
    "x".repeat(mod.SNIPPET_MAX) + "…",
    "0 / invalid max falls back to SNIPPET_MAX"
  );
  assert.equal(mod.snippet("abcdef ", 6), "abcdef", "trailing whitespace is trimmed before the cut");
});

test("waitSeconds is now - createdAt, clamped, null on missing input", () => {
  const mod = pure([]);
  assert.equal(mod.waitSeconds(NOW - 4000, NOW), 4);
  assert.equal(mod.waitSeconds(NOW + 5000, NOW), 0, "future createdAt clamps to 0");
  assert.equal(mod.waitSeconds(0, NOW), null);
  assert.equal(mod.waitSeconds(null, NOW), null);
  assert.equal(mod.waitSeconds("nope", NOW), null);
  assert.equal(mod.waitSeconds(NOW - 1000, null), null);
});

test("describeNowQueue splits running / queued and computes free slots", () => {
  const mod = pure([]);
  const m = mod.describeNowQueue(
    [queued("q1"), running("r1"), queued("q2"), { taskId: "d1", status: "done" }, null],
    { instances: READY, farm: { inFlightCap: 2 }, now: NOW }
  );
  assert.equal(m.cap, 2);
  assert.equal(m.inFlight, 1);
  assert.equal(m.free, 1, "cap 2 - 1 running = 1 free chip");
  assert.deepEqual(m.running.map((c) => c.id), ["r1"]);
  assert.deepEqual(m.queued.map((c) => c.id), ["q1", "q2"]);
  assert.equal(m.queued[0].name, "breeze");
  assert.equal(m.running[0].text, "", "a row with no text yields no snippet, not a bare ellipsis");
});

test("describeNowQueue orders by time and falls back to index positions", () => {
  const mod = pure([]);
  const m = mod.describeNowQueue(
    [
      queued("q2", { createdAt: NOW - 1000 }),
      queued("q1", { createdAt: NOW - 9000 })
    ],
    { instances: READY, now: NOW }
  );
  assert.deepEqual(m.queued.map((c) => c.id), ["q1", "q2"], "oldest queued first");
  assert.deepEqual(m.queued.map((c) => c.position), [1, 2], "no server position -> index + 1");

  const withPos = mod.describeNowQueue(
    [queued("q2", { position: 2 }), queued("q1", { position: 1 })],
    { instances: READY, now: NOW }
  );
  assert.deepEqual(withPos.queued.map((c) => c.id), ["q1", "q2"]);
  assert.deepEqual(withPos.queued.map((c) => c.position), [1, 2], "server position wins");

  const runs = mod.describeNowQueue(
    [running("r2", { startedAt: NOW - 1000 }), running("r1", { startedAt: NOW - 9000 })],
    { instances: READY, now: NOW }
  );
  assert.deepEqual(runs.running.map((c) => c.id), ["r1", "r2"], "longest-running first");
});

test("free chips never go negative when more tasks run than the cap", () => {
  const mod = pure([]);
  const m = mod.describeNowQueue([running("r1"), running("r2"), running("r3")], {
    instances: READY,
    farm: { inFlightCap: 2 },
    now: NOW
  });
  assert.equal(m.inFlight, 3);
  assert.equal(m.free, 0, "Math.max(0, cap - inFlight)");
});

test("chipInstanceName prefers the task name, then the instance list, then id prefix", () => {
  const mod = pure([]);
  const list = [{ id: "abc123", instanceName: "breeze" }];
  assert.equal(mod.chipInstanceName({ instanceName: "siren", instanceId: "abc123" }, list), "siren");
  assert.equal(mod.chipInstanceName({ instanceId: "abc123" }, list), "breeze");
  assert.equal(mod.chipInstanceName({ instanceId: "abcdef1234" }, []), "abcdef");
  assert.equal(mod.chipInstanceName({}, []), "");
});

test("shouldHideStrip hides only when there is nothing to report", () => {
  const mod = pure([]);
  const idle = mod.describeNowQueue([], { instances: READY, now: NOW });
  assert.equal(mod.shouldHideStrip(idle, READY), false, "idle with a ready instance still shows 0 / cap");
  assert.equal(mod.shouldHideStrip(idle, []), true, "no ready instance and no work -> hidden");
  assert.equal(mod.shouldHideStrip(idle, [{ id: "x", status: "STOPPED" }]), true);
  assert.equal(mod.shouldHideStrip(idle, [{ id: "x", status: "STARTING" }]), true);
  const busy = mod.describeNowQueue([running("r1")], { instances: [], now: NOW });
  assert.equal(mod.shouldHideStrip(busy, []), false, "a running task keeps the strip up with no ready instance");
  const queuedOnly = mod.describeNowQueue([queued("q1")], { instances: [], now: NOW });
  assert.equal(mod.shouldHideStrip(queuedOnly, []), false);
});

test("render: running, free and queued chips, with escaped text and a cancel key", () => {
  const world = createDomWorld();
  const root = mount(world);
  const remembered = [];
  const mod = mountLoad(world, {
    rows: [
      running("r1", { text: 'Welcome back "friend"' }),
      queued("q1", { createdAt: Date.now() - 4000, position: 1 }),
      queued("q2", { createdAt: Date.now() - 1000, position: 2, instanceId: "i2", instanceName: "siren" })
    ],
    rememberStart: (ids, obs) => remembered.push({ ids, obs }),
    farm: { inFlightCap: 2 }
  });
  mod.renderNowQueue(Date.now());

  assert.equal(root.classList.contains("hidden"), false, "running task -> strip visible");

  const slots = chipsOf(root);
  assert.equal(slots.length, 2, "1 running chip + 1 free chip");
  assert.ok(slots[0].querySelector(".pulse"), "running chip carries the pulse dot");
  assert.match(box(root).innerHTML, /Welcome back &quot;friend&quot;/, "text is escaped inside the chip");
  assert.match(box(root).innerHTML, /“/, "the snippet is wrapped in typographic quotes");
  assert.equal(slots[1].classList.contains("free"), true);
  assert.match(box(root).innerHTML, /free<\/span>/);

  const qchips = qchipsOf(root);
  assert.equal(qchips.length, 2);
  // 位次与实例名各占一个 .nq-n（位次弱、实例名强），文本在盒子的 HTML 里
  assert.equal(qchips[0].querySelectorAll(".nq-n").length, 2);
  assert.match(box(root).innerHTML, />#1</);
  assert.match(box(root).innerHTML, />siren</);

  // 容量 chip：In flight 1 / 2 + Queued 2
  assert.match(box(root).innerHTML, /In flight 1 \/ 2/);
  assert.match(box(root).innerHTML, /Queued 2/);
  // 运行中 chip 的耗时刻度走共享 elapsed 计时器的 data-elapsed-id 约定
  const elapsed = box(root).querySelector("[data-elapsed-id]");
  assert.ok(elapsed, "running chip has an elapsed node");
  assert.equal(elapsed.getAttribute("data-elapsed-id"), "r1");
  assert.match(box(root).innerHTML, />[0-9]+\.[0-9]s</, "elapsed text uses the shared 3.2s format");
  // 排队 chip 的已等待是 data-wait-at（自带的轻量 tick，不是第二个耗时计时器）
  const wait = box(root).querySelector("[data-wait-at]");
  assert.ok(wait, "queued chip has a wait node");
  assert.ok(Number(wait.getAttribute("data-wait-at")) > 0, "wait node carries its createdAt anchor");
  // 起点登记进共享表
  assert.equal(remembered.length, 1);
  // vm realm: the ids object comes from another realm, so compare fields
  assert.equal(remembered[0].ids.taskId, "r1");
  assert.equal(remembered[0].ids.instanceId, undefined, "the chip keys the shared table by taskId");
  // 竖分隔线只在有排队任务时出现
  assert.ok(box(root).querySelector(".nq-vs"), "separator before the queue section");
});

test("render: cancel key is labelled, disabled while in flight, and fires the API once", async () => {
  const world = createDomWorld();
  const root = mount(world);
  const calls = [];
  let resolveCancel;
  const cancelTask = (id) => {
    calls.push(id);
    return new Promise((res) => {
      resolveCancel = res;
    });
  };
  const mod = mountLoad(world, {
    rows: [running("r1"), queued("q1")],
    cancelTask,
    farm: { inFlightCap: 2 }
  });
  mod.renderNowQueue(Date.now());

  const buttons = box(root).querySelectorAll(".nq-x");
  assert.equal(buttons.length, 2, "one cancel key per task chip");
  const btn = buttons[0];
  assert.equal(btn.getAttribute("data-task"), "r1");
  assert.equal(btn.getAttribute("aria-label"), "Cancel task on breeze", "i18n aria-label names the instance");
  assert.ok(btn.getAttribute("title").length > 0, "tooltip carries the short task id");
  assert.match(btn.getAttribute("title"), /r1/);

  world.fire(btn, "click");
  world.fire(btn, "click");
  world.fire(btn, "click");
  assert.deepEqual(calls, ["r1"], "double / triple click must not send three DELETEs");
  assert.equal(btn.disabled, true, "button disabled while the request is in flight");
  assert.equal(btn.classList.contains("busy"), true);

  resolveCancel();
  await flush();
  assert.deepEqual(calls, ["r1"]);
});

test("render: a failing cancel surfaces the toast path and re-enables the key", async () => {
  const world = createDomWorld();
  const root = mount(world);
  // tasks.js 的 cancelTask 内部已经 showToast，这里只钉「失败后重画、可再次点击」
  const calls = [];
  const mod = mountLoad(world, {
    rows: [running("r1")],
    cancelTask: (id) => {
      calls.push(id);
      return Promise.reject(new Error("boom"));
    }
  });
  mod.renderNowQueue(Date.now());
  const btn = box(root).querySelector(".nq-x");
  world.fire(btn, "click");
  await flush();
  assert.deepEqual(calls, ["r1"]);
  const again = box(root).querySelector(".nq-x");
  assert.ok(!again.disabled, "key is usable again after the failed request");
  assert.equal(again.classList.contains("busy"), false);
  world.fire(again, "click");
  assert.deepEqual(calls, ["r1", "r1"], "a retry after failure is allowed");
});

test("render: idle keeps one compact line with 0 / cap and the free chips", () => {
  const world = createDomWorld();
  const root = mount(world);
  const mod = mountLoad(world, { rows: [], farm: { inFlightCap: 3 } });
  mod.renderNowQueue(Date.now());

  assert.equal(root.classList.contains("hidden"), false);
  assert.equal(root.classList.contains("is-idle"), true);
  assert.match(box(root).innerHTML, /In flight 0 \/ 3/);
  assert.equal(chipsOf(root).length, 3, "three free chips for a cap of 3");
  assert.equal(qchipsOf(root).length, 0);
  assert.equal(box(root).querySelector(".nq-vs"), null, "no separator without queued work");
});

test("render: hidden when there is no ready instance and no work", () => {
  const world = createDomWorld();
  const root = mount(world);
  const mod = mountLoad(world, { rows: [], instances: [] });
  mod.renderNowQueue(Date.now());
  assert.equal(root.classList.contains("hidden"), true);
  assert.equal(box(root).innerHTML, "", "nothing rendered while hidden");
});

test("render: a queued task keeps the strip up even with no ready instance", () => {
  const world = createDomWorld();
  const root = mount(world);
  const mod = mountLoad(world, { rows: [queued("q1")], instances: [] });
  mod.renderNowQueue(Date.now());
  assert.equal(root.classList.contains("hidden"), false);
  assert.equal(qchipsOf(root).length, 1);
  assert.match(box(root).innerHTML, /In flight 0 \/ 2/, "default cap when the farm summary is absent");
});

test("render: generated markup carries no inline style attribute (CSP style-src 'self')", () => {
  const world = createDomWorld();
  const root = mount(world);
  const mod = mountLoad(world, {
    rows: [running("r1", { text: "hi" }), queued("q1")],
    farm: { inFlightCap: 2 }
  });
  mod.renderNowQueue(Date.now());
  assert.doesNotMatch(box(root).innerHTML, /style=/);
  assert.match(root.getAttribute("aria-label"), /1 of 2 in flight, 1 queued/, "the strip group is labelled");
});

test("tips carry the instance, the short task id and the full text", () => {
  const world = createDomWorld();
  mount(world);
  const mod = mountLoad(world, { rows: [] });
  const chip = { id: "abcdef123456", name: "breeze", position: 2, task: { text: "the whole line" } };
  assert.equal(mod.runningTip(chip), "breeze · abcdef12 · running · the whole line");
  assert.equal(mod.queuedTip(chip), "breeze · abcdef12 · queued at #2 · the whole line");
  const bare = { id: "abcdef123456", name: "breeze", position: 1, task: {} };
  assert.equal(mod.runningTip(bare), "breeze · abcdef12 · running");
});
