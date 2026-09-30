/* web/modules/settings.js — 设置对话框渲染（**懒加载 chunk**）
 *
 * 左侧分区导航 + 右侧内容面板：通用（界面语言 / 主题）、HTTPS 证书、可执行文件列表。
 * 三者都只在打开设置弹窗时用得上，因此本模块**不在首屏模块图**里：调用方
 * （routing.js / app.js）走首屏外观层 modules/settings-lazy.js，由它
 * import("./settings.js") 按需拉取。
 *
 * 可执行文件登记的**数据**（轮询、启动弹窗下拉、增删改表单字段、设备探测缓存）
 * 留在外观层——它被首屏的启动弹窗与模型卡片共用。实测表见 scripts/perf-budget.mjs 顶注。 */

import { restoreDialogFocus, setButtonBusy, showToast } from "./async-ui.js";
import { $, Api, esc, t } from "./dom.js";
import { envToText, editingExecId, loadExecutables, resetExecForm, setEditingExecId, showExecForm } from "./settings-lazy.js";
import { applyThemeIcon } from "./shell.js";
import { executables } from "./state.js";

let settingsSection = "general";
let lastCertStatus = null;

export function openSettingsModal(section) {
  settingsSection = section || settingsSection || "general";
  activateSettingsSection(settingsSection);
  syncGeneralPane();
  // 外壳的显示与 focusDialog 由外观层 settings-lazy.js 负责（chunk 到位前就要有反馈）
  loadExecutables();
}
export function closeSettingsModal() {
  $("settings-modal").classList.add("hidden");
  restoreDialogFocus();
  window.hubPanelClosed("settings");
}
export function activateSettingsSection(section) {
  settingsSection = section;
  document.querySelectorAll(".settings-nav-item").forEach(b =>
    b.classList.toggle("active", b.dataset.section === section));
  document.querySelectorAll(".settings-pane").forEach(p => p.classList.add("hidden"));
  $("settings-pane-" + section).classList.remove("hidden");
  if (section === "https") loadCertStatus();
  if (section === "executables") resetExecForm();
}
document.querySelectorAll(".settings-nav-item").forEach(btn => {
  btn.onclick = () => activateSettingsSection(btn.dataset.section);
});
$("settings-modal-close").onclick = closeSettingsModal;
$("settings-modal").onclick = (e) => { if (e.target === $("settings-modal")) closeSettingsModal(); };

/* 通用面板：界面语言 / 主题（与页头开关同一状态源） */
export function syncGeneralPane() {
  $("ui-language").value = I18N.lang();
  $("ui-theme").value = window.HubTheme.mode();
}
$("ui-language").onchange = (e) => I18N.setLang(e.target.value);
$("ui-theme").onchange = (e) => {
  window.HubTheme.setMode(e.target.value);
  applyThemeIcon();
  window.dispatchEvent(new Event("themechange"));
};

/* ---------- HTTPS 证书面板 ---------- */
async function loadCertStatus() {
  try {
    const json = await Api.get("/api/cert/status");
    if (json && json.data) renderCertStatus(json.data);
  } catch (e) { /* 状态拉取失败不影响面板其他操作 */ }
}

function renderCertStatus(data) {
  lastCertStatus = data;
  $("https-enabled").checked = !!data.enabled;
  const badge = $("https-status-badge");
  if (data.exists) {
    badge.textContent = t("https.certOk");
    badge.className = "badge ready";
  } else {
    badge.textContent = t("https.certMissing");
    badge.className = "badge stopped";
  }
  $("https-status-text").textContent = t("https.statusLine", {
    path: data.path,
    ca: data.caCertExists ? t("https.caExists") : t("https.caMissing")
  });
}

$("https-enabled").onchange = async (e) => {
  const enabled = e.target.checked;
  try {
    const json = await Api.post("/api/https/config", { enabled });
    renderCertStatus(json.data);
    showToast("info", t("https.configSaved"));
  } catch (err) {
    e.target.checked = !enabled;
    showToast("error", t("https.saveFailed") + t("common.colon") + err.message);
  }
};

async function downloadCert(url, fallbackName) {
  try {
    // 需要原始 Response：读 blob 与 Content-Disposition 文件名
    const res = await Api.get(url, { raw: true });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const dispo = res.headers.get("Content-Disposition") || "";
    const m = dispo.match(/filename="([^"]+)"/);
    a.download = m ? m[1] : fallbackName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    showToast("error", t("https.downloadFailed") + t("common.colon") + e.message);
  }
}
$("https-download-ca").onclick = () => downloadCert("/api/cert/download?type=ca", "ca-cert.cer");
$("https-download-keystore").onclick = () => downloadCert("/api/cert/download", "keystore.p12");

