/* web/modules/live-ticker.js — 合成按钮下方的实时状态行
 *
 * 概念稿里 Synthesize 按钮旁有一条状态行（「Streaming from breeze · RTF 1.18× ·
 * 3.2s」）。本模块是它的落地版，位置在 #tts-submit 下方（#tts-live），三态：
 *
 *   running   Streaming from <实例名> · 3.2s   （耗时与卡片徽标共用同一个定时器）
 *   done      Done on <实例名> · 4.1s · RTF 1.18×
 *   failed    在 <实例名> 上失败 · <错误摘要>
 *   cancelled 已取消 <实例名> 上的任务
 *
 * 数据来自两个既有来源：
 *   - SSE task.* 事件（web/modules/task-events.js）——起手最快，带 ts 与
 *     durationMs，但不带 result.durationSec；
 *   - 完成时补一次 GET /api/tasks/{id}（或随后的任务轮询）拿音频时长算 RTF。
 *     音频时长仍然未知就省略 RTF。SSE 不可用时任务轮询是唯一来源。
 *
 * 终态 20s 后自动清空（TICKER_IDLE_MS）。 */

import { $, Api, t } from "./dom.js";
import { formatBusyElapsed, instances, syncBusyTimer } from "./instances.js";
import { activeInstanceId } from "./state.js";

/* 终态展示时长：之后自动清空，不占着状态行 */
const TICKER_IDLE_MS = 20000;
/* 错误摘要截断长度：状态行只放一行，超长错误信息交给侧栏与 title */
const TICKER_ERROR_MAX = 60;

/* ---------- 纯函数：文案 ---------- */

/* 选中实例的名字：任务对象自带的 instanceName 优先，其次实例列表，最后 #id */
export function tickerInstanceName(task, list) {
  const byTask = task && typeof task.instanceName === "string" ? task.instanceName.trim() : "";
  if (byTask) return byTask;
  const id = task && task.instanceId;
  const hit = (Array.isArray(list) ? list : []).find(i => i && i.id === id);
  return (hit && (hit.instanceName || hit.modelId)) || (id ? "#" + id : "");
}

/* RTF = 墙上耗时 ÷ 音频时长。任一侧未知 / 非正数 → null（调用方省略这一段）。纯函数。 */
export function tickerRtf(wallSec, audioSec) {
  const wall = Number(wallSec), audio = Number(audioSec);
  if (!Number.isFinite(wall) || !Number.isFinite(audio) || wall <= 0 || audio <= 0) return null;
  return wall / audio;
}

/* RTF 文案：两位小数 + 乘号（概念稿的 1.18×）。纯函数。 */
export function tickerRtfText(rtf) {
  if (!Number.isFinite(rtf) || rtf <= 0) return "";
  return rtf.toFixed(2) + "×";
}

