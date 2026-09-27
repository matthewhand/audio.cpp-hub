/* 实例列表 + 状态条（每 2s 轮询）+ 实例详情弹窗。 */
import { $, esc } from "../core/dom.js";
import { apiGet, apiDelete } from "../core/api.js";
import { I18N, t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { STATUS_CLASS, statusText, SUBMIT_BTNS, submitLabel } from "../core/format.js";
import { showSkeleton, renderEmptyState, renderStateError, focusDialog, restoreDialogFocus, registerOverlay } from "../core/ui.js";
import { go, hubPanelClosed } from "../core/router.js";
import { openLaunchModal } from "./executables.js";

let instancesLoaded = false;
export async function refreshInstances() {
  let data;
  if (!instancesLoaded) showSkeleton($("instance-list"), 3);
  try {
    data = await apiGet("/api/instances");
    if (!Array.isArray(data)) throw new Error(t("common.loadFailed"));
  } catch (e) {
    // 轮询中的瞬时失败保留上次列表，仅在从未加载成功时显示错误/重试
    if (state.instances.length === 0) renderStateError($("instance-list"), e, refreshInstances);
    return;
  }
  instancesLoaded = true;
  state.instances = data;
  // 深链接 #/instance/<id>：实例列表就绪后补齐打开详情
  if (state.pendingInstanceId) {
    const inst = state.instances.find(i => i.id === state.pendingInstanceId);
    if (inst) { state.pendingInstanceId = null; openInstanceDetail(inst); }
  }
  renderInstanceList();
  updateInstanceBar();
}

export function renderInstanceList() {
  const list = $("instance-list");
  list.removeAttribute("aria-busy");
  // 展示全部实例（不再按选中模型过滤）：就绪 > 启动中 > 其它，可用的始终排在最前
  const order = { READY: 0, STARTING: 1 };
  const sorted = [...state.instances].sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
  list.innerHTML = "";
  if (state.instances.length === 0) {
    renderEmptyState(list, t("instance.empty"), {
      label: t("instance.create"),
      onClick: openLaunchModal
    });
    return;
  }
  for (const inst of sorted) {
    const m = state.models.find(x => x.id === inst.modelId);
    const modelName = m ? I18N.pick(m, "displayName") : inst.modelId;
    const card = document.createElement("div");
    const statusClass = STATUS_CLASS[inst.status] || "stopped";
    card.className = "card" + (inst.id === state.activeInstanceId ? " selected" : "");
    // 有活跃任务（QUEUED/RUNNING）时追加转圈“工作中”徽标，随 2s 轮询自动出现/消失
    const workingBadge = (inst.taskCount || 0) > 0
      ? ` <span class="badge working">${esc(inst.taskCount > 1 ? t("instance.workingCount", { n: inst.taskCount }) : t("instance.working"))}</span>`
      : "";
    let html = `<div class="card-title">${esc(inst.instanceName || inst.modelId)} <span class="badge ${statusClass}">${esc(statusText(inst.status))}</span>${workingBadge}</div>
      <div class="card-family">${esc(modelName)} ｜ #${esc(inst.id)}</div>
      <div class="card-desc">${esc(inst.backend)}${inst.device != null ? ":" + esc(inst.device) : ""} ｜ ${esc(t("instance.port"))} ${esc(inst.port)}${inst.executableName ? " ｜ " + esc(inst.executableName) : ""}</div>`;
    if (inst.status === "ERROR" && inst.errorMessage) {
      html += `<div class="error-text">${esc(inst.errorMessage)}</div>`;
    }
    if (inst.status !== "STOPPED") {
      html += `<div class="card-actions"><button class="btn-ghost detail-btn">${t("instance.detail")}</button><button class="stop-btn">${t("instance.stop")}</button></div>`;
    }
    card.innerHTML = html;
    const detailBtn = card.querySelector(".detail-btn");
    if (detailBtn) detailBtn.onclick = () => go("#/instance/" + encodeURIComponent(inst.id));
    const stopBtn = card.querySelector(".stop-btn");
    if (stopBtn) {
      stopBtn.onclick = async () => {
        await apiDelete("/api/instances/" + inst.id);
        refreshInstances();
      };
    }
    list.appendChild(card);
  }
}

export function updateInstanceBar() {
  const ready = state.instances.filter(i => i.modelId === state.selectedModelId && i.status === "READY");
  const select = $("instance-select");
  select.innerHTML = "";
  for (const inst of ready) {
    const opt = document.createElement("option");
    opt.value = inst.id;
    opt.textContent = `${inst.instanceName || inst.modelId} ｜ ${inst.backend}${inst.device != null ? ":" + inst.device : ""} ｜ ${t("instance.port")} ${inst.port} ｜ #${inst.id}`;
    select.appendChild(opt);
  }
  const has = ready.length > 0;
  if (has) {
    if (!ready.some(i => i.id === state.activeInstanceId)) {
      state.activeInstanceId = ready[0].id;
    }
    select.value = state.activeInstanceId;
  } else {
    state.activeInstanceId = null;
  }
  // 注意：历史按 modelId 维度记录，与激活哪个实例无关，实例启停/切换不得刷新历史列表
  // （重建 DOM 会打断行内播放、折叠已展开的播放器）
  select.disabled = !has;
  $("instance-stop").disabled = !has;
  $("instance-detail").disabled = !has;
  // 详情弹窗打开时跟随轮询刷新；实例已消失则自动关闭
  if (detailInstanceId) {
    const cur = state.instances.find(i => i.id === detailInstanceId);
    if (cur) renderInstanceDetail(cur); else closeInstanceDetail();
  }

  const pill = $("instance-pill");
  pill.textContent = has ? t("instance.ready") : t("instance.noReady");
  pill.className = "pill " + (has ? "ok" : "warn");

  for (const id of SUBMIT_BTNS) {
    const btn = $(id);
    btn.disabled = !has;
    btn.textContent = has ? submitLabel(id) : submitLabel(id) + t("instance.noReadySuffix");
  }
}

$("instance-select").onchange = (e) => {
  state.activeInstanceId = e.target.value;
  renderInstanceList();
};

$("instance-stop").onclick = async () => {
  if (!state.activeInstanceId) return;
  $("instance-stop").disabled = true;
  await apiDelete("/api/instances/" + state.activeInstanceId);
  refreshInstances();
};

/* ---------- 实例详情弹窗 ---------- */
const instanceDetailModal = $("instance-detail-modal");
let detailInstanceId = null;
export function openInstanceDetail(inst) {
  detailInstanceId = inst.id;
  renderInstanceDetail(inst);
  instanceDetailModal.classList.remove("hidden");
  focusDialog(instanceDetailModal);
}
export function closeInstanceDetail() {
  detailInstanceId = null;
  instanceDetailModal.classList.add("hidden");
  restoreDialogFocus();
  hubPanelClosed("instance");
}
function renderInstanceDetail(inst) {
  const body = $("instance-detail-body");
  body.innerHTML = "";
  const model = state.models.find(m => m.id === inst.modelId);
  const rows = [
    [t("instance.field.name"), inst.instanceName || inst.modelId],
    [t("instance.field.id"), "#" + inst.id],
    [t("instance.field.model"), model ? `${I18N.pick(model, "displayName")}（${inst.modelId}）` : inst.modelId],
    [t("instance.field.status"), statusText(inst.status)],
    [t("instance.field.weights"), inst.weightsPath],
    [t("instance.field.backend"), inst.backend],
    [t("instance.field.device"), inst.device != null ? String(inst.device) : t("instance.valueAuto")],
    [t("instance.field.port"), String(inst.port)],
    [t("instance.field.threads"), inst.threads != null ? String(inst.threads) : t("instance.valueAuto")],
    [t("instance.field.executable"), inst.executableName || "-"],
    [t("instance.field.createdAt"), inst.createdAt ? I18N.date(inst.createdAt) : "-"]
  ];
  const addRow = (keyText, valueNode) => {
    const row = document.createElement("div");
    row.className = "kv-row";
    const key = document.createElement("span");
    key.className = "kv-key";
    key.textContent = keyText;
    row.appendChild(key);
    row.appendChild(valueNode);
    body.appendChild(row);
  };
  for (const [k, v] of rows) {
    const val = document.createElement("span");
    val.className = "kv-val";
    val.textContent = v;
    addRow(k, val);
  }
  const opts = inst.sessionOptions || {};
  const names = Object.keys(opts);
  if (names.length) {
    const list = document.createElement("div");
    list.className = "kv-opts";
    for (const name of names) {
      const item = document.createElement("code");
      item.textContent = `${name}=${opts[name]}`;
      list.appendChild(item);
    }
    addRow(t("instance.field.sessionOptions"), list);
  } else {
    const val = document.createElement("span");
    val.className = "kv-val";
    val.textContent = t("instance.valueNone");
    addRow(t("instance.field.sessionOptions"), val);
  }
}
$("instance-detail").onclick = () => {
  if (state.activeInstanceId) go("#/instance/" + encodeURIComponent(state.activeInstanceId));
};
$("instance-detail-close").onclick = closeInstanceDetail;
instanceDetailModal.onclick = (e) => { if (e.target === instanceDetailModal) closeInstanceDetail(); };
registerOverlay("instance-detail-modal", closeInstanceDetail);
