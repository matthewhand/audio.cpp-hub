/* web/modules/live-ticker.js — 合成按钮下方的实时状态行
 *
 * 概念稿里 Synthesize 按钮旁有一条状态行（「Streaming from breeze · RTF 1.18× ·
 * 3.2s」）。本模块是它的落地版，位置在 #tts-submit 下方（#tts-live），三态：
 *
 *   running   Streaming from <实例名> · RTF ~1.1× · 3.2s
 *                                        （耗时读 elapsed.js 的同一张表，
 *                                        由 instances.js 的唯一计时器重画；本模块不开第二个 interval）
 *   done      Done on <实例名> · 4.1s · RTF 1.18×
 *   failed    在 <实例名> 上失败 · <错误摘要>
 *   cancelled 已取消 <实例名> 上的任务
 *
 * 运行中的「~」是预估：同实例最近 ≤RTF_SAMPLE_CAP 条 DONE 任务的
 * (finishedAt − startedAt) ÷ result.durationSec 的中位数，一次 GET /api/tasks
 * 算出来，按实例 id 缓存、约 RTF_POLL_MS 才重算一次；这台实例还没有可用历史时
 * 整段省略。完成态换成精确值（墙上耗时 ÷ 音频时长，两位小数）。
 *
 * 数据来自两个既有来源：
 *   - SSE task.* 事件（web/modules/task-events.js）——起手最快，带 ts 与
 *     durationMs，但不带 result.durationSec；
 *   - 完成时补一次 GET /api/tasks/{id}（或随后的任务轮询）拿音频时长算 RTF。
 *     音频时长仍然未知就省略 RTF。SSE 不可用时任务轮询是唯一来源。
 *
 * 终态 20s 后自动清空（TICKER_IDLE_MS）。 */

import { $, Api, t } from "./dom.js";
import { clearTaskStart, rawStartMs, rememberStart, resetElapsed, taskStartMs } from "./elapsed.js";
import { formatBusyElapsed, instances, syncBusyTimer } from "./instances.js";
import { activeInstanceId } from "./state.js";

/* 终态展示时长：之后自动清空，不占着状态行 */
const TICKER_IDLE_MS = 20000;
/* 错误摘要截断长度：状态行只放一行，超长错误信息交给侧栏与 title */
const TICKER_ERROR_MAX = 60;
/* 运行中的 RTF 预估：只看最近这么多条同实例已完成任务 */
const RTF_SAMPLE_CAP = 10;
/* RTF 预估的拉取间隔：任务跑着的时候，最多每这么久重算一次 */
const RTF_POLL_MS = 30000;
/* RTF 预估缓存上限：按实例 id 缓存，实例数量有限，最旧的直接淘汰 */
const RTF_CACHE_KEEP = 8;

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

/* 预估 RTF 文案：一位小数 + 乘号（概念稿的「RTF ~1.1×」里的 1.1×），「~」由词典给。
   没有可用的中位数时返回空串。纯函数。 */
export function tickerRtfEstText(rtf) {
  if (!Number.isFinite(rtf) || rtf <= 0) return "";
  return rtf.toFixed(1) + "×";
}

/** 一条任务的 RTF：墙上秒 = (finishedAt − startedAt) / 1000。缺一侧就是 null（纯算术，不看状态）。纯函数。 */
export function taskRtf(task) {
  if (!task) return null;
  // null / undefined 的毫秒字段先转 NaN：JSON 里没跑过的任务 startedAt 就是 null
  const began = task.startedAt == null ? NaN : Number(task.startedAt);
  const end = task.finishedAt == null ? NaN : Number(task.finishedAt);
  if (!Number.isFinite(began) || !Number.isFinite(end) || end < began) return null;
  const audio = task.result ? Number(task.result.durationSec) : NaN;
  return tickerRtf((end - began) / 1000, audio);
}

/**
 * 同一个实例最近 ≤RTF_SAMPLE_CAP 条已完成（DONE）任务的 RTF 中位数。
 *
 * 只认 DONE：排队 / 运行中的任务还没有音频时长，失败与取消也不算「生成过」；
 * 别台实例的条目一律跳过。缺 startedAt / finishedAt / result.durationSec 的
 * 条目同样跳过（墙上一侧或音频一侧算不出来）。挑法是按 finishedAt 取最新的若干条
 * ——不是按 RTF 大小挑——再取平凡中位数，不做离群剔除。
 * 一条都算不出来 → null（调用方省略整段）。纯函数。
 * @param {any[]} tasks GET /api/tasks 的任务对象
 * @param {string} instanceId
 * @returns {number|null}
 */
