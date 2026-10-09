/* web/modules/task-events.js — 任务生命周期 SSE（GET /api/events/stream）
 *
 * 轮询仍然是真相来源：这条流只用来更快地点亮「生成中…」，并在任务结束时
 * 立刻拉一次实例列表，让内存峰值跟上。EventSource 不存在、连接失败、
 * 服务端 503，都静默退回 2s 轮询（浏览器会自动重连，这里不弹 toast）。
 *
 * fan-out 不代理这条流；连到 fan-out 时这里会失败，实例列表照常轮询。 */

import { refreshInstances, renderInstanceList, updateInstanceBar } from "./instances.js";
import { busyStarts } from "./state.js";

/* running：taskId → {instanceId, startMs}。只在 task.started 登记，终态按 taskId 删除，
   这样「取消一条还在排队的任务」不会把同实例上仍在跑的那条误清掉。
   startMs 是 task.started 的 ts：实例卡片上的「生成中…」计时用它当起点，
   事件没带 ts 时记 null（计时省略，徽标照常显示）。 */
export function reduceTaskEvents(running, name, data) {
  const next = { ...(running || {}) };
  const taskId = data && data.taskId;
  const instanceId = data && data.instanceId;
  if (name === "task.started") {
    if (taskId && instanceId) next[taskId] = { instanceId, startMs: tsOf(data) };
    return next;
  }
  if (name === "task.finished" || name === "task.failed" || name === "task.cancelled") {
    if (taskId) delete next[taskId];
  }
  return next;
}

function tsOf(data) {
  const ts = Number(data && data.ts);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

export function busyInstanceIds(running) {
  const out = new Set();
  for (const v of Object.values(running || {})) {
    if (v && v.instanceId) out.add(v.instanceId);
  }
  return out;
}

let runningTasks = {};

/* SSE 侧的忙碌表：busyStarts 与 runningTasks 同源（同一次归约填两份），
   instances.js 只读前者，避免为了一个 Set 把整张 running 表导出。 */
function syncGenerating(running) {
  const busy = busyInstanceIds(running);
  for (const id of [...busyStarts.keys()]) {
    if (!busy.has(id)) busyStarts.delete(id);
  }
  for (const v of Object.values(running)) {
    if (v && v.instanceId && !busyStarts.has(v.instanceId)) busyStarts.set(v.instanceId, v.startMs);
  }
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
  // 同时清掉 SSE 侧的忙碌表——任务可能已经在流断掉期间结束了，
  // 留着会让「生成中…」永远亮着（busy 判定此后整体回退到轮询数据）。
  es.onerror = () => {
    runningTasks = {};
    syncGenerating(runningTasks);
    renderInstanceList();
    updateInstanceBar();
  };
}
