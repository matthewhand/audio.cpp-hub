/* web/modules/task-events.js — 任务生命周期 SSE（GET /api/events/stream）
 *
 * 轮询仍然是真相来源：这条流只用来更快地点亮「生成中…」，并在任务结束时
 * 立刻拉一次实例列表，让内存峰值跟上。EventSource 不存在、连接失败、
 * 服务端 503，都静默退回 2s 轮询（浏览器会自动重连，这里不弹 toast）。
 *
 * fan-out 不代理这条流；连到 fan-out 时这里会失败，实例列表照常轮询。 */

import { refreshInstances, renderInstanceList, updateInstanceBar } from "./instances.js";
import { generatingIds } from "./state.js";

/* running：taskId → instanceId。只在 task.started 登记，终态按 taskId 删除，
   这样「取消一条还在排队的任务」不会把同实例上仍在跑的那条误清掉。 */
export function reduceTaskEvents(running, name, data) {
  const next = { ...(running || {}) };
  const taskId = data && data.taskId;
  const instanceId = data && data.instanceId;
  if (name === "task.started") {
    if (taskId && instanceId) next[taskId] = instanceId;
    return next;
  }
  if (name === "task.finished" || name === "task.failed" || name === "task.cancelled") {
    if (taskId) delete next[taskId];
  }
  return next;
}

export function busyInstanceIds(running) {
  return new Set(Object.values(running || {}));
}

let runningTasks = {};

function syncGenerating(running) {
  const busy = busyInstanceIds(running);
  for (const id of [...generatingIds]) {
    if (!busy.has(id)) generatingIds.delete(id);
  }
  for (const id of busy) generatingIds.add(id);
}

const TERMINAL = new Set(["task.finished", "task.failed", "task.cancelled"]);

export function applyTaskEvent(name, data) {
  runningTasks = reduceTaskEvents(runningTasks, name, data || {});
  syncGenerating(runningTasks);
  renderInstanceList();
  updateInstanceBar();
  if (TERMINAL.has(name)) refreshInstances();
}

export function startTaskEvents() {
  if (typeof EventSource !== "function") return;
  let es;
  try {
    es = new EventSource("/api/events/stream");
  } catch {
    return;
  }
  const listen = (name) => {
    es.addEventListener(name, (e) => {
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      applyTaskEvent(name, data);
    });
  };
  listen("task.started");
  listen("task.finished");
  listen("task.failed");
  listen("task.cancelled");
  // 连接失败不提示：EventSource 自己会重连，2s 实例轮询保持界面正确。
  es.onerror = () => undefined;
}
