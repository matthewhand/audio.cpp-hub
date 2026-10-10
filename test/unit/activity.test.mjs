/* 最近活动：纯函数 + 真实 renderActivity / startActivity 路径。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld } from "./helpers/dom-stub.mjs";
import { extractFunction, loadEsModule, readWeb } from "./helpers/vm.mjs";

const MIN = 60 * 1000;

/* instances.formatIdleFor 是真源码（activity.js 从那里借「4h」这种相对时长）。
   纯函数、只依赖入参，抽出来在 vm 里求值，避免测试里另写一份格式。 */
const formatIdleFor = new Function(
  `"use strict"; ${extractFunction(readWeb("modules/instances.js"), "formatIdleFor")}; return formatIdleFor;`
)();

function t(key, params) {
  const dict = {
    "activity.empty": "No recent tasks",
    "activity.emptyHidden": "No recent jobs ({n} test jobs hidden)",
    "activity.showJunk": "Show test jobs ({n} hidden)",
    "activity.hideJunk": "Hide test jobs",
    "activity.yesterday": "Yesterday {t}",
    "activity.stripAria": "{n} tasks across {lanes} instances in the last hour",
    "activity.stripEmptyAria": "No task in the last hour across {lanes} instances",
    "activity.stripCaption": "Last hour",
    "activity.stripEmpty": "No activity in the last hour",
    "activity.stripLastTask": "Last task: {t} ago",
    "activity.barTip": "{name} · {status} · {dur}",
    "activity.axisStart": "-60m",
    "activity.axisMinus": "-{n}m",
    "activity.axisNow": "now",
    "activity.status.queued": "Queued",
    "activity.status.running": "Running",
    "activity.status.done": "Done",
    "activity.status.failed": "Failed",
    "activity.status.cancelled": "Cancelled",
    "activity.rowTip": "{id} · {category} · {model}"
  };
  let s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
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

function near(actual, expect) {
  assert.ok(Math.abs(actual - expect) < 1e-9, actual + " ~= " + expect);
}

function junkFns() {
  return loadEsModule("modules/junk.js", {});
}

function pure() {
  const junk = junkFns();
  return loadEsModule("modules/activity.js", {
    $: () => null,
    t,
    esc,
    isJunkActivityRow: junk.isJunkActivityRow,
    formatIdleFor,
    Api: { get: () => Promise.resolve([]) },
    syncBusyTimer() {},
    noteIdleFallback() {},
    isTaskStreamLive: () => false,
    setInterval: () => 0,
    clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} },
    window: { addEventListener() {} },
    document: { getElementById: () => null, querySelectorAll: () => [] }
  });
}

test("formatDuration matches the generating clock", () => {
  const mod = pure();
  assert.equal(mod.formatDuration(5100), "5.1s");
  assert.equal(mod.formatDuration(65000), "1m 05s");
  assert.equal(mod.formatDuration(0), "0.0s");
  assert.equal(mod.formatDuration(-1), "");
  assert.equal(mod.formatDuration("nope"), "");
});

test("upsertEvent merges, orders newest first, and caps at 20", () => {
  const mod = pure();
  let rows = mod.upsertEvent([], {
    taskId: "t1",
    status: "running",
    instanceId: "i",
    instanceName: "voice",
    modelId: "breeze",
    category: "tts",
    ts: 1000
  });
  rows = mod.upsertEvent(rows, { taskId: "t1", status: "done", ts: 5000, durationMs: 4000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].instanceName, "voice");
  assert.equal(rows[0].modelId, "breeze");
  assert.equal(rows[0].status, "done");
  assert.equal(rows[0].startedAt, 1000);
  assert.equal(rows[0].finishedAt, 5000);

  rows = mod.upsertEvent(rows, { taskId: "no-status", instanceId: "x" });
  assert.equal(rows.length, 1);

  rows = [];
  for (let i = 0; i < 25; i++) {
    rows = mod.upsertEvent(rows, {
      taskId: "t" + String(i).padStart(2, "0"),
      status: "done",
      instanceId: "a",
      finishedAt: 1000 + i
    });
  }
  assert.equal(rows.length, 25);
  assert.equal(rows[0].taskId, "t24");
  assert.equal(rows[24].taskId, "t00");
});

