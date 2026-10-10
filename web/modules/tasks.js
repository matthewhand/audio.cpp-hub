/* web/modules/tasks.js — 推理任务队列与结果落版
 *
 * 提交（POST /api/tasks）、2s 轮询跟踪、取消、完成后落地结果，
 * 以及侧栏里的任务行渲染（makeTaskRow / toggleTaskDetail）。
 * 任务视图缓存（activePolls / taskViews / taskDetails）在这里，因为只有本模块写。
 *
 * 结果落版（renderTaskResult / clearResult / makeTrackRow 与四类结果渲染）与队列放在一起：
 * 任务生命周期的终点就是「把结果画到面板上」，中间没有任何别的模块参与。
 * 本模块不认识面板表单，只按 category 分派到对应结果容器。
 *
 * 注意：任务完成要刷新操作历史侧栏（renderSidebarList / loadHistory），
 * 而侧栏的任务行又要用到本模块的取消与耗时，因此本模块与 sidebar.js 之间
 * 存在一处刻意的循环依赖——两边只在运行期回调里互相调用，模块求值期互不读取。 */

import { showToast } from "./async-ui.js";
import { $, Api, el, markRowEnter, t } from "./dom.js";
import { clearTaskStart, rememberStart } from "./elapsed.js";
import { refreshInstances, syncBusyTimer } from "./instances.js";
import { noteTtsTake, seedLastTake } from "./last-take.js";
import { noteTask } from "./live-ticker.js";
import { loadHistory, privacyOn, renderSidebarList } from "./sidebar.js";
import { activeInstanceId, noteIdleFallback, runningStarts, selectedModel } from "./state.js";

export const activePolls = new Map(); // taskId → Api.poll 句柄（stop() 即无定时器/无在途请求）
export const taskViews = new Map(); // taskId → 已知任务（进行中 + 已完成保留展示），供侧栏渲染
export const taskDetails = new Map(); // taskId → 已展开的完整结果文本（侧栏「详情」缓存，随任务记录清除）
export const TASK_VERB = { tts: "tts.verb", asr: "asr.verb", sep: "sep.verb", music: "music.verb", other: "other.verb" };

/* 实例卡片「生成中…」计时的兜底起点：RUNNING 的 startedAt 登记到
   state.runningStarts（SSE 不可用时 resolveBusy 用它），同时并进 elapsed.js
   的表。排队没有 startedAt，只记第一次的客户端时间。
   终态不在这里清表——live-ticker 的 noteTask 要先用起点算墙上耗时。
   一条 QUEUED 的轮询不得删掉同实例上另一条 RUNNING 的 runningStarts。 */
function noteTaskAnchor(task) {
  if (!task || !task.instanceId) return;
  if (task.status === "RUNNING" || task.status === "QUEUED") {
    if (task.status === "RUNNING" && task.startedAt) runningStarts.set(task.instanceId, task.startedAt);
    rememberStart({ taskId: task.id, instanceId: task.instanceId }, {
      startedAt: task.status === "RUNNING" ? task.startedAt : null,
      now: Date.now()
    });
    return;
  }
  // 终态：同实例上若还有另一条 RUNNING，保留它的 startedAt。
  let sibling = null;
  for (const other of taskViews.values()) {
    if (!other || other.id === task.id || other.instanceId !== task.instanceId) continue;
    if (other.status === "RUNNING" && other.startedAt) { sibling = other; break; }
  }
  if (sibling) runningStarts.set(task.instanceId, sibling.startedAt);
  else runningStarts.delete(task.instanceId);
}

export async function submitTask(req) {
  const task = await Api.post("/api/tasks", { instanceId: activeInstanceId, request: req });
  // 入队成功后立即刷新一次实例列表（不 await），卡片“工作中”徽标即时出现，不等 2s 轮询
  refreshInstances();
  return task;
}

/* 任务耗时：优先用后端 startedAt→finishedAt，进行中算到当前时刻 */
export function taskElapsed(task) {
  const end = task.finishedAt || Date.now();
  return ((end - (task.startedAt || task.createdAt)) / 1000).toFixed(1) + "s";
}

/* 取消任务：服务端置 CANCELLED，由轮询观察到终态后统一收尾（toast/侧栏刷新） */
export async function cancelTask(taskId) {
  try {
    await Api.del("/api/tasks/{id}", { params: { id: taskId } });
  } catch (e) {
    showToast("error", t("task.cancelFailed") + t("common.colon") + e.message);
  }
}

