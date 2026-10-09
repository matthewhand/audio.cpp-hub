/* 最近活动：纯函数 + 真实 renderActivity / startActivity 路径。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld } from "./helpers/dom-stub.mjs";
import { loadEsModule, readWeb } from "./helpers/vm.mjs";

const MIN = 60 * 1000;

function t(key, params) {
  const dict = {
    "activity.empty": "No recent tasks",
    "activity.stripAria": "{n} tasks across {lanes} instances in the last 10 minutes",
    "activity.stripEmpty": "No tasks in the last 10 minutes",
    "activity.stripCaption": "Last 10 min",
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

function pure() {
  return loadEsModule("modules/activity.js", {
    $: () => null,
    t,
    esc,
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
  assert.equal(rows.length, 20);
  assert.equal(rows[0].taskId, "t24");
  assert.equal(rows[19].taskId, "t05");
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

test("stripRects uses a 10 minute window and one lane per instance", () => {
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
        startedAt: now - 20 * MIN,
        finishedAt: now - 19 * MIN
      },
      { taskId: "q", instanceId: "i1", status: "queued", queuedAt: now - MIN }
    ],
    now
  );
  assert.equal(windowMs, 10 * MIN);
  assert.deepEqual(
    Array.from(lanes, (l) => l.instanceId),
    ["i1", "i2"]
  );
  assert.equal(lanes[0].rects.length, 1);
  assert.equal(lanes[0].rects[0].status, "running");
  near(lanes[0].rects[0].left, 0.8);
  near(lanes[0].rects[0].width, 0.2);
  assert.equal(lanes[1].rects[0].status, "done");
  near(lanes[1].rects[0].left, 0.5);
  near(lanes[1].rects[0].width, 0.1);
});

function mount(world) {
  const panel = world.el('<details id="activity-panel" class="activity-panel" open=""></details>');
  const strip = world.el('<div id="activity-strip" class="activity-strip"></div>');
  const empty = world.el('<p id="activity-empty" class="hint"></p>');
  const list = world.el('<div id="activity-list" class="activity-list"></div>');
  panel.appendChild(strip);
  panel.appendChild(empty);
  panel.appendChild(list);
  world.document.body.appendChild(panel);
  return { panel, strip, empty, list };
}

function worldModule(world, extra) {
  const store = new Map();
  const timers = [];
  const winListeners = new Map();
  const idle = [];
  const sandbox = {
    document: world.document,
    $: world.$,
    t,
    esc,
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
  assert.match(html, new RegExp(mod.formatClock(now - 4 * MIN)));
  assert.equal(ui.list.querySelectorAll(".act-status.done").length, 1);
  assert.equal(ui.empty.classList.contains("hidden"), true);
  assert.doesNotMatch(html, /style=/);

  const svg = ui.strip.innerHTML;
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="3 tasks across 2 instances in the last 10 minutes"/);
  assert.match(svg, /act-strip-caption">Last 10 min</);
  assert.match(svg, /aria-label="voice"/);
  assert.match(svg, /aria-label="song"/);
  assert.match(svg, /class="act-lane-label"[^>]*>voice</);
  assert.match(html, /class="act-name" title=/);
  assert.equal(ui.list.querySelectorAll(".act-row").length, 3);
  assert.equal(ui.list.querySelectorAll(".act-dur").length, 3);
  assert.match(svg, /class="act-rect done"/);
  assert.match(svg, /class="act-rect running"/);
  assert.match(svg, /class="act-rect failed"/);
  assert.match(svg, /x="80"/);
  assert.match(svg, /width="16"/);
  assert.match(svg, /x="128"/);
  assert.match(svg, /width="32"/);
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
    assert.ok(mod.__timers.some((x) => x.ms === 5000));
    assert.ok(mod.__timers.some((x) => x.ms === 4000));
    live = true;
    for (const cb of mod.__win.get("hub-task-stream") || []) cb();
    assert.equal(
      mod.__timers.some((x) => x.ms === 5000),
      false
    );
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
  assert.equal(capped.length, 20);
  assert.equal(capped[0].taskId, "t24");
  assert.equal(capped[19].taskId, "t05");

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
  const titles = [...ui.list.innerHTML.matchAll(/title="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(titles[0].startsWith("pm-done1"), true);
  assert.equal(titles[1].startsWith("am-run00"), true);
  const clocks = [...ui.list.innerHTML.matchAll(/class="act-time num">([^<]*)</g)].map((m) => m[1]);
  assert.deepEqual(clocks, [mod.formatClock(evening), mod.formatClock(morning)]);

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

test("strip with no tasks in the last 10 minutes is the caption only", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = worldModule(world);
  const now = 1_700_000_000_000;
  mod.seedActivity([
    {
      id: "oldtask1",
      instanceId: "i1",
      instanceName: "voice",
      modelId: "breeze",
      category: "tts",
      status: "DONE",
      createdAt: now - 30 * MIN,
      startedAt: now - 30 * MIN,
      finishedAt: now - 29 * MIN
    }
  ]);
  mod.renderActivity(now);
  assert.match(ui.strip.innerHTML, /act-strip-caption">Last 10 min</);
  assert.doesNotMatch(ui.strip.innerHTML, /<svg/);
  assert.doesNotMatch(ui.strip.innerHTML, /act-rect/);
  assert.match(ui.list.innerHTML, />voice</);
  assert.doesNotMatch(ui.strip.innerHTML, /style=/);
});

test("activity row grid keeps time, name, status, and duration in fixed columns", () => {
  const css = readWeb("style.css");
  assert.match(css, /\.activity-list\s*\{[^}]*display:\s*grid/);
  assert.match(css, /grid-template-columns:\s*5\.5ch\s+minmax\(0,\s*1fr\)/);
  assert.match(css, /\.act-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /\.act-time\s*\{[^}]*tabular-nums/);
  assert.match(css, /\.act-dur\s*\{[^}]*text-align:\s*right/);
  assert.match(css, /\.act-dur\s*\{[^}]*tabular-nums/);
  assert.match(css, /\.act-row\s*\{\s*display:\s*contents/);
});
