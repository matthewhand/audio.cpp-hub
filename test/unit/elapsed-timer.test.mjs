/* 生成耗时：三处显示读同一张表，只有 instances.js 的一个 interval 重画。
   伪造时钟走真实的 renderInstanceList / updateInstanceBar / renderLiveTicker。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import { loadEsModule } from "./helpers/vm.mjs";

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const DICT = {
  "instance.generating": "Generating…",
  "instance.ready": "Ready",
  "instance.noReady": "No ready instance",
  "instance.status.READY": "Ready",
  "instance.status.STOPPED": "Stopped",
  "instance.detail": "Detail",
  "instance.stop": "Stop",
  "instance.port": "port",
  "instance.vramHead": "VRAM {text}",
  "instance.vramHeadTip": "VRAM",
  "ticker.running": "Streaming from {name} · {t}",
  "ticker.runningNoTime": "Streaming from {name}",
  "ticker.done": "Done on {name} · {t}",
  "ticker.doneNoTime": "Done on {name}",
  "ticker.doneRtf": "Done on {name} · {t} · RTF {rtf}",
  "ticker.doneRtfOnly": "Done on {name} · RTF {rtf}",
  "ticker.failed": "Failed on {name} · {error}",
  "ticker.failedBare": "Failed on {name}",
  "ticker.cancelled": "Cancelled on {name}"
};

function t(key, params) {
  let s = Object.prototype.hasOwnProperty.call(DICT, key) ? DICT[key] : key;
  for (const [k, v] of Object.entries(params || {})) s = s.split("{" + k + "}").join(String(v));
  return s;
}

function makeClock(start) {
  const clock = { now: start };
  const DateFake = { now: () => clock.now };
  return { clock, Date: DateFake };
}

function mount(world) {
  const { el } = world;
  const body = world.document.body;
  const add = (html) => {
    const node = el(html);
    body.appendChild(node);
    return node;
  };
  add('<div id="instance-list" class="card-list"></div>');
  add('<select id="instance-select"></select>');
  add('<button id="instance-stop"></button>');
  add('<button id="instance-detail"></button>');
  add('<span id="instance-pill" class="pill warn"></span>');
  add('<span id="instance-count"></span>');
  add('<span id="instance-vram" class="sec-vram num"></span>');
  add('<span id="instance-generating" class="badge generating hidden"></span>');
  add('<p id="tts-live" class="live-ticker hidden"></p>');
  const modal = add('<div id="instance-detail-modal" class="modal-overlay hidden"></div>');
  modal.appendChild(el('<button id="instance-detail-close"></button>'));
  modal.appendChild(el('<div id="instance-detail-body"></div>'));
  world.document.createElement = (tag) => new StubElement(world, tag);
}

function breeze(taskCount) {
  return {
    id: "i1",
    instanceName: "breeze",
    modelId: "breeze",
    status: "READY",
    backend: "cpu",
    device: 0,
    port: 7001,
    createdAt: "2026-01-01T00:00:00.000Z",
    taskCount
  };
}

/** 卡片、工具栏、状态行三处 .badge-elapsed 的文本。 */
function elapsedTexts(world) {
  return world.document.querySelectorAll("[data-elapsed-id]").map((n) => n.textContent);
}