export function trackTask(task) {
  taskViews.set(task.id, task);
  noteTaskAnchor(task);
  // 首屏 / 模型切换重挂时就登记：等待本轮轮询回来之前状态行已经是新的
  noteTask(task);
  if (task.finishedAt && task.status !== "QUEUED" && task.status !== "RUNNING") {
    noteIdleFallback(task.instanceId, task.finishedAt);
  }
  renderSidebarList();
  if (activePolls.has(task.id)) return;
  if (task.status !== "QUEUED" && task.status !== "RUNNING") return;
  const isRunning = (cur) => cur.status === "QUEUED" || cur.status === "RUNNING";
  let handle = null; // 句柄在 poll() 返回后才有值；回调（微任务）触发时已赋值
  handle = Api.poll("/api/tasks/{id}", (cur) => {
    taskViews.set(cur.id, cur);
    noteTaskAnchor(cur);
    // 合成按钮下方的实时状态行：完整任务对象在这里最全（含 result.durationSec）
    noteTask(cur);
    if (cur.finishedAt && cur.status !== "QUEUED" && cur.status !== "RUNNING") {
      noteIdleFallback(cur.instanceId, cur.finishedAt);
    }
    renderSidebarList();
    if (!isRunning(cur)) {
      activePolls.delete(task.id);
      handle.stop();
      finishTask(cur);
    }
  }, {
    request: { params: { id: task.id } },
    onError: (e) => {
      if (e.status === 404) {
        // 任务记录已被淘汰/删除：停止轮询并移出侧栏
        handle.stop();
        activePolls.delete(task.id);
        const gone = taskViews.get(task.id);
        taskViews.delete(task.id);
        taskDetails.delete(task.id);
        if (gone && gone.instanceId) runningStarts.delete(gone.instanceId);
        clearTaskStart({ taskId: task.id, instanceId: gone && gone.instanceId });
        syncBusyTimer();
        renderSidebarList();
      }
      // 其余错误（网络抖动 / 5xx / 超时）视为瞬时，下轮再试
    }
  });
  activePolls.set(task.id, handle);
}

/* 任务终态：toast 汇报；任务模型当前选中时渲染结果与最终状态行 */
export function finishTask(task) {
  const verb = t(TASK_VERB[task.category] || "other.verb");
  const m = selectedModel();
  const current = m && m.id === task.modelId;
  const stats = current ? $(task.category + "-stats") : null;
  const msg = current ? $(task.category + "-msg") : null;
  if (task.status === "DONE") {
    showToast("info", t("common.doneElapsed", { verb, t: taskElapsed(task) }));
    if (stats) stats.textContent = t("common.doneElapsed", { verb, t: taskElapsed(task) });
    if (current) renderTaskResult(task);
  } else {
    const errText = task.status === "CANCELLED" ? t("task.cancelled") : task.error || t("task.failed");
    showToast("error", t("common.failedElapsed", { verb, t: taskElapsed(task), msg: errText }));
    if (msg) msg.textContent = t("common.failedElapsed", { verb, t: taskElapsed(task), msg: errText });
  }
  // 成功与失败后端都已写历史（TTS），刷新侧栏让其即时可见
  if (task.category === "tts") loadHistory();
}

/* 页面加载 / 模型切换后重挂当前模型的任务（含已完成记录；进行中的恢复轮询） */
export async function reattachTasks() {
  const m = selectedModel();
  if (!m) return;
  try {
    // 已有句柄的任务会被 trackTask 直接跳过，不会重复建轮询
    const tasks = await Api.list("/api/tasks", { query: { modelId: m.id } });
    // 刷新页面后仍能看到上一条录音：清单里最新的那条已完成 tts 就够了，
    // 不额外发请求（音频 URL 与 renderTaskResult 用的是同一个拼法）。
    seedLastTake(tasks);
    for (const task of tasks) trackTask(task);
  } catch (e) { /* 忽略：下次切换/轮询再试 */ }
}

