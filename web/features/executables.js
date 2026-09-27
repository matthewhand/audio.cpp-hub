/* 可执行文件管理 + 设备探测 + 启动模型弹窗 + 启动配置（Profile）+ 快速启动。 */
import { $, esc, renderListError } from "../core/dom.js";
import { apiGet, apiPost, apiPut, apiDelete } from "../core/api.js";
import { I18N, t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { showToast, focusDialog, restoreDialogFocus, registerOverlay } from "../core/ui.js";
import { renderModelList } from "./models.js";
import { openSettingsModal } from "./settings.js";
import { refreshInstances } from "./instances.js";

/* ---------- 可执行文件列表 ---------- */
export async function loadExecutables() {
  // 可执行文件可能已增删改：设备探测缓存整体失效
  for (const k of Object.keys(deviceCache)) delete deviceCache[k];
  try {
    const data = await apiGet("/api/executables");
    state.executables = Array.isArray(data) ? data : [];
  } catch (e) {
    state.executables = [];
    renderListError($("exec-list"), t("common.loadFailed") + t("common.colon") + e.message, loadExecutables);
    updateLaunchExec();
    return;
  }
  renderExecList();
  updateLaunchExec();
  // 可执行文件有效性也影响模型卡片的已配置/黯淡状态
  if (state.models.length) renderModelList();
}

export function renderExecList() {
  const list = $("exec-list");
  list.innerHTML = "";
  if (state.executables.length === 0) {
    list.innerHTML = `<div class="hint exec-empty">${t("exec.empty")}</div>`;
    return;
  }
  for (const ex of state.executables) {
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
      await apiDelete("/api/executables/" + ex.id);
      if (editingExecId === ex.id) resetExecForm();
      loadExecutables();
    };
    list.appendChild(row);
  }
}

/* 正在编辑的可执行文件 id，null 表示新增模式；表单默认收起，点“新增”/“编辑”才展开 */
let editingExecId = null;

function showExecForm() {
  $("exec-form-section").classList.remove("hidden");
}

function hideExecForm() {
  $("exec-form-section").classList.add("hidden");
  $("exec-msg").textContent = "";
}

