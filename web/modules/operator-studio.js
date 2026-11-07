/* Direction C: read-only Operator Studio, on demand. No new HTTP requests or timers. */
import { $, t as globalT } from "./dom.js";

// Feature-local dictionaries keep the initial JS budget unchanged, like Activity / Queue.
const OP_TRANSLATIONS = {
  "operator.kicker": { en: "OPERATOR STUDIO", zh: "运维工作台" },
  "operator.heading": { en: "Instances and activity", zh: "实例与任务动态" },
  "operator.intro": { en: "Observe model readiness and task activity without changing the creative workspace.", zh: "查看模型就绪状态和任务动态，而不改变创作工作区。" },
  "operator.activity.open": { en: "Open activity / queue", zh: "打开任务动态 / 队列" },
  "operator.feed.label": { en: "Instance feed", zh: "实例状态数据" },
  "operator.feed.loading": { en: "Waiting for first response", zh: "等待首次响应" },
  "operator.feed.stale": { en: "Unverified — connection interrupted", zh: "未验证 — 连接中断" },
  "operator.feed.current": { en: "Current", zh: "已更新" },
  "operator.ready.label": { en: "Ready instances (all models)", zh: "就绪实例（所有模型）" },
  "operator.model.label": { en: "Ready for selected model", zh: "当前选中模型的就绪实例" },
  "operator.model.unselected": { en: "No model selected", zh: "尚未选中模型" },
  "operator.tasks.label": { en: "Reported active tasks", zh: "已报告的活跃任务" },
  "operator.instances.toggle": { en: "Show individual instances", zh: "展开各实例" },
  "operator.instances.count": { en: "{count} instances in current feed", zh: "当前数据包含 {count} 个实例" },
  "operator.tasks.count": { en: "{count} local tasks · {active} in progress", zh: "本地任务 {count} 个 · 进行中 {active} 个" },
  "operator.instances.heading": { en: "Instances by model", zh: "按模型查看实例" },
  "operator.instances.empty": { en: "No instances reported", zh: "未报告任何实例" },
  "operator.instances.unverified": { en: "Instance information unavailable", zh: "实例信息不可用" },
  "operator.tasks.heading": { en: "Recent session tasks", zh: "本次会话的最近任务" },
  "operator.tasks.note": { en: "Local task metadata only; use Activity / Queue for authoritative server state.", zh: "仅显示本地任务元数据；请通过任务动态 / 队列核对服务端权威状态。" },
  "operator.tasks.empty": { en: "No locally tracked tasks yet", zh: "本地尚无已跟踪任务" },
  "operator.task.kind": { en: "Task", zh: "任务" },
  "operator.task.created": { en: "Created", zh: "创建" },
  "operator.task.elapsed": { en: "Elapsed", zh: "历时" },
  "operator.category.tts": { en: "Speech", zh: "语音合成" },
  "operator.category.asr": { en: "Transcription", zh: "转写" },
  "operator.category.sep": { en: "Separation", zh: "音频分离" },
  "operator.category.music": { en: "Music", zh: "音乐" },
  "operator.category.other": { en: "Tool", zh: "工具" },
  "operator.routing.heading": { en: "Farm routing and failover", zh: "集群路由与故障切换" },
  "operator.routing.note": { en: "Not monitored: the current instance feed cannot establish routing health or failover readiness.", zh: "未监测：当前实例状态数据无法证实路由健康或故障切换就绪。" },
  "operator.routing.unknown": { en: "Not monitored", zh: "未监测" },
  "operator.status.READY": { en: "Ready", zh: "就绪" },
  "operator.status.STARTING": { en: "Starting", zh: "启动中" },
  "operator.status.ERROR": { en: "Error", zh: "错误" },
  "operator.status.STOPPED": { en: "Stopped", zh: "已停止" },
  "operator.status.QUEUED": { en: "Queued", zh: "排队中" },
  "operator.status.RUNNING": { en: "Running", zh: "运行中" },
  "operator.status.DONE": { en: "Done", zh: "完成" },
  "operator.status.FAILED": { en: "Failed", zh: "失败" },
  "operator.status.CANCELLED": { en: "Cancelled", zh: "已取消" },
  "operator.status.UNKNOWN": { en: "Unknown", zh: "未知" }
};
function t(key) { return OP_TRANSLATIONS[key]?.[I18N.lang()] || globalT(key); }

import { instanceFeedState, instances } from "./instances.js";
import { models, selectedModelId } from "./state.js";
import { taskViews } from "./tasks.js";

let wired = false;

function setText(id, value) {
  const target = $(id);
  if (target && target.textContent !== value) target.textContent = value;
}

function makeLine(primary, secondary, status) {
  const row = document.createElement("li");
  row.className = "operator-row";
  row.dataset.state = status;
  const title = document.createElement("span");
  title.className = "operator-row-title";
  title.textContent = primary;
  const detail = document.createElement("span");
  detail.className = "operator-row-detail";
  detail.textContent = secondary;
  const marker = document.createElement("span");
  marker.className = "operator-row-state";
  marker.dataset.state = status;
  marker.textContent = t("operator.status." + status);
  row.append(title, detail, marker);
  return row;
}

