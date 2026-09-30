/* web/modules/launch.js — 启动模型弹窗
 *
 * 可执行文件选择、设备探测（--list-devices 结果按 execId 缓存）、权重路径、
 * 启动配置（Profile：选择 / 回填 / 保存 / 动态更新）与最终的启动请求。
 * 启动成功后刷新实例列表。 */

import { focusDialog, restoreDialogFocus, showToast } from "./async-ui.js";
import { $, Api, t } from "./dom.js";
import { browseServerFile } from "./file-browser-lazy.js";
import { refreshInstances } from "./instances.js";
import { renderModelList } from "./models.js";
import { go, setPendingSettingsSection } from "./routing.js";
import { deviceCache, editingExecId, envToText, loadExecutables, parseEnvText, parseSessionOptionsText, resetExecForm } from "./settings-lazy.js";
import { executables, models, profiles, selectedModelId, setProfiles } from "./state.js";

/* ---------- 启动模型 modal ---------- */
export const launchModal = $("launch-modal");
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

/* 权重目录：服务器端文件选择器（目录模式） */
$("weights-browse-btn").onclick = async () => {
  const path = await browseServerFile({
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
  const path = await browseServerFile({
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
  const path = await browseServerFile({
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

/* 可执行文件为空时，点击下拉框直接跳转到设置页的可执行文件面板 */
$("launch-exec").addEventListener("mousedown", (e) => {
  if (executables.length === 0) {
    e.preventDefault();
    setPendingSettingsSection("executables");
    go("#/settings");
  }
});

/* 探测输出中的后端名（ggml 注册名，不区分大小写）→ 启动表单的后端值，ROCm 对应 hip */
export const DEVICE_BACKEND_MAP = { cuda: "cuda", vulkan: "vulkan", metal: "metal", hip: "hip", rocm: "hip", cpu: "cpu" };

/* 期望选中的设备（{index, backend}）：配置回填时探测可能尚未完成，选项渲染后据此还原 */
export let wantedDevice = null;

/* 探测指定可执行文件的设备并刷新下拉框；成功的结果按 execId 缓存，失败不缓存（下次重试） */
export async function probeDevices(execId) {
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
    const data = await Api.get("/api/executables/{execId}/devices", { params: { execId } });
    const devices = data.devices || [];
    deviceCache[execId] = devices;
    // 探测期间用户可能已切换程序：仅当仍是当前选择时才渲染
    if ($("launch-exec").value === execId) renderDeviceOptions(devices);
  } catch (e) {
    if ($("launch-exec").value === execId) renderDeviceOptions([]);
    showToast("error", t("launch.deviceDetectFailed") + t("common.colon") + e.message);
  }
}

export function renderDeviceOptions(devices) {
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
export function applyWantedDevice() {
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
export function selectedDeviceIndex() {
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
    // 新增 / 编辑同一段代码：method 决定 URL 与动词
    await Api.request(editing ? "/api/executables/{id}" : "/api/executables", {
      method: editing ? "PUT" : "POST",
      body,
      params: editing ? { id: editingExecId } : undefined
    });
    resetExecForm();
    loadExecutables();
  } catch (e) {
    msg.textContent = t(editing ? "exec.saveFailed" : "exec.addFailed") + t("common.colon") + e.message;
  }
};

/* ---------- 快速启动 ---------- */
/* 权重目录路径按模型持久化到 localStorage */
export const weightsKey = () => "hub-weights-" + selectedModelId;
export function restoreWeightsPath() {
  $("launch-weights").value = localStorage.getItem(weightsKey()) || "";
}
$("launch-weights").addEventListener("input", (e) => {
  if (selectedModelId) localStorage.setItem(weightsKey(), e.target.value.trim());
});

/* 线程数全局持久化 */
$("launch-threads").value = localStorage.getItem("hub-threads") || "";
$("launch-threads").addEventListener("input", (e) => {
  localStorage.setItem("hub-threads", e.target.value.trim());
});

/* 空闲卸载毫秒数全局持久化（空 = 模型常驻显存） */
$("launch-idle-unload").value = localStorage.getItem("hub-idle-unload") || "";
$("launch-idle-unload").addEventListener("input", (e) => {
  localStorage.setItem("hub-idle-unload", e.target.value.trim());
});

/* ---------- 启动配置（Profile）：持久化到后端 data/profiles.json ---------- */
export async function loadProfiles() {
  try {
    setProfiles(await Api.list("/api/profiles"));
  } catch (e) {
    setProfiles([]);
    return;
  }
  renderLaunchProfiles();
  // 配置变化会影响模型列表的可用/黯淡展示
  if (models.length) renderModelList();
}

/* 启动配置选择记忆：按模型存 localStorage，打开弹窗时自动选中并回填上次使用的配置 */
export const launchProfileKey = () => "hub-launch-profile-" + selectedModelId;

/* 下拉只显示当前模型的配置 */
export function renderLaunchProfiles() {
  const sel = $("launch-profile");
  const current = sel.value;
  sel.innerHTML = `<option value="">${t("launch.profileNew")}</option>`;
  for (const p of profiles.filter(p => p.modelId === selectedModelId)) {
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
    const remembered = selectedModelId ? localStorage.getItem(launchProfileKey()) : null;
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

export function selectedProfile() {
  return profiles.find(p => p.id === $("launch-profile").value) || null;
}

export function updateProfileButtons() {
  $("profile-del-btn").classList.toggle("hidden", !selectedProfile());
}

/* 选中配置 → 回填表单 */
export function fillLaunchForm(p) {
  if (!p) return;
  $("launch-weights").value = p.weightsPath || "";
  $("launch-name").value = p.instanceName || "";
  $("launch-backend").value = p.backend || "cpu";
  wantedDevice = p.device != null ? { index: p.device, backend: p.backend } : null;
  applyWantedDevice();
  $("launch-port").value = p.port ?? "";
  $("launch-threads").value = p.threads ?? "";
  $("launch-idle-unload").value = p.idleUnloadMs ?? "";
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
  if (selectedModelId) localStorage.setItem(launchProfileKey(), $("launch-profile").value);
  updateProfileButtons();
};

/* 从当前表单收集配置字段（与启动请求同源） */
export function collectProfileFields(name) {
  const fields = {
    name,
    modelId: selectedModelId,
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
  const idleUnload = $("launch-idle-unload").value;
  if (idleUnload !== "") fields.idleUnloadMs = parseInt(idleUnload, 10);
  const sessionOptions = parseSessionOptionsText();
  if (Object.keys(sessionOptions).length) fields.sessionOptions = sessionOptions;
  return fields;
}

/* 保存启动配置：existingId 为空表示新建，否则原地更新。失败信息写入弹窗并返回 false */
export async function saveProfile(existingId, fields, failKey) {
  const msg = $("launch-msg");
  msg.textContent = "";
  if (!fields.weightsPath) { msg.textContent = t("launch.weightsRequired"); return false; }
  try {
    if (existingId) await Api.put("/api/profiles/{id}", fields, { params: { id: existingId } });
    else await Api.post("/api/profiles", fields);
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
  if (await saveProfile(null, fields, "profile.saveFailed")) {
    await loadProfiles();
    const saved = profiles.find(p => p.modelId === selectedModelId && p.name === name);
    if (saved) {
      $("launch-profile").value = saved.id;
      localStorage.setItem(launchProfileKey(), saved.id);
      updateProfileButtons();
    }
    showToast("info", t("profile.saved", { name }));
  }
};

/* 启动模型时顺带动态保存参数：已有配置则原地更新，否则新建“默认”配置 */
export async function autoSaveProfile() {
  try {
    const existing = selectedProfile() || profiles.find(p => p.modelId === selectedModelId);
    const fields = collectProfileFields(existing ? existing.name : t("profile.autoName"));
    if (!fields.weightsPath) return;
    // 保存失败不影响启动结果（显式吞掉错误，配置列表仍按服务端现状刷新）
    try {
      if (existing) await Api.put("/api/profiles/{id}", fields, { params: { id: existing.id } });
      else await Api.post("/api/profiles", fields);
    } catch (e) { /* 动态保存失败不影响启动结果 */ }
    await loadProfiles();
    // 记住本次启动实际使用的配置：下次打开弹窗自动选中并回填，无需再手动切换
    const saved = existing
      ? profiles.find(p => p.id === existing.id)
      : profiles.find(p => p.modelId === selectedModelId && p.name === fields.name);
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
    // 删除失败不单独提示：配置列表以下一次 loadProfiles 的结果为准（显式吞掉错误）
    await Api.del("/api/profiles/{id}", { params: { id: p.id } }).catch(() => {});
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
    modelId: selectedModelId,
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
  const idleUnload = $("launch-idle-unload").value;
  if (idleUnload !== "") body.idleUnloadMs = parseInt(idleUnload, 10);
  let sessionOptions;
  try {
    sessionOptions = parseSessionOptionsText();
  } catch (e) {
    msg.textContent = e.message;
    return;
  }
  if (Object.keys(sessionOptions).length) body.sessionOptions = sessionOptions;
  try {
    await Api.post("/api/instances", body);
    closeLaunchModal();
    showToast("info", t("launch.started"));
    refreshInstances();
    // 启动成功即视为一次使用：动态保存参数，模型随之变为“已配置”
    autoSaveProfile();
  } catch (e) {
    msg.textContent = t("launch.failed") + t("common.colon") + e.message;
  }
};