test("rowsFromTasks maps hub statuses and drops unknown ones", () => {
  const mod = pure();
  const rows = mod.rowsFromTasks([
    {
      id: "a",
      status: "DONE",
      instanceId: "i1",
      instanceName: "voice",
      finishedAt: 50,
      startedAt: 10
    },
    { id: "b", status: "WEIRD" },
    { id: "", status: "QUEUED" },
    { id: "c", status: "RUNNING", instanceId: "i2", startedAt: 80, createdAt: 70 }
  ]);
  assert.deepEqual(
    Array.from(rows, (r) => r.taskId + ":" + r.status),
    ["c:running", "a:done"]
  );
  assert.equal(rows[1].instanceName, "voice");
});

test("stripRects uses a 60 minute window and one lane per instance", () => {
  const mod = pure();
  const now = 1_700_000_000_000;
  const { lanes, windowMs } = mod.stripRects(
    [
      {
        taskId: "done",
        instanceId: "i2",
        status: "done",
        startedAt: now - 5 * MIN,
        finishedAt: now - 4 * MIN
      },
      {
        taskId: "run",
        instanceId: "i1",
        status: "running",
        startedAt: now - 2 * MIN
      },
      {
        taskId: "old",
        instanceId: "i1",
        status: "done",
        startedAt: now - 90 * MIN,
        finishedAt: now - 89 * MIN
      },
      { taskId: "q", instanceId: "i1", status: "queued", queuedAt: now - MIN }
    ],
    now
  );
  assert.equal(windowMs, 60 * MIN);
  assert.deepEqual(
    Array.from(lanes, (l) => l.instanceId),
    ["i1", "i2"]
  );
  assert.equal(lanes[0].rects.length, 1);
  assert.equal(lanes[0].rects[0].status, "running");
  near(lanes[0].rects[0].left, 58 / 60);
  near(lanes[0].rects[0].width, 2 / 60);
  assert.equal(lanes[1].rects[0].status, "done");
  near(lanes[1].rects[0].left, 55 / 60);
  near(lanes[1].rects[0].width, 1 / 60);
});

function mount(world) {
  const panel = world.el('<details id="activity-panel" class="activity-panel" open=""></details>');
  const strip = world.el('<div id="activity-strip" class="activity-strip"></div>');
  const empty = world.el('<p id="activity-empty" class="hint"></p>');
  const list = world.el('<div id="activity-list" class="activity-list"></div>');
  const toggle = world.el(
    '<button id="activity-junk-toggle" class="act-junk-toggle hidden"></button>'
  );
  panel.appendChild(strip);
  panel.appendChild(empty);
  panel.appendChild(list);
  panel.appendChild(toggle);
  world.document.body.appendChild(panel);
  return { panel, strip, empty, list, toggle };
}

function worldModule(world, extra) {
  const store = new Map();
  const timers = [];
  const winListeners = new Map();
  const idle = [];
  const junk = junkFns();
  const sandbox = {
    document: world.document,
    $: world.$,
    t,
    esc,
    isJunkActivityRow: junk.isJunkActivityRow,
    formatIdleFor,
    Date,
    Promise,
    setInterval(fn, ms) {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    window: {
      addEventListener(type, cb) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(cb);
      }
    },
    Api: { get: () => Promise.resolve([]) },
    syncBusyTimer() {},
    noteIdleFallback(id, ts) {
      idle.push([id, ts]);
    },
    isTaskStreamLive: () => false,
    ...extra
  };
  const mod = loadEsModule("modules/activity.js", sandbox);
  mod.__sandbox = sandbox;
  mod.__timers = timers;
  mod.__store = store;
  mod.__idle = idle;
  mod.__win = winListeners;
  return mod;
}