// Metadata only: do not render task payload, transcript, prompt or audio.
function taskTimelineDetails(task) {
  const parts = [displayModel(task.modelId)];
  if (task.createdAt) {
    const created = I18N.date(task.createdAt, { dateStyle: "medium", timeStyle: "medium" });
    if (created) parts.push(t("operator.task.created") + ": " + created);
  }
  const start = Number(task.startedAt || task.createdAt);
  const end = Number(task.finishedAt);
  // A running elapsed time without a timer would be misleading. Report only
  // a known completed duration; the existing task poll remains authoritative.
  if (start > 0 && end > 0 && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
    parts.push(t("operator.task.elapsed") + ": " + ((end - start) / 1000).toFixed(1) + "s");
  }
  return parts.join(" · ");
}

function displayModel(id) {
  const model = models.find(item => item.id === id);
  return model ? I18N.pick(model, "displayName") : String(id || "");
}

export function renderOperatorStudio() {
  if ($("workspace").dataset.interfaceMode !== "cockpit") return;
  for (const element of document.querySelectorAll("[data-op-i18n]")) {
    const value = t(element.dataset.opI18n);
    if (element.textContent !== value) element.textContent = value;
  }
  const feed = instanceFeedState();
  const usable = feed.loaded && !feed.stale;
  const ready = instances.filter(item => item.status === "READY");
  const modelReady = ready.filter(item => item.modelId === selectedModelId);
  const active = instances.reduce((sum, item) => sum + (Number.isFinite(item.taskCount) && item.taskCount >= 0 ? item.taskCount : 0), 0);
  const tasksKnown = instances.every(item => Number.isFinite(item.taskCount) && item.taskCount >= 0);

  setText("operator-feed-value", !feed.loaded && !feed.stale ? t("operator.feed.loading") :
    feed.stale ? t("operator.feed.stale") : t("operator.feed.current"));
  $("operator-feed-value").dataset.state = !feed.loaded || feed.stale ? "unknown" : "READY";
  setText("operator-ready-value", usable ? String(ready.length) : "—");
  setText("operator-model-value", usable ? String(modelReady.length) : "—");
  setText("operator-tasks-value", usable && tasksKnown ? String(active) : "—");
  setText("operator-model-caption", selectedModelId ? displayModel(selectedModelId) : t("operator.model.unselected"));

  setText("operator-instance-overview", usable ?
    t("operator.instances.count").replace("{count}", I18N.num(instances.length)) :
    t("operator.instances.unverified"));
  const list = $("operator-instance-list");
  const rows = [];
  if (usable) {
    for (const inst of [...instances].sort((a, b) => String(a.instanceName || a.modelId).localeCompare(String(b.instanceName || b.modelId)))) {
      const state = ["READY", "STARTING", "ERROR", "STOPPED"].includes(inst.status) ? inst.status : "UNKNOWN";
      rows.push(makeLine(String(inst.instanceName || inst.modelId || inst.id), displayModel(inst.modelId), state));
    }
  }
  if (!rows.length) {
    const li = document.createElement("li");
    li.className = "operator-empty";
    li.textContent = usable ? t("operator.instances.empty") : t("operator.instances.unverified");
    rows.push(li);
  }
  list.replaceChildren(...rows);

  // Only metadata for locally tracked tasks. Never show script text, audio, or private prompts.
  const timeline = $("operator-task-list");
  const order = { RUNNING: 0, QUEUED: 1, DONE: 2, FAILED: 2, CANCELLED: 2 };
  const localTasks = [...taskViews.values()].filter(task => task && task.id);
  setText("operator-task-summary", t("operator.tasks.count")
    .replace("{count}", I18N.num(localTasks.length))
    .replace("{active}", I18N.num(localTasks.filter(task => ["RUNNING", "QUEUED"].includes(task.status)).length)));
  const known = [...taskViews.values()]
    .filter(task => task && task.id)
    .sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3) ||
      (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
    .slice(0, 6);
  const taskRows = known.map(task => {
    const status = ["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELLED"].includes(task.status) ? task.status : "UNKNOWN";
    const category = ["tts", "asr", "sep", "music", "other"].includes(task.category) ? task.category : "other";
    const row = makeLine(t("operator.task.kind") + ": " + (task.category ? t("operator.category." + category) : displayModel(task.modelId)),
      taskTimelineDetails(task), status);
    row.classList.add("operator-timeline-row");
    return row;
  });
  if (!taskRows.length) {
    const li = document.createElement("li");
    li.className = "operator-empty";
    li.textContent = t("operator.tasks.empty");
    taskRows.push(li);
  }
  timeline.replaceChildren(...taskRows);
}

export function activateOperatorStudio() {
  if (!wired) {
    wired = true;
    $("operator-instance-details").open = !window.matchMedia("(min-width: 1101px)").matches;
    const instanceObserver = new MutationObserver(renderOperatorStudio);
    instanceObserver.observe($("instance-list"), { childList: true, attributes: true, attributeFilter: ["aria-busy"] });
    instanceObserver.observe($("instance-pill"), { childList: true, characterData: true, subtree: true });
    window.addEventListener("hub:task-views", renderOperatorStudio);
    window.addEventListener("hashchange", renderOperatorStudio);
    I18N.onChange(renderOperatorStudio);
    $("operator-activity-open").addEventListener("click", () => $("activity-queue-open").click());
  }
  if (!$("operator-styles")) {
    const stylesheet = document.createElement("link");
    stylesheet.id = "operator-styles";
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/operator-studio.css";
    document.head.append(stylesheet);
  }
  renderOperatorStudio();
}