test("elapsed helpers: skew, clamp, queued→started, rebind", () => {
  const { clock, Date } = makeClock(1_700_000_000_000);
  const e = loadEsModule("modules/elapsed.js", { Date });
  const T0 = clock.now;

  assert.equal(e.displayStartMs(T0 + 50, T0), T0);
  assert.equal(e.displayStartMs(T0 - 10, T0), T0 - 10);
  assert.equal(
    e.candidateStartMs({ startedAt: T0 - 10_000, now: T0, receivedAt: T0 }),
    T0 - 10_000
  );
  assert.equal(
    e.candidateStartMs({ sseTs: T0 + 5_000, live: true, now: T0, receivedAt: T0 - 20 }),
    T0 - 20
  );
  assert.equal(
    e.candidateStartMs({ sseTs: T0 + e.SKEW_MS, live: true, now: T0, receivedAt: T0 }),
    T0 + e.SKEW_MS
  );
  assert.equal(e.candidateStartMs({ sseTs: T0 - 10_000, live: true, now: T0, receivedAt: T0 }), T0);

  e.rememberStart({ taskId: "q", instanceId: "i1" }, { now: T0 });
  assert.equal(e.rawStartMs("q"), T0);
  clock.now = T0 + 2_600;
  e.rememberStart({ taskId: "q", instanceId: "i1" }, { startedAt: T0 + 2_000, now: clock.now });
  assert.equal(e.rawStartMs("q"), T0);
  assert.equal(e.taskStartMs("q", clock.now), T0);
  assert.equal((clock.now - e.taskStartMs("i1", clock.now)) / 1000, 2.6);

  e.resetElapsed();
  clock.now = T0 + 5_000;
  e.rememberStart({ taskId: "late", instanceId: "i1" }, { now: clock.now });
  assert.equal(e.rawStartMs("late"), T0 + 5_000);
  e.rememberStart({ taskId: "late", instanceId: "i1" }, { startedAt: T0, now: clock.now });
  assert.equal(e.rawStartMs("late"), T0);
  assert.equal(e.rawStartMs("i1"), T0);

  e.resetElapsed();
  e.rememberStart({ taskId: "a", instanceId: "i1" }, { startedAt: T0, now: T0 });
  e.rememberStart({ taskId: "b", instanceId: "i1" }, { startedAt: T0 + 10_000, now: T0 + 10_000 });
  assert.equal(e.rawStartMs("a"), T0);
  assert.equal(e.rawStartMs("b"), T0 + 10_000);
  assert.equal(e.rawStartMs("i1"), T0 + 10_000);

  e.clearTaskStart({ taskId: "b", instanceId: "i1" });
  assert.equal(e.rawStartMs("b"), null);
  assert.equal(e.rawStartMs("i1"), null);
  assert.equal(e.rawStartMs("a"), T0);
  assert.equal(e.hasActiveStarts(), true);
  e.clearTaskStart({ taskId: "a" });
  assert.equal(e.hasActiveStarts(), false);
});

