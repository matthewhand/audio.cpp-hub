/* 异步任务（提交 → 排队 → 轮询）：同实例任务由后端串行执行，前端 2s 轮询状态。
   页面刷新/切换模型后经 GET /api/tasks?modelId= 重挂，任务生命周期不绑定页面连接。 */
import { $ } from "../core/dom.js";
import { apiGet, apiPost, apiDelete } from "../core/api.js";
import { t } from "../core/i18n.js";
import { state, selectedModel } from "../core/state.js";
import { taskElapsed } from "../core/format.js";
import { showToast } from "../core/ui.js";
import { renderAsrResult, renderSepResult, renderMusicResult, renderOtherResult } from "./panels.js";
import { refreshInstances } from "./instances.js";
import { loadHistory, renderSidebarList } from "./history.js";

const TASK_VERB = { tts: "tts.verb", asr: "asr.verb", sep: "sep.verb", music: "music.verb", other: "other.verb" };

export async function submitTask(req) {
  const task = await apiPost("/api/tasks", { instanceId: state.activeInstanceId, request: req });
  // 入队成功后立即刷新一次实例列表（不 await），卡片“工作中”徽标即时出现，不等 2s 轮询
  refreshInstances();
  return task;
}

async function fetchTask(taskId) {
  return apiGet("/api/tasks/" + taskId);
}

/* 取消任务：服务端置 CANCELLED，由轮询观察到终态后统一收尾（toast/侧栏刷新） */
export async function cancelTask(taskId) {
  try {
    await apiDelete("/api/tasks/" + taskId);
  } catch (e) {
    showToast("error", t("task.cancelFailed") + t("common.colon") + e.message);
  }
}

/* 跟踪任务：入侧栏记录并启动轮询；到达终态时停轮询、渲染结果（记录保留在侧栏） */
export function trackTask(task) {
  state.taskViews.set(task.id, task);
  renderSidebarList();
  if (state.activePolls.has(task.id)) return;
  if (task.status !== "QUEUED" && task.status !== "RUNNING") return;
  const iv = setInterval(async () => {
    if (document.hidden) return; // 标签页隐藏时暂停任务轮询
    let cur;
    try {
      cur = await fetchTask(task.id);
    } catch (e) {
      if (e.status === 404) {
        // 任务记录已被淘汰/删除：停止轮询并移出侧栏
        clearInterval(iv);
        state.activePolls.delete(task.id);
        state.taskViews.delete(task.id);
        state.taskDetails.delete(task.id);
        renderSidebarList();
      }
      return; // 其余错误视为网络抖动，下轮再试
    }
    state.taskViews.set(cur.id, cur);
    renderSidebarList();
    if (cur.status !== "QUEUED" && cur.status !== "RUNNING") {
      clearInterval(iv);
      state.activePolls.delete(cur.id);
      finishTask(cur);
    }
  }, 2000);
  state.activePolls.set(task.id, iv);
}

/* 任务终态：toast 汇报；任务模型当前选中时渲染结果与最终状态行 */
function finishTask(task) {
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

/* DONE 结果渲染：TTS 直接引用历史 wav URL（不碰 base64）；其余拉取 /result JSON 走原渲染分支 */
export async function renderTaskResult(task) {
  if (task.category === "tts") {
    const url = "/api/history/" + task.modelId + "/" + task.id + "/audio";
    $("tts-player").src = url;
    const download = $("tts-download");
    download.href = url;
    download.download = "tts-" + task.id + ".wav";
    $("tts-result").classList.remove("hidden");
    return;
  }
  try {
    const json = await apiGet("/api/tasks/" + task.id + "/result");
    if (task.category === "asr") renderAsrResult(json);
    else if (task.category === "sep") renderSepResult(json);
    else if (task.category === "music") renderMusicResult(json);
    else renderOtherResult(json);
  } catch (e) {
    const msg = $(task.category + "-msg");
    if (msg) msg.textContent = t("task.resultFailed") + t("common.colon") + e.message;
  }
}

/* 页面加载 / 模型切换后重挂当前模型的任务（含已完成记录；进行中的恢复轮询） */
export async function reattachTasks() {
  const m = selectedModel();
  if (!m) return;
  try {
    const tasks = await apiGet("/api/tasks?modelId=" + encodeURIComponent(m.id));
    if (!Array.isArray(tasks)) return;
    for (const task of tasks) trackTask(task);
  } catch (e) { /* 忽略：下次切换/轮询再试 */ }
}
