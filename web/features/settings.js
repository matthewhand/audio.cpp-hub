/* 设置对话框（通用：界面语言/主题；audio.cpp：可执行文件；HTTPS 证书）。 */
import { $ } from "../core/dom.js";
import { apiGet, apiPost } from "../core/api.js";
import { I18N, t } from "../core/i18n.js";
import { showToast, setButtonBusy, focusDialog, restoreDialogFocus, registerOverlay } from "../core/ui.js";
import { state } from "../core/state.js";
import { go, goPanel, hubPanelClosed } from "../core/router.js";
import { loadExecutables, resetExecForm } from "./executables.js";

/* ---------- 主题切换（system → light → dark 循环，解析逻辑见 boot.js 的 window.HubTheme） ---------- */
const themeBtn = $("theme-toggle");
const THEME_MODES = ["system", "light", "dark"];
const THEME_ICONS = { system: "🖥️", light: "☀️", dark: "🌙" };
export function applyThemeIcon() {
  const mode = window.HubTheme.mode();
  themeBtn.textContent = THEME_ICONS[mode] || THEME_ICONS.system;
  themeBtn.title = t("settings.general.theme") + "：" + t("settings.theme." + mode);
}
themeBtn.onclick = () => {
  const mode = window.HubTheme.mode();
  const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
  window.HubTheme.setMode(next);
  applyThemeIcon();
  window.dispatchEvent(new Event("themechange"));
};

/* ---------- 语言切换 ---------- */
const langBtn = $("lang-toggle");
export function applyLangBtn() {
  langBtn.textContent = I18N.lang() === "zh" ? "EN" : "中文";
}
langBtn.onclick = () => I18N.setLang(I18N.lang() === "zh" ? "en" : "zh");

/* ---------- 设置对话框（左侧功能菜单 + 右侧内容面板） ---------- */
const settingsModal = $("settings-modal");
let settingsSection = "general";
let lastCertStatus = null;

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
  hubPanelClosed("settings");
}
function activateSettingsSection(section) {
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
$("settings-btn").onclick = () => { state.pendingSettingsSection = "general"; goPanel("settings"); };
$("exec-goto-btn").onclick = () => { state.pendingSettingsSection = "executables"; go("#/settings"); };
$("settings-modal-close").onclick = closeSettingsModal;
settingsModal.onclick = (e) => { if (e.target === settingsModal) closeSettingsModal(); };
registerOverlay("settings-modal", closeSettingsModal);

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
    const json = await apiGet("/api/cert/status");
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

/* 语言切换后刷新已加载的证书状态文案 */
export function rerenderCertStatusIfLoaded() {
  if (lastCertStatus) renderCertStatus(lastCertStatus);
}

$("https-enabled").onchange = async (e) => {
  const enabled = e.target.checked;
  try {
    const json = await apiPost("/api/https/config", { enabled });
    renderCertStatus(json.data);
    showToast("info", t("https.configSaved"));
  } catch (err) {
    e.target.checked = !enabled;
    showToast("error", t("https.saveFailed") + t("common.colon") + err.message);
  }
};

/* 证书下载返回二进制 + Content-Disposition，不是 JSON，故保留原生 fetch（非 API 客户端范围） */
async function downloadCert(url, fallbackName) {
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
    const data = (await apiPost("/api/cert/generate", body)).data;
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