export function medianRtf(tasks, instanceId) {
  const want = String(instanceId == null ? "" : instanceId);
  if (!want) return null;
  const recent = (Array.isArray(tasks) ? tasks : [])
    .filter(t => t && String(t.instanceId) === want && t.status === "DONE")
    .map(t => ({ at: Number(t.finishedAt), rtf: taskRtf(t) }))
    .filter(r => Number.isFinite(r.at) && r.at > 0 && Number.isFinite(r.rtf) && r.rtf > 0)
    .sort((a, b) => b.at - a.at) // 新的在前
    .slice(0, RTF_SAMPLE_CAP); // 只留最近 10 条
  if (!recent.length) return null;
  const rtfs = recent.map(r => r.rtf).sort((a, b) => a - b);
  const mid = rtfs.length >> 1;
  return rtfs.length % 2 ? rtfs[mid] : (rtfs[mid - 1] + rtfs[mid]) / 2;
}

/* 错误摘要：压掉换行/多余空白、截断加省略号。纯函数。 */
export function tickerErrorText(error, max) {
  const s = String(error == null ? "" : error).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const cap = Number(max) > 0 ? Number(max) : TICKER_ERROR_MAX;
  return s.length > cap ? s.slice(0, cap) + "…" : s;
}

/** Elapsed seconds for the running line. Never negative: a start stamp slightly ahead of local time reads 0. */
export function tickerElapsedSec(startMs, nowMs) {
  const start = Number(startMs);
  const now = Number(nowMs);
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(now)) return 0;
  return Math.max(0, (now - start) / 1000);
}

/**
 * 状态行文案 + 色调。纯函数，单测按 en / zh 两份词典跑。
 * @param {{phase?:string, name?:string,
 *          elapsedSec?:number, wallSec?:number, audioSec?:number, error?:string,
 *          rtfEstimate?:number|null}} input
 *        rtfEstimate 是同实例最近几条已完成任务的 RTF 中位数（运行中的预估，
 *        一位小数 + 「~」）；完成态的精确 RTF 用 wallSec / audioSec 现算（两位小数）。
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
    // 预估 RTF 放在实例名与计时之间：「Streaming from breeze · RTF ~1.1× · 3.2s」
    const estimate = tickerRtfEstText(input && input.rtfEstimate);
    if (elapsed && estimate) {
      return { text: t("ticker.runningRtf", { name, rtf: estimate, t: elapsed }), tone: "" };
    }
    if (estimate) return { text: t("ticker.runningRtfNoTime", { name, rtf: estimate }), tone: "" };
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

/* RTF 预估：选中实例最近若干条已完成任务的（墙上耗时 ÷ 音频时长）中位数。
   数据源是一次 GET /api/tasks（outputJSON 连 result 一起给），按实例 id 缓存
   {at, value}：at 是那次拉取的时间，value 是中位数、null = 这台还没有可用历史。
   拉取失败也记时间——否则接口一直失败时这里会跟着 2s 轮询每拍重试。 */
const rtfStats = new Map();
/* 在途的清单请求只允许一个：任务轮询与 SSE 可能在同一拍都触发渲染 */
let rtfLoading = false;
/* 上一次同步过的选中实例：换了选中实例就立刻补一次预估，不等任务开始 */
let rtfInstanceId = null;

/* 这台实例的 RTF 预估中位数；没有缓存 / 缓存是「无可用历史」时返回 null。 */
function rtfEstimateFor(instanceId) {
  if (instanceId == null) return null;
  const hit = rtfStats.get(String(instanceId));
  return hit && Number.isFinite(hit.value) ? hit.value : null;
}

function rememberRtf(instanceId, value) {
  const key = String(instanceId);
  rtfStats.delete(key); // 重新插入，让 Map 的迭代顺序等于「最近用过」顺序
  rtfStats.set(key, { at: Date.now(), value: Number.isFinite(value) ? value : null });
  while (rtfStats.size > RTF_CACHE_KEEP) {
    const oldest = rtfStats.keys().next().value;
    rtfStats.delete(oldest);
  }
}

