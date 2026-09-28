/* web/modules/tasks.js — 推理任务队列
 *
 * 提交（POST /api/tasks）、2s 轮询跟踪、取消、完成后落地结果，
 * 以及侧栏里的任务行渲染（makeTaskRow / toggleTaskDetail）。
 * 任务视图缓存（activePolls / taskViews / taskDetails）在这里，因为只有本模块写。
 *
 * 注意：任务完成要刷新操作历史侧栏（renderSidebarList / loadHistory），
 * 而侧栏的任务行又要用到本模块的取消与耗时，因此本模块与 sidebar.js 之间
 * 存在一处刻意的循环依赖——两边只在运行期回调里互相调用，模块求值期互不读取。 */

import { Api } from "./api.js";
import { showToast } from "./async-ui.js";
import { $, el, markRowEnter } from "./dom.js";
import { t } from "./i18n-bridge.js";
import { refreshInstances } from "./instances.js";
import { renderTaskResult } from "./results.js";
import { loadHistory, privacyOn, renderSidebarList } from "./sidebar.js";
import { activeInstanceId, selectedModel } from "./state.js";

export const activePolls = new Map(); // taskId → Api.poll 句柄（stop() 即无定时器/无在途请求）
export const taskViews = new Map(); // taskId → 已知任务（进行中 + 已完成保留展示），供侧栏渲染
export const taskDetails = new Map(); // taskId → 已展开的完整结果文本（侧栏「详情」缓存，随任务记录清除）
export const TASK_VERB = { tts: "tts.verb", asr: "asr.verb", sep: "sep.verb", music: "music.verb", other: "other.verb" };

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
  renderSidebarList();
  if (activePolls.has(task.id)) return;
  if (task.status !== "QUEUED" && task.status !== "RUNNING") return;
  const isRunning = (cur) => cur.status === "QUEUED" || cur.status === "RUNNING";
  let handle = null; // 句柄在 poll() 返回后才有值；回调（微任务）触发时已赋值
  handle = Api.poll("/api/tasks/{id}", (cur) => {
    taskViews.set(cur.id, cur);
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
        taskViews.delete(task.id);
        taskDetails.delete(task.id);
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
    const res = await fetch("/api/tasks/" + task.id + "/result");
    const text = await res.text();
    if (!res.ok) throw new Error(I18N.errText(text));
    const json = JSON.parse(text);
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