export function makeTaskRow(task) {
  const row = el(`<div class="history-row task-row${task.status === "FAILED" ? " failed" : ""}">
    <div class="history-info">
      <span class="history-time"></span>
      <span class="history-text"></span>
      <span class="history-meta"></span>
      <span class="history-btns"></span>
    </div>
  </div>`);
  row.querySelector(".history-time").textContent = I18N.date(task.createdAt);
  const textEl = row.querySelector(".history-text");
  textEl.dataset.realText = task.text || "";
  textEl.textContent = privacyOn() && task.text ? t("history.masked") : task.text || t("history.noText");
  if (task.text && !privacyOn()) textEl.title = task.text;
  const meta = [];
  if (task.status === "QUEUED") {
    meta.push(t("task.queued") + (task.position > 0 ? t("task.queuedPos", { n: task.position }) : ""));
  } else if (task.status === "RUNNING") {
    meta.push(t("task.running") + " " + taskElapsed(task));
  } else if (task.status === "DONE") {
    meta.push(t("task.done") + " " + taskElapsed(task));
  } else if (task.status === "CANCELLED") {
    meta.push(t("task.cancelled"));
  } else {
    meta.push(t("task.failed"));
  }
  if (task.instanceName) meta.push(task.instanceName);
  row.querySelector(".history-meta").textContent = meta.join(" ｜ ");
  const btns = row.querySelector(".history-btns");
  if (task.status === "QUEUED" || task.status === "RUNNING") {
    const cancelBtn = el(`<button type="button" class="stop-btn"></button>`);
    cancelBtn.textContent = t("task.cancel");
    cancelBtn.onclick = () => cancelTask(task.id);
    btns.appendChild(cancelBtn);
  } else if (task.status === "DONE" && task.category !== "tts") {
    const loadBtn = el(`<button type="button"></button>`);
    loadBtn.textContent = t("history.load");
    loadBtn.onclick = () => renderTaskResult(task);
    btns.appendChild(loadBtn);
    const expanded = taskDetails.has(task.id);
    const detailBtn = el(`<button type="button"></button>`);
    detailBtn.textContent = expanded ? t("task.collapse") : t("task.detail");
    detailBtn.onclick = () => toggleTaskDetail(task);
    btns.appendChild(detailBtn);
    if (expanded) {
      // 展开态存于 taskDetails，轮询重渲染后仍保持展开；隐私模式下完整文本同样遮蔽
      const detail = el(`<div class="task-detail"></div>`);
      detail.textContent = privacyOn() ? t("history.masked") : taskDetails.get(task.id);
      row.appendChild(detail);
    }
  }
  if (task.status === "FAILED") {
    const err = el(`<div class="error-text history-error"></div>`);
    err.textContent = task.error || t("task.failed");
    if (task.error) err.title = task.error;
    row.appendChild(err);
  }
  return markRowEnter(row, "t:" + task.id);
}

/* 侧栏「详情」：拉取任务完整结果文本并在行内展开/收起（预览只截断 100 字，完整内容只能从这里看） */
export async function toggleTaskDetail(task) {
  if (taskDetails.has(task.id)) {
    taskDetails.delete(task.id);
    renderSidebarList();
    return;
  }
  try {
    const json = await Api.get("/api/tasks/{id}/result", { params: { id: task.id } });
    if (typeof json.text !== "string" || !json.text) {
      showToast("info", t("task.noDetail"));
      return;
    }
    taskDetails.set(task.id, json.text);
    renderSidebarList();
  } catch (e) {
    showToast("error", t("task.resultFailed") + t("common.colon") + e.message);
  }
}

/* ---------- 结果落版 ---------- */

/* DONE 结果渲染：TTS 直接引用历史 wav URL（不碰 base64）；其余拉取 /result JSON 走原渲染分支 */
export async function renderTaskResult(task) {
  if (task.category === "tts") {
    const url = "/api/history/" + task.modelId + "/" + task.id + "/audio";
    $("tts-player").src = url;
    const download = $("tts-download");
    download.href = url;
    download.download = "tts-" + task.id + ".wav";
    $("tts-result").classList.remove("hidden");
    // 同一行 URL 交给「上一条录音」条：它复用这里的结果，不另发请求
    noteTtsTake(task);
    return;
  }
  try {
    const json = await Api.get("/api/tasks/{id}/result", { params: { id: task.id } });
    if (task.category === "asr") renderAsrResult(json);
    else if (task.category === "sep") renderSepResult(json);
    else if (task.category === "music") renderMusicResult(json);
    else renderOtherResult(json);
  } catch (e) {
    const msg = $(task.category + "-msg");
    if (msg) msg.textContent = t("task.resultFailed") + t("common.colon") + e.message;
  }
}

