/* 下载管理（任务列表 + 模型权重下载弹窗）。 */
import { $, esc, el, markRowEnter } from "../core/dom.js";
import { apiGet, apiPost, apiDelete } from "../core/api.js";
import { I18N, t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { fmtBytes } from "../core/format.js";
import { showToast, focusDialog, restoreDialogFocus, registerOverlay } from "../core/ui.js";

const DL_STATUS_CLASS = { RUNNING: "starting", PENDING: "starting", PAUSED: "stopped", DONE: "ready", FAILED: "error" };

export async function refreshDownloads() {
  let data;
  try {
    data = await apiGet("/api/downloads");
    if (!Array.isArray(data)) throw new Error(t("common.loadFailed"));
  } catch (e) {
    return;
  }
  state.downloads = data;
  updateDlBadge();
  if (!$("downloads-modal").classList.contains("hidden")) renderDownloadList();
}

/* 页头角标：进行中的任务数 */
function updateDlBadge() {
  const running = state.downloads.filter(d => d.status === "RUNNING" || d.status === "PENDING").length;
  const badge = $("dl-badge");
  badge.textContent = running;
  badge.classList.toggle("hidden", running === 0);
}

function openDownloadsModal() {
  renderDownloadList();
  $("downloads-modal").classList.remove("hidden");
  focusDialog($("downloads-modal"));
}
function closeDownloadsModal() {
  $("downloads-modal").classList.add("hidden");
  restoreDialogFocus();
}
$("downloads-btn").onclick = openDownloadsModal;
$("downloads-modal-close").onclick = closeDownloadsModal;
$("downloads-modal").onclick = (e) => { if (e.target === $("downloads-modal")) closeDownloadsModal(); };
registerOverlay("downloads-modal", closeDownloadsModal);

export function renderDownloadList() {
  const list = $("dl-list");
  list.innerHTML = "";
  if (state.downloads.length === 0) {
    list.innerHTML = `<div class="hint exec-empty">${t("dl.empty")}</div>`;
    return;
  }
  for (const d of state.downloads) {
    const model = d.modelId ? state.models.find(m => m.id === d.modelId) : null;
    const title = model ? I18N.pick(model, "displayName") : d.targetDir;
    // 百分比来自服务端，做数值化 + 钳制后再拼进 style，杜绝属性注入
    const pct = Number(d.percent);
    const pctOk = Number.isFinite(pct);
    const pctShown = pctOk ? Math.max(0, Math.min(100, pct)) : 100;
    const row = document.createElement("div");
    row.className = "dl-row";
    let html = `<div class="dl-row-head">
      <span class="dl-row-title">${esc(title)} <span class="dl-row-dir">models/${esc(d.targetDir)}</span></span>
      <span class="badge ${DL_STATUS_CLASS[d.status] || "stopped"}">${esc(t("dl.status." + d.status))}</span>
    </div>
    <div class="dl-progress"><div class="dl-progress-fill${!pctOk || pct < 0 ? " indeterminate" : ""}" style="width:${pctShown}%"></div></div>
    <div class="dl-row-meta">${esc(fmtBytes(d.downloadedBytes))} / ${esc(fmtBytes(d.totalBytes))}${pctOk && pct >= 0 ? ` ｜ ${pctShown}%` : ""}${d.status === "RUNNING" && d.speedBps > 0 ? ` ｜ ${esc(fmtBytes(d.speedBps))}/s` : ""} ｜ ${esc(t("dl.fileProgress", { done: d.completedFiles, n: d.fileCount }))}</div>`;
    if (d.status === "FAILED" && d.error) {
      html += `<div class="error-text">${esc(d.error)}</div>`;
    }
    html += `<div class="card-actions">`;
    if (d.status === "RUNNING" || d.status === "PENDING") {
      html += `<button class="stop-btn dl-act" data-act="pause">${t("dl.pause")}</button>`;
    }
    if (d.status === "PAUSED" || d.status === "FAILED") {
      html += `<button class="stop-btn dl-act" data-act="resume">${t(d.status === "FAILED" ? "dl.retry" : "dl.resume")}</button>`;
    }
    if (d.status === "DONE" && d.modelId) {
      html += `<button class="stop-btn dl-fill">${t("dl.fillWeights")}</button>`;
    }
    html += `<button class="stop-btn dl-del">${t("dl.delete")}</button></div>`;
    row.innerHTML = html;
    for (const btn of row.querySelectorAll(".dl-act")) {
      btn.onclick = async () => {
        try {
          await apiPost(`/api/downloads/${d.id}/${btn.dataset.act}`);
        } catch (e) {
          showToast("error", e.message);
        }
        refreshDownloads();
      };
    }
    const fillBtn = row.querySelector(".dl-fill");
    if (fillBtn) {
      fillBtn.onclick = () => {
        const path = "models/" + d.targetDir;
        localStorage.setItem("hub-weights-" + d.modelId, path);
        if (state.selectedModelId === d.modelId) $("launch-weights").value = path;
        showToast("info", t("dl.weightsFilled", { path }));
      };
    }
    row.querySelector(".dl-del").onclick = async () => {
      if (!window.confirm(t("dl.confirmDelete"))) return;
      try {
        await apiDelete(`/api/downloads/${d.id}?purge=true`);
      } catch (e) {
        showToast("error", e.message);
      }
      refreshDownloads();
    };
    markRowEnter(row, "d:" + d.id);
    list.appendChild(row);
  }
}

/* 模型下载弹窗：包选择 + token + 覆盖 */
export function openModelDlModal(m) {
  state.mdlModel = m;
  state.mdlPackages = null;
  $("mdl-dl-model").textContent = I18N.pick(m, "displayName");
  $("mdl-msg").textContent = "";
  $("mdl-package-list").innerHTML = `<div class="hint">${t("dl.loading")}</div>`;
  $("model-dl-modal").classList.remove("hidden");
  focusDialog($("model-dl-modal"));
  loadMdlPackages(m);
}
function closeModelDlModal() {
  $("model-dl-modal").classList.add("hidden");
  restoreDialogFocus();
}
$("model-dl-modal-close").onclick = closeModelDlModal;
$("model-dl-modal").onclick = (e) => { if (e.target === $("model-dl-modal")) closeModelDlModal(); };
registerOverlay("model-dl-modal", closeModelDlModal);

async function loadMdlPackages(m) {
  try {
    state.mdlPackages = await apiGet(`/api/models/${m.id}/packages`);
    renderMdlPackages();
  } catch (e) {
    const box = el(`<div class="hint"></div>`);
    box.textContent = t("dl.loadFailed") + t("common.colon") + e.message;
    $("mdl-package-list").innerHTML = "";
    $("mdl-package-list").appendChild(box);
  }
}

export function renderMdlPackages() {
  const c = $("mdl-package-list");
  c.innerHTML = "";
  const pkgs = (state.mdlPackages && state.mdlPackages.packages) || [];
  if (pkgs.length === 0) {
    c.innerHTML = `<div class="hint">${t("dl.noPackages")}</div>`;
    return;
  }
  pkgs.forEach((p, i) => {
    const row = el(`<label class="dl-package-row">
      <input type="radio" name="mdl-package" value="${esc(p.id)}"${p.default || (!pkgs.some(x => x.default) && i === 0) ? " checked" : ""}>
      <span class="dl-package-text">
        <span class="dl-package-name"></span>
        <span class="dl-package-meta">${esc([p.format, p.precision].filter(Boolean).join(" ｜ "))} → models/${esc(p.targetDir)} ｜ ${esc(t("dl.fileCount", { n: (p.files || []).length }))}</span>
      </span>
    </label>`);
    const name = row.querySelector(".dl-package-name");
    name.textContent = p.displayName || p.id;
    if (p.default) name.appendChild(el(` <span class="badge ready">${t("dl.recommended")}</span>`));
    if (p.gated) name.appendChild(el(` <span class="badge stopped">gated</span>`));
    c.appendChild(row);
  });
}

$("mdl-start").onclick = async () => {
  const msg = $("mdl-msg");
  msg.textContent = "";
  const sel = document.querySelector('input[name="mdl-package"]:checked');
  if (!sel || !state.mdlModel) {
    msg.textContent = t("dl.noPackages");
    return;
  }
  const body = {
    modelId: state.mdlModel.id,
    packageId: sel.value,
    overwrite: $("mdl-overwrite").checked
  };
  const token = $("mdl-token").value.trim();
  if (token) body.token = token;
  const endpoint = $("mdl-endpoint").value;
  if (endpoint === "modelscope") body.source = "modelscope";
  else if (endpoint) body.endpoint = endpoint;
  const btn = $("mdl-start");
  btn.disabled = true;
  try {
    await apiPost("/api/downloads", body);
    closeModelDlModal();
    showToast("info", t("dl.started"));
    await refreshDownloads();
    openDownloadsModal();
  } catch (e) {
    msg.textContent = t("dl.startFailed") + t("common.colon") + e.message;
  } finally {
    btn.disabled = false;
  }
};