test("renderActivity writes status text, duration, and the strip without style attrs", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = worldModule(world);
  const now = 1_700_000_000_000;
  mod.seedActivity([
    {
      id: "abcd1234ffff",
      instanceId: "i1",
      instanceName: "voice",
      modelId: "breeze",
      category: "tts",
      status: "DONE",
      createdAt: now - 6 * MIN,
      startedAt: now - 5 * MIN,
      finishedAt: now - 4 * MIN
    },
    {
      id: "fail0001xxxx",
      instanceId: "i1",
      instanceName: "voice",
      modelId: "breeze",
      category: "tts",
      status: "FAILED",
      createdAt: now - 3 * MIN,
      startedAt: now - 3 * MIN,
      finishedAt: now - 3 * MIN + 5100
    },
    {
      id: "run00001",
      instanceId: "i2",
      instanceName: "song",
      modelId: "music",
      category: "music",
      status: "RUNNING",
      createdAt: now - 2 * MIN,
      startedAt: now - 2 * MIN
    }
  ]);
  mod.renderActivity(now);
  const html = ui.list.innerHTML;
  assert.match(html, /act-status done/);
  assert.match(html, /act-status-text">Done</);
  assert.match(html, /act-status failed/);
  assert.match(html, /act-status-text">Failed</);
  assert.match(html, /act-status running/);
  assert.match(html, /act-status-text">Running</);
  assert.match(html, /title="abcd1234 · tts · breeze"/);
  assert.match(html, />5\.1s</);
  assert.match(html, /badge-elapsed num" data-start="/);
  assert.match(html, new RegExp(mod.formatActivityWhen(now - 4 * MIN, now)));
  assert.match(html, new RegExp('title="' + new Date(now - 4 * MIN).toISOString()));
  assert.equal(ui.list.querySelectorAll(".act-status.done").length, 1);
  assert.equal(ui.empty.classList.contains("hidden"), true);
  assert.doesNotMatch(html, /style=/);
  assert.equal(html.includes("data-elapsed-id"), false);

  const svg = ui.strip.innerHTML;
  const runBar = mod.stripBar(58 / 60, 2 / 60);
  const doneBar = mod.stripBar(55 / 60, 1 / 60);
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="3 tasks across 2 instances in the last hour"/);
  assert.match(svg, /act-strip-caption">Last hour</);
  assert.match(svg, /class="act-tick"/);
  assert.equal(svg.split('class="act-tick"').length - 1, 7);
  assert.match(svg, />-60m</);
  assert.match(svg, />-50m</);
  assert.match(svg, />-30m</);
  assert.match(svg, />-10m</);
  assert.match(svg, />now</);
  assert.match(svg, /aria-label="voice"/);
  assert.match(svg, /aria-label="song"/);
  assert.match(svg, /class="act-lane-label"[^>]*>voice</);
  assert.match(html, /class="act-name" title=/);
  assert.equal(ui.list.querySelectorAll(".act-row").length, 3);
  assert.equal(ui.list.querySelectorAll(".act-dur").length, 3);
  assert.match(svg, /class="act-rect done ok"/);
  assert.match(svg, /class="act-rect running is-live"/);
  assert.match(svg, /class="act-rect failed err"/);
  assert.match(svg, new RegExp('x="' + doneBar.x + '"'));
  assert.match(svg, new RegExp('width="' + doneBar.w + '"'));
  assert.match(svg, new RegExp('x="' + runBar.x + '"'));
  assert.match(svg, new RegExp('width="' + runBar.w + '"'));
  assert.ok(doneBar.w >= 3, "a bar is at least 3 user units wide");
  // 条身 10px、圆角 2px：2 倍缩放下才看得清
  assert.doesNotMatch(svg, /height="5"/);
  assert.equal(svg.split('height="10" rx="2"').length - 1, 5, "3 bars + 2 lane baselines");
  // 每条任务条自带「实例 · 状态 · 耗时」的 <title>，不依赖颜色图例
  assert.match(svg, /<title>voice · Failed · 5\.1s<\/title>/);
  assert.match(svg, /<title>song · Running · 2m 00s<\/title>/);
  assert.doesNotMatch(svg, /<title>[0-9a-f]{8}<\/title>/);
  assert.doesNotMatch(svg, /style=/);
  assert.equal(ui.strip.querySelectorAll("rect.act-rect").length, 3);
  assert.deepEqual(mod.__idle, [
    ["i1", now - 4 * MIN],
    ["i1", now - 3 * MIN + 5100]
  ]);
});

test("startActivity remembers a closed panel and skips DOM updates until it opens", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const tasks = [
    {
      id: "abcd1234",
      instanceId: "i1",
      instanceName: "voice",
      modelId: "breeze",
      category: "tts",
      status: "DONE",
      createdAt: 10,
      startedAt: 10,
      finishedAt: 20
    }
  ];
  let live = false;
  const mod = worldModule(world, {
    Api: { get: () => Promise.resolve(tasks) },
    isTaskStreamLive: () => live
  });
  mod.__store.set("hub-activity-open", "0");
  mod.startActivity();
  assert.equal(ui.panel.open, false);
  assert.equal(ui.list.innerHTML, "");
  assert.equal(mod.__timers.length, 0, "closed panel does not poll or tick the strip");

  return Promise.resolve().then(() => {
    assert.equal(ui.list.innerHTML, "", "seed while closed does not paint");
    ui.panel.open = true;
    world.fire(ui.panel, "toggle");
    assert.equal(mod.__store.get("hub-activity-open"), "1");
    assert.match(ui.list.innerHTML, /act-status-text">Done</);
    assert.equal(mod.__timers.filter((x) => x.ms === 5000).length, 2);
    live = true;
    for (const cb of mod.__win.get("hub-task-stream") || []) cb();
    assert.equal(mod.__timers.length, 1);
    assert.equal(mod.__timers[0].ms, 5000);
    mod.resetActivity();
  });
});

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (i * 7 + 3) % (i + 1);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

test("rowsFromTasks sorts shuffled input newest-first and caps after the sort", () => {
  const mod = pure();
  const morning = Date.parse("2026-10-10T06:39:00Z");
  const evening = Date.parse("2026-10-10T18:55:00Z");
  const pair = [
    {
      id: "am-run",
      status: "RUNNING",
      instanceId: "i",
      createdAt: morning,
      startedAt: morning
    },
    {
      id: "pm-done",
      status: "DONE",
      instanceId: "i",
      createdAt: morning,
      startedAt: evening - MIN,
      finishedAt: evening
    }
  ];
  for (const input of [pair, pair.slice().reverse(), shuffle(pair)]) {
    const rows = mod.rowsFromTasks(input);
    assert.deepEqual(
      Array.from(rows, (r) => r.taskId),
      ["pm-done", "am-run"]
    );
  }
  const tied = mod.rowsFromTasks([
    { id: "b", status: "DONE", createdAt: 10, startedAt: 10, finishedAt: 10 },
    { id: "a", status: "DONE", createdAt: 10, startedAt: 10, finishedAt: 10 }
  ]);
  assert.deepEqual(
    Array.from(tied, (r) => r.taskId),
    ["a", "b"]
  );

  const many = [];
  for (let i = 0; i < 25; i++) {
    const at = 1000 + i;
    many.push({
      id: "t" + String(i).padStart(2, "0"),
      status: "DONE",
      instanceId: "a",
      createdAt: at,
      startedAt: at,
      finishedAt: at
    });
  }
  const capped = mod.rowsFromTasks(shuffle(many));
  assert.equal(capped.length, 25);
  assert.equal(capped[0].taskId, "t24");
  assert.equal(capped[24].taskId, "t00");
  const vis = mod.visibleActivity(capped);
  assert.equal(vis.visible.length, 20);
  assert.equal(vis.visible[0].taskId, "t24");
  assert.equal(vis.visible[19].taskId, "t05");
  assert.equal(vis.hiddenCount, 0);

  let rows = mod.rowsFromTasks(pair);
  rows = mod.upsertEvent(rows, {
    taskId: "am-run",
    status: "done",
    ts: morning + 5000,
    durationMs: 5000
  });
  assert.equal(rows[0].taskId, "pm-done");
  rows = mod.upsertEvent(rows, { taskId: "am-run", status: "done", ts: evening + 999999 });
  assert.equal(rows[0].taskId, "pm-done", "an SSE touch does not float an older row");
  assert.equal(rows.find((r) => r.taskId === "am-run").finishedAt, morning + 5000);
});

test("activityInstanceName prefers the instances list, then a task name, never 32 hex", () => {
  const mod = pure();
  const hex = "a1b2c3d4".repeat(4);
  assert.equal(hex.length, 32);
  const row = { taskId: "t", instanceId: hex };
  assert.equal(mod.activityInstanceName(row, [{ id: hex, instanceName: "breeze" }]), "breeze");
  assert.equal(mod.activityInstanceName({ ...row, instanceName: "song" }, []), "song");
  assert.equal(mod.activityInstanceName({ ...row, instanceName: hex }, []), "a1b2c3");
  assert.equal(mod.activityInstanceName(row, []), "a1b2c3");
  assert.doesNotMatch(mod.activityInstanceName(row, []), /[0-9a-f]{32}/i);
});

test("renderActivity orders seeded rows, resolves names, and merges an SSE row by taskId", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const morning = Date.parse("2026-10-10T06:39:00Z");
  const evening = Date.parse("2026-10-10T18:55:00Z");
  const hex = "a1b2c3d4".repeat(4);
  const mod = worldModule(world, {
    instances: [{ id: hex, instanceName: "breeze" }]
  });
  mod.seedActivity(
    shuffle([
      {
        id: "am-run00",
        instanceId: "i1",
        instanceName: "voice",
        modelId: "breeze",
        category: "tts",
        status: "RUNNING",
        createdAt: morning,
        startedAt: morning
      },
      {
        id: "pm-done1",
        instanceId: "i2",
        instanceName: "song",
        modelId: "music",
        category: "music",
        status: "DONE",
        createdAt: morning,
        startedAt: evening - MIN,
        finishedAt: evening
      }
    ])
  );
  mod.renderActivity(evening);
  const titles = [...ui.list.innerHTML.matchAll(/class="act-name" title="([^"]+)"/g)].map(
    (m) => m[1]
  );
  assert.equal(titles[0].startsWith("pm-done1"), true);
  assert.equal(titles[1].startsWith("am-run00"), true);
  const clocks = [...ui.list.innerHTML.matchAll(/class="act-time num"[^>]*>([^<]*)</g)].map(
    (m) => m[1]
  );
  assert.deepEqual(clocks, [
    mod.formatActivityWhen(evening, evening),
    mod.formatActivityWhen(morning, evening)
  ]);

  mod.startActivity();
  return Promise.resolve().then(() => {
    for (const cb of mod.__win.get("hub-task-event") || []) {
      cb({
        detail: {
          name: "task.started",
          data: { taskId: "sse-task", instanceId: hex, ts: morning }
        }
      });
    }
    assert.match(ui.list.innerHTML, />breeze</);
    assert.doesNotMatch(ui.list.innerHTML, new RegExp(hex));
    mod.__sandbox.instances = [];
    mod.renderActivity(evening);
    assert.match(ui.list.innerHTML, />a1b2c3</);
    assert.doesNotMatch(ui.list.innerHTML, new RegExp(hex));
    mod.seedActivity([
      {
        id: "sse-task",
        instanceId: hex,
        instanceName: "harbor",
        modelId: "music",
        category: "music",
        status: "RUNNING",
        createdAt: morning,
        startedAt: morning
      }
    ]);
    assert.equal(ui.list.querySelectorAll(".act-row").length, 3);
    const names = [...ui.list.innerHTML.matchAll(/class="act-name"[^>]*>([^<]*)</g)].map(
      (m) => m[1]
    );
    assert.equal(names.filter((n) => n === "harbor").length, 1);
    assert.equal(ui.list.innerHTML.split("sse-task").length - 1, 1);
    assert.doesNotMatch(ui.list.innerHTML, /style=/);
    mod.resetActivity();
  });
});