$("https-generate-btn").onclick = async () => {
  const msg = $("https-msg");
  const result = $("https-result");
  msg.textContent = "";
  result.textContent = "";
  const body = {
    hostnames: $("https-hostnames").value.split("\n").map(s => s.trim()).filter(Boolean),
    ips: $("https-ips").value.split("\n").map(s => s.trim()).filter(Boolean),
    validity: parseInt($("https-validity").value, 10) || 3650,
    keysize: parseInt($("https-keysize").value, 10) || 2048
  };
  const password = $("https-password").value.trim();
  if (password) body.password = password;
  const btn = $("https-generate-btn");
  // 证书生成是本地化的长任务：按钮内联 loading 即可，无需全局遮罩
  setButtonBusy(btn, true, t("https.generating"));
  try {
    const data = (await Api.post("/api/cert/generate", body)).data;
    result.textContent = t("https.generateDone", {
      path: data.path, ca: data.caCertPath, password: data.password, expire: data.expireDate
    });
    loadCertStatus();
  } catch (e) {
    msg.textContent = t("https.generateFailed") + t("common.colon") + e.message;
  } finally {
    setButtonBusy(btn, false);
  }
};

/* ---------- 可执行文件列表（数据与表单在外观层 settings-lazy.js） ---------- */
export function renderExecList() {
  const list = $("exec-list");
  list.innerHTML = "";
  if (executables.length === 0) {
    list.innerHTML = `<div class="hint exec-empty">${t("exec.empty")}</div>`;
    return;
  }
  for (const ex of executables) {
    const row = document.createElement("div");
    row.className = "exec-row" + (ex.exists ? "" : " missing");
    let html = `<div class="exec-info">
      <div class="exec-name">${esc(ex.name)}${ex.exists ? "" : ` <span class="badge error">${esc(t("exec.missing"))}</span>`}</div>
      <div class="exec-path">${esc(ex.path)}</div>`;
    if (ex.note) {
      html += `<div class="exec-note">${esc(ex.note)}</div>`;
    }
    if (ex.env && Object.keys(ex.env).length) {
      html += `<div class="exec-env-line">${esc(t("exec.envSummary", { keys: Object.keys(ex.env).join(", ") }))}</div>`;
    }
    html += `</div><button class="stop-btn exec-edit">${esc(t("exec.edit"))}</button><button class="stop-btn exec-del">${esc(t("exec.delete"))}</button>`;
    row.innerHTML = html;
    row.querySelector(".exec-edit").onclick = () => startEditExec(ex);
    row.querySelector(".exec-del").onclick = async () => {
      // 删除失败不单独提示：列表以下一次 loadExecutables 的结果为准（显式吞掉错误）
      await Api.del("/api/executables/{id}", { params: { id: ex.id } }).catch(() => {});
      if (editingExecId === ex.id) resetExecForm();
      loadExecutables();
    };
    list.appendChild(row);
  }
}

/* 行内编辑：把某个可执行文件回填进表单（状态机在外观层） */
function startEditExec(ex) {
  setEditingExecId(ex.id);
  $("exec-name").value = ex.name || "";
  $("exec-path").value = ex.path || "";
  $("exec-note").value = ex.note || "";
  $("exec-env").value = envToText(ex.env);
  $("exec-msg").textContent = "";
  const title = $("exec-form-title");
  title.dataset.i18n = "exec.editTitle";
  title.textContent = t("exec.editTitle");
  const btn = $("exec-add-btn");
  btn.dataset.i18n = "exec.save";
  btn.textContent = t("exec.save");
  showExecForm();
}

$("exec-new-btn").onclick = () => {
  resetExecForm();
  showExecForm();
};
$("exec-cancel-edit-btn").onclick = resetExecForm;

/* 语言切换重画（由外观层 settings-lazy.js 转发，只在弹窗已开时调）：
   静态文案由 I18N.applyI18n 批量替换，这里重画 t() 生成的动态区域。 */
export function relocalize() {
  if (!$("settings-modal").classList.contains("hidden")) {
    syncGeneralPane();
    if (lastCertStatus) renderCertStatus(lastCertStatus);
    renderExecList();
  }
}