function b64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function makeTrackRow(name, b64) {
  const url = URL.createObjectURL(b64ToBlob(b64, "audio/wav"));
  const row = el(`<div class="track-row">
    <span class="track-name"></span>
    <audio controls preload="auto"></audio>
    <a class="btn-ghost"></a>
  </div>`);
  row.dataset.blobUrl = url;
  row.querySelector(".track-name").textContent = name;
  row.querySelector("audio").setAttribute("aria-label", name);
  row.querySelector("audio").src = url;
  const a = row.querySelector("a");
  a.textContent = t("common.download");
  a.href = url;
  a.download = name + ".wav";
  return row;
}

/* 清空结果容器前回收其中 track-row 的 objectURL，避免内存泄漏 */
export function clearResult(container) {
  for (const row of container.querySelectorAll(".track-row[data-blob-url]")) {
    URL.revokeObjectURL(row.dataset.blobUrl);
  }
  container.innerHTML = "";
}

/* ASR 结果渲染（任务完成后由 renderTaskResult 调用） */
function renderAsrResult(json) {
  $("asr-text").textContent = json.text || t("asr.noText");
  const details = {};
  for (const k of ["language", "words", "segments", "speaker_turns", "timing"]) {
    if (json[k] !== undefined) details[k] = json[k];
  }
  const det = $("asr-json-details");
  if (Object.keys(details).length > 0) {
    $("asr-json").textContent = JSON.stringify(details, null, 2);
    det.classList.remove("hidden");
  } else {
    det.classList.add("hidden");
  }
  $("asr-result").classList.remove("hidden");
}

/* SEP 结果渲染（任务完成后由 renderTaskResult 调用） */
function renderSepResult(json) {
  const result = $("sep-result");
  // 重渲染前先回收上一轮的 objectURL，避免重复行与内存泄漏
  clearResult(result);
  if (json.named_audio_outputs && json.named_audio_outputs.length > 0) {
    for (const track of json.named_audio_outputs) {
      result.appendChild(makeTrackRow(track.id, track.audio));
    }
  } else if (json.audio) {
    result.appendChild(makeTrackRow("output", json.audio));
  } else {
    $("sep-msg").textContent = t("sep.noTracks") + JSON.stringify(json).substring(0, 300);
  }
}

/* 音乐结果：JSON 含 base64 wav 与 timing（wall_ms / audio_duration_ms / rtf） */
function renderMusicResult(json) {
  const out = $("music-result");
  clearResult(out);
  if (json.audio) {
    out.appendChild(makeTrackRow("music", json.audio));
    const timing = json.timing;
    if (timing) {
      const line = el(`<div class="hint music-timing"></div>`);
      line.textContent = t("music.timingLine", {
        wall: ((timing.wall_ms || 0) / 1000).toFixed(1) + "s",
        dur: ((timing.audio_duration_ms || 0) / 1000).toFixed(1) + "s",
        rtf: timing.rtf != null ? Number(timing.rtf).toFixed(2) : "?"
      });
      out.appendChild(line);
    }
  } else {
    $("music-msg").textContent = t("music.noAudio") + JSON.stringify(json).substring(0, 300);
  }
}

/* OTHER 结果渲染（任务完成后由 renderTaskResult 调用） */
function renderOtherResult(json) {
  const out = $("other-result");
  // 同上：先清空并回收 objectURL，避免「载入」重复追加
  clearResult(out);
  if (json.named_audio_outputs && json.named_audio_outputs.length > 0) {
    for (const track of json.named_audio_outputs) {
      out.appendChild(makeTrackRow(track.id, track.audio));
    }
  }
  if (json.audio) {
    out.appendChild(makeTrackRow("output", json.audio));
  }
  // JSON 摘要（剔除巨大的 base64 字段）
  const summary = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === "audio") continue;
    if (k === "named_audio_outputs") {
      summary[k] = v.map(tr => ({ id: tr.id, sample_rate: tr.sample_rate, channels: tr.channels }));
      continue;
    }
    summary[k] = v;
  }
  if (Object.keys(summary).length > 0 || (!json.audio && !json.named_audio_outputs)) {
    const pre = el(`<pre class="json-pre"></pre>`);
    pre.textContent = JSON.stringify(summary, null, 2);
    out.appendChild(pre);
  }
}