test("an hour with no real task keeps faint baselines and a centred caption", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = worldModule(world, {
    instances: [{ id: "i1", instanceName: "voice" }, { id: "i2", instanceName: "song" }]
  });
  const now = 1_700_000_000_000;
  mod.seedActivity([
    {
      id: "oldtask1",
      instanceId: "i1",
      instanceName: "voice",
      modelId: "breeze",
      category: "tts",
      status: "DONE",
      createdAt: now - 120 * MIN,
      startedAt: now - 120 * MIN,
      finishedAt: now - 119 * MIN
    }
  ]);
  mod.renderActivity(now);
  const svg = ui.strip.innerHTML;
  // 一条任务条都不画：没有假装在时间轴上的假条
  assert.equal(ui.strip.querySelectorAll("rect.act-rect").length, 0);
  // 两条淡基线 + 泳道名 + 时间轴照旧
  assert.equal(ui.strip.querySelectorAll("rect.act-lane-bg").length, 2);
  assert.match(svg, /act-strip-empty/);
  assert.match(svg, /aria-label="voice"/);
  assert.match(svg, /aria-label="song"/);
  assert.match(svg, /class="act-tick"/);
  assert.match(svg, />-60m</);
  assert.match(svg, />now</);
  // 居中说明 + 「最近任务：2h 前」（实例名来自实例列表，不只来自历史行）
  assert.match(svg, /aria-label="No task in the last hour across 2 instances"/);
  assert.match(
    ui.strip.innerHTML,
    /act-strip-empty-caption">No activity in the last hour/
  );
  assert.match(ui.strip.innerHTML, /act-strip-sub">Last task: 1h ago</);
  assert.match(ui.list.innerHTML, />voice</);
  assert.doesNotMatch(ui.strip.innerHTML, /style=/);

  // 泳道不凭空出现：一小时内没有真实任务、且一台实例都不认识时，整条横条收起。
  mod.__sandbox.instances = [];
  mod.renderActivity(now);
  assert.match(ui.strip.innerHTML, /No activity in the last hour/);
  assert.match(ui.strip.innerHTML, /aria-label="voice"/);
  assert.equal(ui.strip.querySelectorAll("rect.act-rect").length, 0);

  // 一条任务都没有（也没有实例）：什么都不画，空态交给列表自己说
  mod.resetActivity();
  mod.renderActivity(now);
  assert.equal(ui.strip.innerHTML, "");
  assert.equal(ui.empty.textContent, "No recent tasks");
  assert.equal(ui.empty.classList.contains("hidden"), false);
});

