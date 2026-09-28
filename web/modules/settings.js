/* web/modules/settings.js — 设置对话框
 *
 * 左侧分区导航 + 右侧内容面板：通用（界面语言 / 主题）、HTTPS 证书、可执行文件登记。
 * 可执行文件同时供启动弹窗使用（renderExecList / startEditExec / parseEnvText /
 * parseSessionOptionsText / updateLaunchExec 都在这里，由 launch 模块导入）。 */

import { focusDialog, renderListError, restoreDialogFocus, setButtonBusy, showToast } from "./async-ui.js";
import { $, esc, t } from "./dom.js";
import { renderModelList } from "./models.js";
import { go, goPanel, setPendingSettingsSection } from "./routing.js";
import { applyThemeIcon } from "./shell.js";
import { executables, models, setExecutables } from "./state.js";

/* 每个可执行文件的探测结果缓存（id → devices 数组）；可执行文件增删改时整体清空。
   缓存随可执行文件登记一起失效，因此归本模块；写入方（--list-devices 探测）在 launch.js。 */
export const deviceCache = {};

/* ---------- 设置对话框（左侧功能菜单 + 右侧内容面板） ---------- */
export const settingsModal = $("settings-modal");
export let settingsSection = "general";
export let lastCertStatus = null;

export function openSettingsModal(section) {
  settingsSection = section || settingsSection || "general";
  activateSettingsSection(settingsSection);
  syncGeneralPane();
  settingsModal.classList.remove("hidden");
  focusDialog(settingsModal);
  loadExecutables();
}
export function closeSettingsModal() {
  settingsModal.classList.add("hidden");
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
$("settings-btn").onclick = () => { setPendingSettingsSection("general"); goPanel("settings"); };
$("exec-goto-btn").onclick = () => { setPendingSettingsSection("executables"); go("#/settings"); };
$("settings-modal-close").onclick = closeSettingsModal;
settingsModal.onclick = (e) => { if (e.target === settingsModal) closeSettingsModal(); };

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
export async function loadCertStatus() {
  try {
    const res = await fetch("/api/cert/status");
    const json = await res.json();
    if (json && json.data) renderCertStatus(json.data);
  } catch (e) { /* 状态拉取失败不影响面板其他操作 */ }
}

export function renderCertStatus(data) {
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
    const res = await fetch("/api/https/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled })
    });
    const text = await res.text();
    if (!res.ok) throw new Error(I18N.errText(text));
    renderCertStatus(JSON.parse(text).data);
    showToast("info", t("https.configSaved"));
  } catch (err) {
    e.target.checked = !enabled;
    showToast("error", t("https.saveFailed") + t("common.colon") + err.message);
  }
};

export async function downloadCert(url, fallbackName) {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      showToast("error", t("https.downloadFailed") + t("common.colon") + I18N.errText(text));
      return;
    }
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
    const res = await fetch("/api/cert/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      msg.textContent = t("https.generateFailed") + t("common.colon") + I18N.errText(text);
      return;
    }
    const data = JSON.parse(text).data;
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

export async function loadExecutables() {
  // 可执行文件可能已增删改：设备探测缓存整体失效
  for (const k of Object.keys(deviceCache)) delete deviceCache[k];
  try {
    const res = await fetch("/api/executables");
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    const data = await res.json();
    setExecutables(Array.isArray(data) ? data : []);
  } catch (e) {
    setExecutables([]);
    renderListError($("exec-list"), t("common.loadFailed") + t("common.colon") + e.message, loadExecutables);
    updateLaunchExec();
    return;
  }
  renderExecList();
  updateLaunchExec();
  // 可执行文件有效性也影响模型卡片的已配置/黯淡状态
  if (models.length) renderModelList();
}

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
      await fetch("/api/executables/" + ex.id, { method: "DELETE" });
      if (editingExecId === ex.id) resetExecForm();
      loadExecutables();
    };
    list.appendChild(row);
  }
}

/* 正在编辑的可执行文件 id，null 表示新增模式；表单默认收起，点“新增”/“编辑”才展开 */
export let editingExecId = null;

export function showExecForm() {
  $("exec-form-section").classList.remove("hidden");
}

export function hideExecForm() {
  $("exec-form-section").classList.add("hidden");
  $("exec-msg").textContent = "";
}

export function startEditExec(ex) {
  editingExecId = ex.id;
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

export function resetExecForm() {
  editingExecId = null;
  $("exec-name").value = "";
  $("exec-path").value = "";
  $("exec-note").value = "";
  $("exec-env").value = "";
  const title = $("exec-form-title");
  title.dataset.i18n = "exec.addTitle";
  title.textContent = t("exec.addTitle");
  const btn = $("exec-add-btn");
  btn.dataset.i18n = "exec.add";
  btn.textContent = t("exec.add");
  hideExecForm();
}

$("exec-new-btn").onclick = () => {
  resetExecForm();
  showExecForm();
};
$("exec-cancel-edit-btn").onclick = resetExecForm;

/* 解析环境变量输入：每行 KEY=VALUE，空行忽略；格式错误抛带行号的异常 */
export function parseEnvText() {
  const env = {};
  const lines = $("exec-env").value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.substring(0, eq).trim())) {
      throw new Error(t("exec.envInvalid", { line: i + 1 }));
    }
    env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  }
  return env;
}

export function envToText(env) {
  if (!env) return "";
  return Object.entries(env).map(([k, v]) => k + "=" + v).join("\n");
}

export function parseSessionOptionsText() {
  const options = {};
  const lines = $("launch-adv-options").value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(t("launch.advInvalid", { line: i + 1 }));
    options[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  }
  return options;
}

export function updateLaunchExec() {
  const sel = $("launch-exec");
  sel.innerHTML = "";
  const empty = executables.length === 0;
  if (empty) {
    // 无可用程序时显示占位项，点击下拉即跳转到设置页添加（见下方 mousedown 处理）
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("launch.execNone");
    sel.appendChild(opt);
  }
  for (const ex of executables) {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.name + (ex.exists ? "" : t("exec.missingSuffix"));
    sel.appendChild(opt);
  }
  sel.classList.toggle("exec-empty", empty);
  $("launch-btn").disabled = empty;
  $("exec-empty-hint").classList.toggle("hidden", !empty);
}
