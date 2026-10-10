/* web/modules/task-events.js — 任务生命周期 SSE（GET /api/events/stream）
 *
 * 轮询仍然是真相来源：这条流只用来更快地点亮「生成中…」，并在任务结束时
 * 立刻拉一次实例列表，让内存峰值跟上。EventSource 不存在、连接失败、
 * 服务端 503，都静默退回 2s 轮询（浏览器会自动重连，这里不弹 toast）。
 *
 * fan-out 不代理这条流；连到 fan-out 时这里会失败，实例列表照常轮询。
 *
 * 同一个连接还驱动左栏「Instances」标题行的那颗小灯（#live-events）：连上并
 * 收到 hello 是「Live events」，否则「Polling」——用户能直接看出当前是推送
 * 还是在轮询，不需要懂 SSE。 */

import { $, t } from "./dom.js";
import { clearTaskStart, rememberStart } from "./elapsed.js";
import { refreshInstances, renderInstanceList, syncBusyTimer, updateInstanceBar } from "./instances.js";
import { noteTaskEvent } from "./live-ticker.js";
import { busyStarts } from "./state.js";

/**
 * 「实时事件」指示灯的状态。纯函数：连上并且已经收到过至少一个事件（hello
 * 或任何 task.*）才算「实时」——只连上还没收到东西时按轮询算，
 * 避免连接刚建立就宣称实时。
 * @param {{connected:boolean, sawEvent:boolean}} flags
 * @returns {"live"|"poll"}
 */
export function liveEventsMode(flags) {
  return flags && flags.connected && flags.sawEvent ? "live" : "poll";
}

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

function publishTask(name, data) {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("hub-task-event", { detail: { name, data: data || {} } }));
}

export function applyTaskEvent(name, data) {
  const d = data || {};
  runningTasks = reduceTaskEvents(runningTasks, name, d);
  syncGenerating(runningTasks);
  if (name === "task.queued" || name === "task.started") {
    rememberStart({ taskId: d.taskId, instanceId: d.instanceId }, {
      sseTs: name === "task.started" ? d.ts : null,
      live: name === "task.started",
      now: Date.now()
    });
  }
  renderInstanceList();
  updateInstanceBar();
  // 合成按钮下方的实时状态行（选中实例上的任务）。终态要先读起点再清表。
  noteTaskEvent(name, d);
  if (TERMINAL.has(name)) {
    clearTaskStart({ taskId: d.taskId, instanceId: d.instanceId });
    syncBusyTimer();
  }
  // 最近活动时间线只听这个事件，避免 task-events ↔ activity 成环。
  publishTask(name, d);
  if (TERMINAL.has(name)) refreshInstances();
}

/* ---------- 「实时事件 / 轮询」指示灯 ---------- */

let sseConnected = false;
let sseSawEvent = false;

/* 按当前连接状态重画指示灯（文案与点的颜色都在 style.css 里按 data-mode 分）。
   元素在函数里取：语言切换会再画一次，模块求值时也不依赖 DOM（单测加载本文件）。 */
/** True once the SSE stream is up and has delivered at least one event. */
export function isTaskStreamLive() {
  return liveEventsMode({ connected: sseConnected, sawEvent: sseSawEvent }) === "live";
}

function publishStream() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent("hub-task-stream", { detail: { live: isTaskStreamLive() } }));
}

export function renderLiveEvents() {
  const liveEl = $("live-events");
  publishStream();
  if (!liveEl) return;
  const mode = liveEventsMode({ connected: sseConnected, sawEvent: sseSawEvent });
  liveEl.dataset.mode = mode;
  const text = $("live-events-text");
  if (text) text.textContent = t(mode === "live" ? "live.on" : "live.off");
  liveEl.setAttribute("aria-label", t(mode === "live" ? "live.ariaOn" : "live.ariaOff"));
}

export function startTaskEvents() {
  renderLiveEvents();
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
      sseSawEvent = true; // 收到事件即证明流是通的（hello 不到也算）
      applyTaskEvent(name, data);
      renderLiveEvents();
    });
  };
  // hello：连接建立后服务端第一帧，确认流真的在推东西
  es.addEventListener("hello", () => {
    sseSawEvent = true;
    renderLiveEvents();
  });
  listen("task.queued");
  listen("task.started");
  listen("task.finished");
  listen("task.failed");
  listen("task.cancelled");
  es.onopen = () => {
    sseConnected = true;
    renderLiveEvents();
  };
  // 连接失败不提示：EventSource 自己会重连，2s 实例轮询保持界面正确。
  // 同时清掉 SSE 侧的忙碌表——任务可能已经在流断掉期间结束了，
  // 留着会让「生成中…」永远亮着（busy 判定此后整体回退到轮询数据）。
  // 指示灯同步退回「Polling」，并把「收到过事件」的标志一起清掉。
  es.onerror = () => {
    sseConnected = false;
    sseSawEvent = false;
    runningTasks = {};
    syncGenerating(runningTasks);
    renderInstanceList();
    updateInstanceBar();
    renderLiveEvents();
  };
}