/* 错误摘要：压掉换行/多余空白、截断加省略号。纯函数。 */
export function tickerErrorText(error, max) {
  const s = String(error == null ? "" : error).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const cap = Number(max) > 0 ? Number(max) : TICKER_ERROR_MAX;
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/**
 * 状态行文案 + 色调。纯函数，单测按 en / zh 两份词典跑。
 * @param {{phase?:string, name?:string,
 *          elapsedSec?:number, wallSec?:number, audioSec?:number, error?:string}} input
 * @returns {{text:string, tone:""|"ok"|"danger"}}
 */
export function liveTickerText(input) {
  const name = (input && input.name) || "?";
  const phase = input && input.phase;
  if (phase === "failed") {
    const error = tickerErrorText(input.error);
    return {
      text: error ? t("ticker.failed", { name, error }) : t("ticker.failedBare", { name }),
      tone: "danger"
    };
  }
  if (phase === "cancelled") {
    return { text: t("ticker.cancelled", { name }), tone: "" };
  }
  const elapsed = input && Number.isFinite(input.elapsedSec) ? formatBusyElapsed(input.elapsedSec) : "";
  if (phase !== "done") {
    return elapsed
      ? { text: t("ticker.running", { name, t: elapsed }), tone: "" }
      : { text: t("ticker.runningNoTime", { name }), tone: "" };
  }
  const rtf = tickerRtfText(tickerRtf(input.wallSec, input.audioSec));
  if (elapsed && rtf) return { text: t("ticker.doneRtf", { name, t: elapsed, rtf }), tone: "ok" };
  if (elapsed) return { text: t("ticker.done", { name, t: elapsed }), tone: "ok" };
  if (rtf) return { text: t("ticker.doneRtfOnly", { name, rtf }), tone: "ok" };
  return { text: t("ticker.doneNoTime", { name }), tone: "ok" };
}

/* ---------- 模块状态 ---------- */

const el = $("tts-live");
/* 正在关注的任务：只报告「选中实例」上的那一条（同实例任务串行，最多一条在跑）。
   taskId / instanceId / status 与任务对象一致；startedAt / finishedAt 毫秒或 null；
   audioSec 音频时长（RTF 用，未知为 null）；error 失败摘要。 */
let watch = null;
let idleTimer = null;

/* 已知任务（tasks.js 每拍喂一次）：在切换选中实例 / 语言切换后重新定位
   「选中实例上正在跑的那条」，不必再发请求。 */
const knownTasks = new Map();
const KNOWN_TASKS_KEEP = 20;

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleClear() {
  clearIdleTimer();
  idleTimer = setTimeout(() => { idleTimer = null; watch = null; renderLiveTicker(); }, TICKER_IDLE_MS);
}

function remember(task) {
  if (!task || !task.id) return;
  knownTasks.set(task.id, task);
  while (knownTasks.size > KNOWN_TASKS_KEEP) {
    const oldest = knownTasks.keys().next().value;
    if (oldest === (watch && watch.taskId)) break; // 别把正在关注的那条挤掉
    knownTasks.delete(oldest);
  }
}

/* 选中实例上「正在跑」的任务（没有主动关注的对象时认领它） */
function adoptActiveTask() {
  for (const task of knownTasks.values()) {
    if (task.instanceId === activeInstanceId && (task.status === "RUNNING" || task.status === "QUEUED")) {
      return watch = {
        taskId: task.id, instanceId: task.instanceId, status: task.status,
        startedAt: Number(task.startedAt) || Number(task.createdAt) || null,
        startFromSse: false,
        finishedAt: null, audioSec: null, error: ""
      };
    }
  }
  return null;
}

/* ---------- 渲染 ---------- */

/** 渲染状态行；没有要显示的内容时整行隐藏（不留空壳）。导出供语言切换时重画。 */
export function renderLiveTicker() {
  if (!el) return;
  if (!watch) {
    clearIdleTimer();
    el.textContent = "";
    el.className = "live-ticker hidden";
    el.removeAttribute("title");
    syncBusyTimer();
    return;
  }
  const name = tickerInstanceName(watch, instances);
  const started = Number(watch.startedAt) || 0;
  const doneAt = Number(watch.finishedAt) || 0;
  // 运行中算到当前时刻；终态用 finishedAt - startedAt（墙上耗时）
  const elapsedSec = started ? ((doneAt || Date.now()) - started) / 1000 : NaN;
  const wallSec = doneAt && started ? (doneAt - started) / 1000 : null;
  const phase = watch.status === "FAILED" ? "failed"
    : watch.status === "CANCELLED" ? "cancelled"
      : watch.status === "RUNNING" || watch.status === "QUEUED" ? "running" : "done";
  const input = {
    phase: /** @type {"running"|"done"|"failed"|"cancelled"} */ (phase),
    name,
    elapsedSec,
    wallSec,
    audioSec: watch.audioSec,
    error: watch.error
  };
  const { text, tone } = liveTickerText(input);
  el.className = "live-ticker" + (tone ? " " + tone : "");
  el.title = text;
  // 运行中的耗时只放一个 data-start 片段，交给卡片徽标共用的定时器。
  // 纯函数文案里已经含有当前秒数；若再拼进 innerHTML 会变成「3.2s 3.2s」，
  // 而且后半段才在跳。这里用「不含时间的句子 + · + 片段」。
  if (input.phase === "running" && started) {
    const base = liveTickerText({ ...input, elapsedSec: NaN });
    el.textContent = base.text + " · ";
    const span = document.createElement("span");
    span.className = "badge-elapsed num";
    span.dataset.start = String(started);
    span.textContent = formatBusyElapsed((Date.now() - started) / 1000);
    el.appendChild(span);
  } else {
    el.textContent = text;
  }
  syncBusyTimer();
}

/* ---------- 入口：任务轮询与 SSE ---------- */

/**
 * tasks.js 的轮询每拍调用一次：完整任务对象（含 result.durationSec）。
 * 终态任务用来补齐 RTF 所需的音频时长。
 * @param {any} task GET /api/tasks/{id} 的任务对象
 */
export function noteTask(task) {
  if (!task || !task.id) return;
  remember(task);
  if (task.instanceId !== activeInstanceId) {
    // 不是选中实例：正在关注的那条被换走就收起状态行
    if (watch && watch.taskId === task.id) watch = null;
    renderLiveTicker();
    return;
  }
  const running = task.status === "RUNNING" || task.status === "QUEUED";
  if (running) {
    if (!watch || watch.taskId !== task.id) {
      watch = {
        taskId: task.id, instanceId: task.instanceId, status: task.status,
        startedAt: null, finishedAt: null, audioSec: null, error: "",
        startFromSse: false
      };
      clearIdleTimer();
    }
    // SSE task.started 的 ts 优先（规范：有推送起点就用它）；没有 ts 时才用轮询的 startedAt。
    if (!watch.startFromSse) {
      watch.startedAt = Number(task.startedAt) || Number(task.createdAt) || watch.startedAt;
    }
    watch.status = task.status;
  } else if (watch && watch.taskId === task.id) {
    // 终态：只汇报状态行正在关注的那条。页面加载时带出的历史任务不翻出来。
    watch.status = task.status;
    watch.finishedAt = Number(task.finishedAt) || null;
    const res = task.result && typeof task.result === "object" ? task.result : {};
    watch.audioSec = Number.isFinite(Number(res.durationSec)) && Number(res.durationSec) > 0
      ? Number(res.durationSec)
      : null;
    watch.error = task.error || "";
    scheduleIdleClear();
  }
  renderLiveTicker();
}

/**
 * SSE 事件入口（task-events.js 每收到一条 task.* 就调一次）。
 * task.started 带 ts（计时起点）；终态带 durationMs 与 error，但不带音频时长，
 * RTF 由随后 2s 内的任务轮询（noteTask）补齐。
 * @param {string} name task.started / task.finished / task.failed / task.cancelled
 * @param {any} data 事件 payload
 */
export function noteTaskEvent(name, data) {
  const d = data || {};
  if (name === "task.started") {
    if (!d.instanceId || d.instanceId !== activeInstanceId) return;
    const ts = Number(d.ts);
    const hasTs = Number.isFinite(ts) && ts > 0;
    watch = {
      taskId: d.taskId || null, instanceId: d.instanceId, status: "RUNNING",
      startedAt: hasTs ? ts : null,
      startFromSse: hasTs,
      finishedAt: null, audioSec: null, error: ""
    };
    clearIdleTimer();
    // 记一份占位任务，任务轮询的完整对象到了会覆盖它（用于补齐 RTF）
    remember({ id: d.taskId, instanceId: d.instanceId, status: "RUNNING", startedAt: watch.startedAt, createdAt: watch.startedAt });
    renderLiveTicker();
    return;
  }
  if (name !== "task.finished" && name !== "task.failed" && name !== "task.cancelled") return;
  if (!d.taskId || !watch || d.taskId !== watch.taskId) return;
  watch.status = name === "task.failed" ? "FAILED" : name === "task.cancelled" ? "CANCELLED" : "DONE";
  const dur = Number(d.durationMs);
  if (Number.isFinite(dur) && dur >= 0 && watch.startedAt) watch.finishedAt = watch.startedAt + dur;
  watch.error = d.error || "";
  scheduleIdleClear();
  renderLiveTicker();
  // task.finished 的 SSE 载荷没有 result.durationSec。完成且还不知道音频时长时
  // 拉一次任务详情；失败 / 取消不算 RTF。轮询若已经写过 audioSec 就不再请求。
  if (name === "task.finished" && watch.audioSec == null) pullDuration(watch.taskId);
}

/* 完成瞬间补音频时长。只认仍在关注的那条任务。 */
function pullDuration(taskId) {
  if (!taskId || !Api || typeof Api.get !== "function") return;
  Api.get("/api/tasks/{id}", { params: { id: taskId } }).then((task) => {
    if (!watch || watch.taskId !== taskId) return;
    const res = task && task.result && typeof task.result === "object" ? task.result : {};
    const sec = Number(res.durationSec);
    if (Number.isFinite(sec) && sec > 0) watch.audioSec = sec;
    if (!watch.finishedAt) {
      const fin = Number(task && task.finishedAt);
      if (Number.isFinite(fin) && fin > 0) watch.finishedAt = fin;
    }
    renderLiveTicker();
  }).catch(() => {});
}

/* 选中实例换了 / 实例列表刷新后重新定位（两个信号都由 instances.js 广播） */
function resync() {
  // 换了选中实例：状态行只描述当前选中的那一台，旧任务的终态不再挂着。
  if (watch && watch.instanceId !== activeInstanceId) {
    watch = null;
    clearIdleTimer();
  }
  if (!watch) adoptActiveTask();
  renderLiveTicker();
}

/** 由 web/app.js 在启动时调用一次。 */
export function startLiveTicker() {
  if (typeof window === "undefined" || !window.addEventListener) return;
  window.addEventListener("hub-active-instance", resync);
  window.addEventListener("hub-instances-updated", resync);
  renderLiveTicker();
}

/* 仅供测试复位模块状态用（生产路径不会调用）。 */
export function resetLiveTicker() {
  clearIdleTimer();
  watch = null;
  knownTasks.clear();
}