/* 缓存过期就拉一次 GET /api/tasks 重算（单飞 + 频率上限 RTF_POLL_MS）。
   预估这一段是异步补上的：首帧照常画，结果回来后重画状态行。 */
function refreshRtfEstimate(instanceId) {
  if (instanceId == null || rtfLoading || !Api || typeof Api.get !== "function") return;
  const key = String(instanceId);
  const hit = rtfStats.get(key);
  if (hit && Date.now() - hit.at < RTF_POLL_MS) return;
  rtfLoading = true;
  Api.get("/api/tasks")
    .then((list) => rememberRtf(key, medianRtf(list, key)))
    .catch(() => rememberRtf(key, null))
    .then(() => {
      rtfLoading = false;
      renderLiveTicker();
    });
}

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function anchorFor(taskId, instanceId) {
  const byTask = taskId ? rawStartMs(taskId) : null;
  if (byTask != null) return byTask;
  return instanceId ? rawStartMs(instanceId) : null;
}

function shownFor(taskId, instanceId, now) {
  const byTask = taskId ? taskStartMs(taskId, now) : null;
  if (byTask != null) return byTask;
  return instanceId ? taskStartMs(instanceId, now) : null;
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
      rememberStart({ taskId: task.id, instanceId: task.instanceId }, {
        startedAt: task.status === "RUNNING" ? task.startedAt : null,
        now: Date.now()
      });
      return watch = {
        taskId: task.id, instanceId: task.instanceId, status: task.status,
        startedAt: anchorFor(task.id, task.instanceId),
        finishedAt: null, audioSec: null, error: ""
      };
    }
  }
  return null;
}

/* ---------- 渲染 ---------- */

/** 渲染状态行；没有要显示的内容时整行隐藏（不留空壳）。导出供语言切换时重画。 */
function paintRunningSpan(baseText, elapsedSec, raw) {
  const shown = formatBusyElapsed(elapsedSec);
  // 先清掉上一帧的片段，再写入。textContent 单独赋值会在清空和插入之间
  // 让共享计时器看不见节点。
  el.innerHTML = "";
  el.textContent = baseText + " · ";
  el.title = baseText + " · " + shown;
  const span = document.createElement("span");
  span.className = "badge-elapsed num";
  const id = watch.taskId || watch.instanceId;
  span.setAttribute("data-elapsed-id", String(id));
  span.setAttribute("data-start", String(raw));
  span.textContent = shown;
  el.appendChild(span);
}

export function renderLiveTicker() {
  if (!el) return;
  if (!watch) {
    clearIdleTimer();
    el.innerHTML = "";
    el.textContent = "";
    el.className = "live-ticker hidden";
    el.removeAttribute("title");
    syncBusyTimer();
    return;
  }
  const name = tickerInstanceName(watch, instances);
  const now = Date.now();
  const raw = anchorFor(watch.taskId, watch.instanceId) || finitePositive(watch.startedAt);
  const shownStart = shownFor(watch.taskId, watch.instanceId, now);
  const doneAt = Number(watch.finishedAt) || 0;
  const phase = watch.status === "FAILED" ? "failed"
    : watch.status === "CANCELLED" ? "cancelled"
      : watch.status === "RUNNING" || watch.status === "QUEUED" ? "running" : "done";
  // 运行中才要预估 RTF：选了新实例或缓存过期就补一次清单请求
  if (phase === "running") refreshRtfEstimate(watch.instanceId);
  // 运行中用表里钳过的起点（未来锚显示 0.0s，不把钳制写回表）。终态用墙上耗时。
  const elapsedSec = phase === "running"
    ? (shownStart != null ? (now - shownStart) / 1000 : NaN)
    : (doneAt && raw ? Math.max(0, (doneAt - raw) / 1000) : NaN);
  const wallSec = doneAt && raw ? (doneAt - raw) / 1000 : null;
  const input = {
    phase: /** @type {"running"|"done"|"failed"|"cancelled"} */ (phase),
    name,
    elapsedSec,
    wallSec,
    audioSec: watch.audioSec,
    rtfEstimate: phase === "running" ? rtfEstimateFor(watch.instanceId) : null,
    error: watch.error
  };
  const { text, tone } = liveTickerText(input);
  el.className = "live-ticker" + (tone ? " " + tone : "");
  el.title = text;
  // 运行中的数字放进 data-elapsed-id 片段，由 instances.js 的唯一计时器重画。
  // 本模块不再 setInterval。首帧就写入钳过的秒数，不等下一拍。
  if (input.phase === "running" && shownStart != null && raw) {
    // 前缀这一段不带计时（RTF 预估已经在里面），数字由共享计时器续写
    const base = liveTickerText({ ...input, elapsedSec: NaN });
    paintRunningSpan(base.text, elapsedSec, raw);
  } else {
    el.innerHTML = "";
    el.textContent = text;
  }
  syncBusyTimer();
}