test("stripEmptyLanes / lastTaskAt: one lane per real instance, sorted by id", () => {
  const mod = pure();
  const now = 1_700_000_000_000;
  const rows = [
    { taskId: "b", instanceId: "i2", instanceName: "song", startedAt: now - 120 * MIN },
    { taskId: "a", instanceId: "i1", instanceName: "voice", startedAt: now - 130 * MIN }
  ];
  const fromRows = mod.stripEmptyLanes(rows, []);
  assert.deepEqual(
    Array.from(fromRows, l => l.instanceId),
    ["i1", "i2"]
  );
  assert.deepEqual(
    Array.from(fromRows, l => l.instanceName),
    ["voice", "song"]
  );
  assert.deepEqual(
    Array.from(fromRows, l => l.rects.length),
    [0, 0]
  );
  // 实例列表优先，并按实例 id 排序（与 stripRects 同一套，落第一条任务时不换位）
  const fromList = mod.stripEmptyLanes(rows, [
    { id: "i9", instanceName: "zulu" },
    { id: "i1" },
    { id: "i3", modelId: "breeze" }
  ]);
  assert.deepEqual(
    Array.from(fromList, l => l.instanceId),
    ["i1", "i2", "i3", "i9"]
  );
  assert.equal(fromList[0].instanceName, "voice", "实例列表缺名字时用行上的");
  assert.equal(fromList[1].instanceName, "song");
  assert.equal(fromList[2].instanceName, "breeze", "列表条目只有 modelId 时用它");
  assert.equal(fromList[3].instanceName, "zulu");
  assert.equal(mod.stripEmptyLanes(rows.concat(rows), [{ id: "i1" }]).length, 2);
  assert.equal(mod.stripEmptyLanes([], []).length, 0);
  assert.equal(mod.stripEmptyLanes(null, null).length, 0);

  assert.equal(mod.lastTaskAt(rows), now - 120 * MIN);
  assert.equal(mod.lastTaskAt([]), 0);
  assert.equal(mod.lastTaskAt(null), 0);
});