test("card, toolbar and status line share one anchor and one timer", () => {
  const T0 = 1_700_000_000_000;
  const { clock, Date } = makeClock(T0);
  const world = createDomWorld();
  mount(world);
  const elapsed = loadEsModule("modules/elapsed.js", { Date });
  const timers = [];
  let seq = 1;
  let clears = 0;
  const instSb = {
    document: world.document,
    window: { dispatchEvent() {}, addEventListener() {}, hubPanelClosed() {} },
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
    activeInstanceId: "i1",
    setActiveInstanceId(id) {
      instSb.activeInstanceId = id;
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
    selectedModelId: "breeze",
    location: { hash: "" },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval(fn, ms) {
      const id = seq++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
      clears++;
    },
    Date
  };
  const inst = loadEsModule("modules/instances.js", instSb);
  const ticker = loadEsModule("modules/live-ticker.js", {
    document: world.document,
    $: world.$,
    t,
    Date,
    setInterval() {
      throw new Error("live-ticker must not start an interval");
    },
    clearInterval() {
      throw new Error("live-ticker must not clear an interval");
    },
    setTimeout: () => 1,
    clearTimeout() {},
    instances: [{ id: "i1", instanceName: "breeze" }],
    activeInstanceId: "i1",
    formatBusyElapsed: inst.formatBusyElapsed,
    syncBusyTimer: inst.syncBusyTimer,
    rememberStart: elapsed.rememberStart,
    taskStartMs: elapsed.taskStartMs,
    rawStartMs: elapsed.rawStartMs,
    clearTaskStart: elapsed.clearTaskStart,
    resetElapsed: elapsed.resetElapsed,
    Api: { get: () => Promise.resolve(null) },
    window: { addEventListener() {} }
  });

  const paint = (task, taskCount) => {
    if (task && task.status === "RUNNING" && task.startedAt) {
      instSb.runningStarts.set("i1", task.startedAt);
    }
    inst.applyInstances([breeze(taskCount)]);
    if (task) ticker.noteTask(task);
  };

  instSb.runningStarts.set("i1", T0);
  paint({ id: "task-1", instanceId: "i1", status: "RUNNING", startedAt: T0 }, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 200);
  assert.deepEqual(elapsedTexts(world), ["0.0s", "0.0s", "0.0s"]);

  clock.now = T0 + 1_200;
  paint({ id: "task-1", instanceId: "i1", status: "RUNNING", startedAt: T0 }, 1);
  const at12 = elapsedTexts(world);
  assert.equal(at12.length, 3);
  assert.deepEqual(at12, ["1.2s", "1.2s", "1.2s"]);
  assert.equal(elapsed.rawStartMs("task-1"), T0);
  assert.equal(elapsed.rawStartMs("i1"), T0);

  instSb.runningStarts.set("i1", T0 + 5_000);
  paint({ id: "task-1", instanceId: "i1", status: "RUNNING", startedAt: T0 + 5_000 }, 1);
  assert.deepEqual(elapsedTexts(world), ["1.2s", "1.2s", "1.2s"]);
  assert.equal(elapsed.rawStartMs("task-1"), T0);
  assert.equal(clears, 0);
  assert.equal(timers.length, 1);

  const seen = ["1.2s"];
  clock.now = T0 + 2_600;
  timers[0].fn();
  const at26 = elapsedTexts(world);
  assert.deepEqual(at26, ["2.6s", "2.6s", "2.6s"]);
  seen.push("2.6s");
  assert.deepEqual(seen, ["1.2s", "2.6s"]);

  ticker.resetLiveTicker();
  clock.now = T0 + 20_000;
  const skewed = clock.now + 5_000;
  ticker.noteTaskEvent("task.started", { taskId: "skew", instanceId: "i1", ts: skewed });
  assert.equal(elapsed.rawStartMs("skew"), clock.now);
  assert.notEqual(elapsed.rawStartMs("skew"), skewed);
  const skewSpan = world.document.getElementById("tts-live").querySelector("[data-elapsed-id]");
  assert.equal(skewSpan.textContent, "0.0s");

  ticker.resetLiveTicker();
  clock.now = T0 + 30_000;
  const edge = clock.now + elapsed.SKEW_MS;
  ticker.noteTaskEvent("task.started", { taskId: "edge", instanceId: "i1", ts: edge });
  assert.equal(elapsed.rawStartMs("edge"), edge);
  assert.equal(
    world.document.getElementById("tts-live").querySelector("[data-elapsed-id]").textContent,
    "0.0s"
  );
  assert.equal(
    world.document
      .getElementById("tts-live")
      .querySelector("[data-elapsed-id]")
      .getAttribute("data-start"),
    String(edge)
  );

  ticker.resetLiveTicker();
  clock.now = T0 + 40_000;
  const hist = clock.now - 10_000;
  paint({ id: "hist", instanceId: "i1", status: "RUNNING", startedAt: hist }, 1);
  assert.equal(elapsed.rawStartMs("hist"), hist);
  assert.deepEqual(elapsedTexts(world), ["10.0s", "10.0s", "10.0s"]);

  ticker.resetLiveTicker();
  instSb.runningStarts.delete("i1");
  instSb.busyStarts.clear();
  clock.now = T0 + 50_000;
  paint({ id: "q2", instanceId: "i1", status: "QUEUED" }, 1);
  assert.equal(elapsed.rawStartMs("q2"), clock.now);
  const queuedAt = clock.now;
  clock.now = queuedAt + 2_600;
  instSb.runningStarts.set("i1", queuedAt + 2_000);
  paint({ id: "q2", instanceId: "i1", status: "RUNNING", startedAt: queuedAt + 2_000 }, 1);
  assert.equal(elapsed.rawStartMs("q2"), queuedAt);
  assert.deepEqual(elapsedTexts(world), ["2.6s", "2.6s", "2.6s"]);

  ticker.resetLiveTicker();
  instSb.runningStarts.delete("i1");
  clock.now = T0 + 60_000;
  paint({ id: "late2", instanceId: "i1", status: "QUEUED" }, 1);
  clock.now = T0 + 65_000;
  paint({ id: "late2", instanceId: "i1", status: "RUNNING", startedAt: T0 + 60_000 }, 1);
  assert.equal(elapsed.rawStartMs("late2"), T0 + 60_000);
  assert.deepEqual(elapsedTexts(world), ["5.0s", "5.0s", "5.0s"]);

  instSb.runningStarts.delete("i1");
  instSb.busyStarts.clear();
  ticker.noteTask({ id: "late2", instanceId: "i1", status: "DONE", finishedAt: clock.now });
  inst.applyInstances([breeze(0)]);
  assert.equal(world.document.querySelectorAll("[data-elapsed-id]").length, 0);
  assert.equal(timers.length, 0);
  assert.equal(elapsed.hasActiveStarts(), false);

  clock.now = T0 + 100_000;
  const start2 = clock.now;
  instSb.runningStarts.set("i1", start2);
  paint({ id: "task-2", instanceId: "i1", status: "RUNNING", startedAt: start2 }, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 200);
  assert.deepEqual(elapsedTexts(world), ["0.0s", "0.0s", "0.0s"]);
  clock.now = start2 + 500;
  timers[0].fn();
  assert.deepEqual(elapsedTexts(world), ["0.5s", "0.5s", "0.5s"]);
  assert.equal(elapsed.rawStartMs("task-2"), start2);
  assert.equal(elapsed.rawStartMs("late2"), null);
});
