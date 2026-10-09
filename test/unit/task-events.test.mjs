/* 任务推送归约：事件 → 仍在生成的实例集合。
   按 taskId 记账，取消一条排队任务不会清掉同实例上还在跑的那条。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEsModule } from "./helpers/vm.mjs";

const { reduceTaskEvents, busyInstanceIds, liveEventsMode } = loadEsModule("modules/task-events.js");

function busy(running) {
  return [...busyInstanceIds(running)].sort();
}

test("reduceTaskEvents tracks started tasks and clears them on terminal events", () => {
  let running = {};
  running = reduceTaskEvents(running, "task.started", { taskId: "a", instanceId: "inst-1" });
  running = reduceTaskEvents(running, "task.started", { taskId: "b", instanceId: "inst-2" });
  assert.deepEqual(busy(running), ["inst-1", "inst-2"]);

  running = reduceTaskEvents(running, "task.finished", { taskId: "a", instanceId: "inst-1" });
  assert.deepEqual(busy(running), ["inst-2"]);

  running = reduceTaskEvents(running, "task.failed", { taskId: "b", instanceId: "inst-2" });
  assert.deepEqual(busy(running), []);
});

test("cancelling a different task does not clear a still-running one", () => {
  let running = reduceTaskEvents({}, "task.started", { taskId: "run", instanceId: "inst-1" });
  running = reduceTaskEvents(running, "task.cancelled", { taskId: "queued", instanceId: "inst-1" });
  assert.deepEqual(busy(running), ["inst-1"]);
  running = reduceTaskEvents(running, "task.cancelled", { taskId: "run", instanceId: "inst-1" });
  assert.deepEqual(busy(running), []);
});

test("queued and unknown events do not mark an instance busy", () => {
  const running = reduceTaskEvents({}, "task.queued", { taskId: "q", instanceId: "inst-1" });
  assert.deepEqual(busy(running), []);
  assert.deepEqual(busy(reduceTaskEvents(running, "instance.memory", { instanceId: "inst-1" })), []);
  assert.deepEqual(busy(reduceTaskEvents(null, "task.started", {})), []);
});

test("task.started 记下 ts 作为卡片计时起点（没有 ts 记 null）", () => {
  let running = reduceTaskEvents(
    {},
    "task.started",
    { taskId: "a", instanceId: "inst-1", ts: 1756400000000 }
  );
  assert.equal(running.a.startMs, 1756400000000);
  running = reduceTaskEvents(running, "task.started", { taskId: "b", instanceId: "inst-2" });
  assert.equal(running.b.startMs, null);
  // 计时起点缺失不影响忙碌集合本身
  assert.deepEqual(busy(running), ["inst-1", "inst-2"]);
  running = reduceTaskEvents(running, "task.finished", { taskId: "a" });
  assert.equal(running.a, undefined);
});

test("liveEventsMode：连上并且收到过事件才算实时，否则轮询", () => {
  assert.equal(liveEventsMode({ connected: true, sawEvent: true }), "live");
  assert.equal(liveEventsMode({ connected: true, sawEvent: false }), "poll");
  assert.equal(liveEventsMode({ connected: false, sawEvent: true }), "poll");
  assert.equal(liveEventsMode(null), "poll");
  assert.equal(liveEventsMode(undefined), "poll");
});