test("activity row grid keeps time, name, status, and duration in fixed columns", () => {
  const css = readWeb("style.css");
  assert.match(css, /\.activity-list\s*\{[^}]*display:\s*grid/);
  assert.match(
    css,
    /grid-template-columns:\s*minmax\(5\.5ch,\s*max-content\)\s+minmax\(0,\s*1fr\)/
  );
  assert.match(css, /\.act-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.act-time\s*\{[^}]*tabular-nums/);
  assert.match(css, /\.act-dur\s*\{[^}]*text-align:\s*right/);
  assert.match(css, /\.act-dur\s*\{[^}]*tabular-nums/);
  assert.match(css, /\.act-row\s*\{\s*display:\s*contents/);
});

test("sort is newest-first by full timestamp across days", () => {
  const mod = pure();
  const lateClock = Date.UTC(2026, 9, 8, 23, 0);
  const nextMorning = Date.UTC(2026, 9, 9, 1, 0);
  const newest = Date.UTC(2026, 9, 10, 0, 30);
  const rows = mod.sortActivity([
    { taskId: "clock-late", finishedAt: lateClock },
    { taskId: "next-morning", finishedAt: nextMorning },
    { taskId: "newest", finishedAt: newest }
  ]);
  assert.deepEqual(
    rows.map((r) => r.taskId),
    ["newest", "next-morning", "clock-late"]
  );
});

test("formatActivityWhen shows today, yesterday, and an older month-day", () => {
  const mod = pure();
  const now = new Date(2026, 9, 11, 10, 26, 0, 0).getTime();
  const yest = new Date(2026, 9, 10, 18, 55, 0, 0).getTime();
  const older = new Date(2026, 9, 9, 18, 55, 0, 0).getTime();
  assert.equal(mod.formatActivityWhen(now, now), "10:26");
  assert.equal(mod.formatActivityWhen(yest, now), "Yesterday 18:55");
  assert.equal(mod.formatActivityWhen(older, now), "Oct 9 18:55");

  const zh = loadEsModule("modules/activity.js", {
    $: () => null,
    t: (key, params) => (key === "activity.yesterday" ? "昨天 " + params.t : key),
    esc,
    isJunkActivityRow: junkFns().isJunkActivityRow,
    I18N: { locale: () => "zh-CN" },
    Date,
    setInterval: () => 0,
    clearInterval() {}
  });
  assert.equal(zh.formatActivityWhen(yest, now), "昨天 18:55");
  assert.match(zh.formatActivityWhen(older, now), /18:55/);
  assert.match(zh.formatActivityWhen(older, now), /9/);
});

test("junk rows stay hidden, dim when shown, and do not fill the strip", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = worldModule(world);
  const now = new Date(2026, 9, 11, 10, 26, 0, 0).getTime();
  const real = [];
  for (let i = 0; i < 22; i++) {
    const at = now - (30 - i) * 1000;
    real.push({
      id: "real" + String(i).padStart(2, "0"),
      instanceId: "i1",
      instanceName: "voice",
      modelId: "breeze",
      category: "tts",
      status: "DONE",
      createdAt: at,
      startedAt: at,
      finishedAt: at
    });
  }
  mod.seedActivity(
    real.concat([
      {
        id: "probe001",
        instanceId: "i9",
        instanceName: "probe-1",
        modelId: "probe",
        category: "tts",
        status: "DONE",
        createdAt: now + 5000,
        startedAt: now + 4000,
        finishedAt: now + 5000
      }
    ])
  );
  mod.renderActivity(now);
  assert.equal(ui.list.querySelectorAll(".act-row").length, 20);
  assert.match(ui.list.innerHTML, />voice</);
  assert.doesNotMatch(ui.list.innerHTML, /probe/);
  assert.equal(ui.toggle.textContent, "Show test jobs (1 hidden)");
  assert.doesNotMatch(ui.strip.innerHTML, /probe/);
  assert.match(ui.strip.innerHTML, /Last hour/);
  ui.toggle.onclick();
  assert.equal(mod.__store.get("hub-activity-show-junk"), "1");
  assert.equal(ui.toggle.textContent, "Hide test jobs");
  assert.match(ui.list.innerHTML, /probe-1/);
  assert.equal(ui.list.querySelectorAll(".junk").length > 0, true);
  assert.doesNotMatch(ui.list.innerHTML, /style=/);
  assert.doesNotMatch(ui.strip.innerHTML, /probe/);

  mod.resetActivity();
  mod.__store.set("hub-activity-show-junk", "0");
  mod.seedActivity([
    {
      id: "onlyjunk",
      instanceId: "i9",
      instanceName: "race",
      modelId: "race",
      status: "DONE",
      createdAt: now,
      startedAt: now,
      finishedAt: now
    }
  ]);
  assert.equal(ui.list.innerHTML, "");
  assert.equal(ui.strip.innerHTML, "");
  assert.equal(ui.empty.textContent, "No recent jobs (1 test jobs hidden)");
});