function finitePositive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
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
  const running = task.status === "RUNNING" || task.status === "QUEUED";
  if (running) {
    // 只把服务端 startedAt（运行中）并进表。排队没有 startedAt，表里记下
    // 第一次看到的客户端时间，之后的轮询不会把它改晚。
    rememberStart({ taskId: task.id, instanceId: task.instanceId }, {
      startedAt: task.status === "RUNNING" ? task.startedAt : null,
      now: Date.now()
    });
  }
  if (task.instanceId !== activeInstanceId) {
    // 不是选中实例：正在关注的那条被换走就收起状态行。起点仍留给那张卡片。
    if (watch && watch.taskId === task.id) watch = null;
    renderLiveTicker();
    if (!running) clearTaskStart({ taskId: task.id, instanceId: task.instanceId });
    return;
  }
  if (running) {
    if (!watch || watch.taskId !== task.id) {
      watch = {
        taskId: task.id, instanceId: task.instanceId, status: task.status,
        startedAt: anchorFor(task.id, task.instanceId),
        finishedAt: null, audioSec: null, error: ""
      };
      clearIdleTimer();
    }
    watch.status = task.status;
    watch.startedAt = anchorFor(task.id, task.instanceId) || watch.startedAt;
  } else if (watch && watch.taskId === task.id) {
    // 终态：先读表里的起点算墙上耗时，再清表。页面加载时带出的历史任务不翻出来。
    watch.startedAt = anchorFor(task.id, task.instanceId) || watch.startedAt;
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
  if (!running) {
    clearTaskStart({ taskId: task.id, instanceId: task.instanceId });
    syncBusyTimer();
  }
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
  if (name === "task.queued" || name === "task.started") {
    if (!d.instanceId || d.instanceId !== activeInstanceId) return;
    const now = Date.now();
    rememberStart({ taskId: d.taskId, instanceId: d.instanceId }, {
      sseTs: name === "task.started" ? d.ts : null,
      live: name === "task.started",
      now
    });
    const status = name === "task.started" ? "RUNNING" : "QUEUED";
    // 排队事件不把正在跑的那条换成自己。
    if (status === "QUEUED" && watch && watch.status === "RUNNING" && watch.taskId !== d.taskId) return;
    watch = {
      taskId: d.taskId || null, instanceId: d.instanceId, status,
      startedAt: anchorFor(d.taskId, d.instanceId),
      finishedAt: null, audioSec: null, error: ""
    };
    clearIdleTimer();
    remember({
      id: d.taskId, instanceId: d.instanceId, status,
      startedAt: watch.startedAt, createdAt: watch.startedAt
    });
    renderLiveTicker();
    return;
  }
  if (name !== "task.finished" && name !== "task.failed" && name !== "task.cancelled") return;
  if (!d.taskId || !watch || d.taskId !== watch.taskId) return;
  watch.startedAt = anchorFor(watch.taskId, watch.instanceId) || watch.startedAt;
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
  // 换了选中实例就把预估的缓存目标换过去：这台没有新鲜缓存就立刻拉一次，
  // 任务真正开始时这一帧已经有中位数可用（列表刷新事件 2s 一次，不会重入）。
  if (rtfInstanceId !== activeInstanceId) {
    rtfInstanceId = activeInstanceId;
    refreshRtfEstimate(activeInstanceId);
  }
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
  rtfStats.clear();
  rtfLoading = false;
  rtfInstanceId = null;
  resetElapsed();
}