function startEditExec(ex) {
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
function parseEnvText() {
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

function envToText(env) {
  if (!env) return "";
  return Object.entries(env).map(([k, v]) => k + "=" + v).join("\n");
}

/* 解析高级参数输入：每行一个 key=value（写入 server.json 模型条目的 session_options），
   空行忽略；格式错误抛带行号的异常。键不限字符集（引擎键含点号，如 voxcpm2.weight_type）。 */
function parseSessionOptionsText() {
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
  const empty = state.executables.length === 0;
  if (empty) {
    // 无可用程序时显示占位项，点击下拉即跳转到设置页添加（见下方 mousedown 处理）
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("launch.execNone");
    sel.appendChild(opt);
  }
  for (const ex of state.executables) {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.name + (ex.exists ? "" : t("exec.missingSuffix"));
    sel.appendChild(opt);
  }
  sel.classList.toggle("exec-empty", empty);
  $("launch-btn").disabled = empty;
  $("exec-empty-hint").classList.toggle("hidden", !empty);
}

/* 可执行文件为空时，点击下拉框直接跳转到设置页的可执行文件面板 */
$("launch-exec").addEventListener("mousedown", (e) => {
  if (state.executables.length === 0) {
    e.preventDefault();
    openSettingsModal("executables");
  }
});

/* ---------- 设备探测：打开启动弹窗/切换程序时自动 --list-devices，设备改为下拉选择 ---------- */

/* 探测输出中的后端名（ggml 注册名，不区分大小写）→ 启动表单的后端值，ROCm 对应 hip */
const DEVICE_BACKEND_MAP = { cuda: "cuda", vulkan: "vulkan", metal: "metal", hip: "hip", rocm: "hip", cpu: "cpu" };

/* 每个可执行文件的探测结果缓存（id → devices 数组）；可执行文件增删改时整体清空 */
const deviceCache = {};

/* 期望选中的设备（{index, backend}）：配置回填时探测可能尚未完成，选项渲染后据此还原 */
let wantedDevice = null;

/* 探测指定可执行文件的设备并刷新下拉框；成功的结果按 execId 缓存，失败不缓存（下次重试） */
async function probeDevices(execId) {
  if (!execId) {
    renderDeviceOptions([]);
    return;
  }
  if (deviceCache[execId]) {
    renderDeviceOptions(deviceCache[execId]);
    return;
  }
  renderDeviceOptions(null);
  try {
    const result = await apiGet("/api/executables/" + execId + "/devices");
    const devices = result.devices || [];
    deviceCache[execId] = devices;
    // 探测期间用户可能已切换程序：仅当仍是当前选择时才渲染
    if ($("launch-exec").value === execId) renderDeviceOptions(devices);
  } catch (e) {
    if ($("launch-exec").value === execId) renderDeviceOptions([]);
    showToast("error", t("launch.deviceDetectFailed") + t("common.colon") + e.message);
  }
}

/* 渲染设备下拉框：devices 为 null 表示检测中（禁用并显示提示）。
   选项 value 取 "后端:序号" 保证唯一，data-index 记录提交用的设备号；标签以 GPU 名称为主。 */
function renderDeviceOptions(devices) {
  const sel = $("launch-device");
  sel.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = devices === null ? t("launch.deviceDetecting") : t("launch.deviceAuto");
  sel.appendChild(auto);
  sel.disabled = devices === null;
  for (const dev of devices || []) {
    const opt = document.createElement("option");
    opt.value = dev.backend + ":" + dev.index;
    opt.dataset.index = dev.index;
    opt.dataset.backend = dev.backend;
    const name = (dev.name || "").trim();
    opt.textContent = (name || dev.backend + " " + dev.index) + "（" + dev.backend + ":" + dev.index + "）";
    sel.appendChild(opt);
  }
  applyWantedDevice();
}

/* 探测结果渲染后还原期望选中的设备（配置回填/上次选择）；找不到保持“自动” */
function applyWantedDevice() {
  const sel = $("launch-device");
  if (!wantedDevice) {
    sel.value = "";
    return;
  }
  const opt = [...sel.options].find(o => o.value !== ""
    && parseInt(o.dataset.index, 10) === wantedDevice.index
    && (!wantedDevice.backend || DEVICE_BACKEND_MAP[(o.dataset.backend || "").toLowerCase()] === wantedDevice.backend));
  sel.value = opt ? opt.value : "";
}

/* 选中当前下拉项的设备号（int），“自动”返回 null；启动请求与配置收集共用 */
function selectedDeviceIndex() {
  const opt = $("launch-device").selectedOptions[0];
  return opt && opt.value !== "" ? parseInt(opt.dataset.index, 10) : null;
}

/* 手动选择设备：记住选择并联动后端下拉框 */
$("launch-device").onchange = () => {
  const opt = $("launch-device").selectedOptions[0];
  wantedDevice = opt && opt.value !== ""
    ? { index: parseInt(opt.dataset.index, 10), backend: DEVICE_BACKEND_MAP[(opt.dataset.backend || "").toLowerCase()] }
    : null;
  if (wantedDevice && wantedDevice.backend) $("launch-backend").value = wantedDevice.backend;
};

/* 切换可执行文件：重新探测设备（命中缓存则直接渲染） */
$("launch-exec").onchange = () => {
  wantedDevice = null;
  probeDevices($("launch-exec").value);
};

$("exec-add-btn").onclick = async () => {
  const msg = $("exec-msg");
  msg.textContent = "";
  let env;
  try {
    env = parseEnvText();
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  const body = {
    name: $("exec-name").value.trim(),
    path: $("exec-path").value.trim(),
    note: $("exec-note").value.trim(),
    env
  };
  const editing = editingExecId !== null;
  try {
    if (editing) await apiPut("/api/executables/" + editingExecId, body);
    else await apiPost("/api/executables", body);
    resetExecForm();
    loadExecutables();
  } catch (e) {
    msg.textContent = t(editing ? "exec.saveFailed" : "exec.addFailed") + t("common.colon") + e.message;
  }
};

/* ---------- 快速启动 ---------- */
/* 权重目录路径按模型持久化到 localStorage */
const weightsKey = () => "hub-weights-" + state.selectedModelId;
export function restoreWeightsPath() {
  $("launch-weights").value = localStorage.getItem(weightsKey()) || "";
}
$("launch-weights").addEventListener("input", (e) => {
  if (state.selectedModelId) localStorage.setItem(weightsKey(), e.target.value.trim());
});

/* 线程数全局持久化 */
$("launch-threads").value = localStorage.getItem("hub-threads") || "";
$("launch-threads").addEventListener("input", (e) => {
  localStorage.setItem("hub-threads", e.target.value.trim());
});

/* ---------- 启动模型 modal ---------- */
const launchModal = $("launch-modal");
export function openLaunchModal() {
  $("launch-msg").textContent = "";
  launchModal.classList.remove("hidden");
  focusDialog(launchModal);
  loadProfiles();
  // 打开弹窗即自动探测当前程序的设备（命中缓存则直接渲染）
  probeDevices($("launch-exec").value);
}
export function closeLaunchModal() {
  launchModal.classList.add("hidden");
  restoreDialogFocus();
}
$("launch-open-btn").onclick = openLaunchModal;
$("launch-modal-close").onclick = closeLaunchModal;
launchModal.onclick = (e) => { if (e.target === launchModal) closeLaunchModal(); };
registerOverlay("launch-modal", closeLaunchModal);

/* 权重目录：服务器端文件选择器（目录模式） */
$("weights-browse-btn").onclick = async () => {
  const path = await FileBrowser.open({
    mode: "dir",
    title: t("launch.weightsBrowseTitle"),
    startPath: $("launch-weights").value.trim()
  });
  if (path) {
    $("launch-weights").value = path;
    $("launch-weights").dispatchEvent(new Event("input"));
  }
};

/* 权重也可以是单个 GGUF 文件（audio.cpp 支持直接加载 .gguf） */
$("weights-gguf-btn").onclick = async () => {
  const path = await FileBrowser.open({
    mode: "file",
    title: t("launch.weightsGgufBrowseTitle"),
    extensions: [".gguf"],
    startPath: $("launch-weights").value.trim()
  });
  if (path) {
    $("launch-weights").value = path;
    $("launch-weights").dispatchEvent(new Event("input"));
  }
};

/* 可执行文件：服务器端文件选择器（文件模式，默认过滤 .exe） */
$("exec-browse-btn").onclick = async () => {
  const path = await FileBrowser.open({
    mode: "file",
    title: t("launch.execBrowseTitle"),
    extensions: [".exe"],
    defaultAll: true,
    startPath: $("exec-path").value.trim()
  });
  if (path) {
    $("exec-path").value = path;
  }
};

/* ---------- 启动配置（Profile）：持久化到后端 data/profiles.json ---------- */
export async function loadProfiles() {
  try {
    const data = await apiGet("/api/profiles");
    state.profiles = Array.isArray(data) ? data : [];
  } catch (e) {
    state.profiles = [];
    return;
  }
  renderLaunchProfiles();
  // 配置变化会影响模型列表的可用/黯淡展示
  if (state.models.length) renderModelList();
}

/* 启动配置选择记忆：按模型存 localStorage，打开弹窗时自动选中并回填上次使用的配置 */
const launchProfileKey = () => "hub-launch-profile-" + state.selectedModelId;

/* 下拉只显示当前模型的配置 */
export function renderLaunchProfiles() {
  const sel = $("launch-profile");
  const current = sel.value;
  sel.innerHTML = `<option value="">${t("launch.profileNew")}</option>`;
  for (const p of state.profiles.filter(p => p.modelId === state.selectedModelId)) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  const has = (v) => [...sel.options].some(o => o.value === v);
  if (current && has(current)) {
    // 弹窗打开期间的重渲染（语言切换、保存/删除后）：保留用户当前选择
    sel.value = current;
  } else {
    // 无当前选择（打开弹窗 / 切换模型后）：回退到本模型上次使用的配置并回填表单
    const remembered = state.selectedModelId ? localStorage.getItem(launchProfileKey()) : null;
    if (remembered && has(remembered)) {
      sel.value = remembered;
      fillLaunchForm(selectedProfile());
    } else {
      sel.value = "";
      // 记忆的配置已被删除：一并清除，避免下次再匹配
      if (remembered) localStorage.removeItem(launchProfileKey());
    }
  }
  updateProfileButtons();
}

function selectedProfile() {
  return state.profiles.find(p => p.id === $("launch-profile").value) || null;
}

function updateProfileButtons() {
  $("profile-del-btn").classList.toggle("hidden", !selectedProfile());
}

/* 选中配置 → 回填表单 */
function fillLaunchForm(p) {
  if (!p) return;
  $("launch-weights").value = p.weightsPath || "";
  $("launch-name").value = p.instanceName || "";
  $("launch-backend").value = p.backend || "cpu";
  wantedDevice = p.device != null ? { index: p.device, backend: p.backend } : null;
  applyWantedDevice();
  $("launch-port").value = p.port ?? "";
  $("launch-threads").value = p.threads ?? "";
  $("launch-adv-options").value = envToText(p.sessionOptions);
  if (p.executableId && [...$("launch-exec").options].some(o => o.value === p.executableId)
      && $("launch-exec").value !== p.executableId) {
    // 配置指向另一个可执行文件：设备列表随之失效，重新探测（当前选择在探测完成后还原）
    $("launch-exec").value = p.executableId;
    probeDevices(p.executableId);
  }
}

$("launch-profile").onchange = () => {
  fillLaunchForm(selectedProfile());
  // 记住手动选择（含"新配置"），下次打开弹窗按此还原
  if (state.selectedModelId) localStorage.setItem(launchProfileKey(), $("launch-profile").value);
  updateProfileButtons();
};

/* 从当前表单收集配置字段（与启动请求同源） */
function collectProfileFields(name) {
  const fields = {
    name,
    modelId: state.selectedModelId,
    weightsPath: $("launch-weights").value.trim(),
    backend: $("launch-backend").value
  };
  const execId = $("launch-exec").value;
  if (execId) fields.executableId = execId;
  const instanceName = $("launch-name").value.trim();
  if (instanceName) fields.instanceName = instanceName;
  const device = selectedDeviceIndex();
  const port = $("launch-port").value;
  const threads = $("launch-threads").value;
  if (device !== null) fields.device = device;
  if (port !== "") fields.port = parseInt(port, 10);
  if (threads !== "") fields.threads = parseInt(threads, 10);
  const sessionOptions = parseSessionOptionsText();
  if (Object.keys(sessionOptions).length) fields.sessionOptions = sessionOptions;
  return fields;
}

async function saveProfile(url, method, fields, failKey) {
  const msg = $("launch-msg");
  msg.textContent = "";
  if (!fields.weightsPath) { msg.textContent = t("launch.weightsRequired"); return false; }
  try {
    if (method === "PUT") await apiPut(url, fields);
    else await apiPost(url, fields);
    return true;
  } catch (e) {
    msg.textContent = t(failKey) + t("common.colon") + e.message;
    return false;
  }
}

$("profile-save-btn").onclick = async () => {
  const name = (window.prompt(t("profile.namePrompt"), "") || "").trim();
  if (!name) return;
  let fields;
  try {
    fields = collectProfileFields(name);
  } catch (e) {
    $("launch-msg").textContent = e.message;
    return;
  }
  if (await saveProfile("/api/profiles", "POST", fields, "profile.saveFailed")) {
    await loadProfiles();
    const saved = state.profiles.find(p => p.modelId === state.selectedModelId && p.name === name);
    if (saved) {
      $("launch-profile").value = saved.id;
      localStorage.setItem(launchProfileKey(), saved.id);
      updateProfileButtons();
    }
    showToast("info", t("profile.saved", { name }));
  }
};

/* 启动模型时顺带动态保存参数：已有配置则原地更新，否则新建“默认”配置 */
async function autoSaveProfile() {
  try {
    const existing = selectedProfile() || state.profiles.find(p => p.modelId === state.selectedModelId);
    const fields = collectProfileFields(existing ? existing.name : t("profile.autoName"));
    if (!fields.weightsPath) return;
    if (existing) await apiPut("/api/profiles/" + existing.id, fields);
    else await apiPost("/api/profiles", fields);
    await loadProfiles();
    // 记住本次启动实际使用的配置：下次打开弹窗自动选中并回填，无需再手动切换
    const saved = existing
      ? state.profiles.find(p => p.id === existing.id)
      : state.profiles.find(p => p.modelId === state.selectedModelId && p.name === fields.name);
    if (saved) {
      localStorage.setItem(launchProfileKey(), saved.id);
      $("launch-profile").value = saved.id;
      updateProfileButtons();
    }
  } catch (e) { /* 动态保存失败不影响启动结果 */ }
}

$("profile-del-btn").onclick = async () => {
  const p = selectedProfile();
  if (!p || !window.confirm(t("profile.confirmDelete", { name: p.name }))) return;
  try {
    await apiDelete("/api/profiles/" + p.id);
    await loadProfiles();
    showToast("info", t("profile.deleted", { name: p.name }));
  } catch (e) {
    showToast("error", t("profile.deleteFailed") + t("common.colon") + e.message);
  }
};

$("launch-btn").onclick = async () => {
  const msg = $("launch-msg");
  msg.textContent = "";
  const body = {
    modelId: state.selectedModelId,
    weightsPath: $("launch-weights").value.trim(),
    backend: $("launch-backend").value
  };
  const execId = $("launch-exec").value;
  if (execId) body.executableId = execId;
  const name = $("launch-name").value.trim();
  if (name) body.name = name;
  const device = selectedDeviceIndex();
  const port = $("launch-port").value;
  const threads = $("launch-threads").value;
  if (device !== null) body.device = device;
  if (port !== "") body.port = parseInt(port, 10);
  if (threads !== "") body.threads = parseInt(threads, 10);
  let sessionOptions;
  try {
    sessionOptions = parseSessionOptionsText();
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  if (Object.keys(sessionOptions).length) body.sessionOptions = sessionOptions;
  try {
    await apiPost("/api/instances", body);
    closeLaunchModal();
    showToast("info", t("launch.started"));
    refreshInstances();
    // 启动成功即视为一次使用：动态保存参数，模型随之变为“已配置”
    autoSaveProfile();
  } catch (e) {
    msg.textContent = t("launch.failed") + t("common.colon") + e.message;
  }
};
