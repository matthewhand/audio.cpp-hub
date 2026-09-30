/* web/modules/voices-panel.js — 音色库管理面板（**懒加载 chunk**）
 *
 * 页头 🎙 打开的全屏面板：上半为音色列表（试听 / 行内编辑名称与文本 / 删除 /
 * 「用于 TTS」），下半为添加区（名称 + 文本 + AudioPicker 取音频）。音色是全局资源：
 * 名称（唯一）+ 音频文本内容 + 音频文件；增删改成功后刷新所有 VoiceSelect。
 *
 * 所有调用场景都是「点一下 🎙 才用得上」，因此本模块**不在首屏模块图**里：
 * 调用方经 modules/voices-panel-lazy.js 的 import("./voices-panel.js") 按需拉取
 * （见该文件；本模块自身的字节只在真的打开音色库时才付给浏览器）。
 *
 * 曾经是经典脚本 web/voices-panel.js（IIFE + window.openVoicesPanel），随
 * perf:budget 的棘轮改成 ES 模块懒加载 chunk，实测表见 scripts/perf-budget.mjs 顶注。
 * 因此不再需要 window.renderStateError / renderEmptyState / focusDialog 之类的
 * 桥接转发器：模块侧直接从 async-ui.js / dom.js import。
 *
 * 按钮与事件都在本模块求值时（即首次打开时）绑定；页头 🎙 与 #/voices 路由由外观层
 * web/modules/voices-panel-lazy.js 接线，不依赖本模块已加载。 */

import { focusDialog, renderEmptyState, renderStateError, restoreDialogFocus, showToast } from "./async-ui.js";
import { $, Api, t } from "./dom.js";

let addPicker = null;   // 添加区的 AudioPicker（延迟到首次打开时创建）
let voices = [];

export function openVoicesPanel() {
  $("voices-panel").classList.remove("hidden");
  focusDialog($("voices-panel"));
  if (!addPicker) {
    addPicker = new AudioPicker($("voice-add-picker"), "voices.addAudio");
    // 管理面板里添加音色时，"音色库"页签无意义（从库选库），隐藏
    const libTab = addPicker.root.querySelector('.picker-tab[data-tab="library"]');
    if (libTab) libTab.style.display = "none";
  }
  loadVoices();
}

export function closeVoicesPanel() {
  $("voices-panel").classList.add("hidden");
  restoreDialogFocus();
  if (window.hubPanelClosed) window.hubPanelClosed("voices");
}

/* ---------- 首屏不需要的接线：全部在 chunk 求值（首次打开）时绑定 ---------- */
$("voices-close").onclick = closeVoicesPanel;
$("voices-search").addEventListener("input", renderVoicesList);
$("voices-panel").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) closeVoicesPanel();
});

/* ---------- 列表 ---------- */
async function loadVoices() {
  try {
    voices = await Api.list("/api/voices");
  } catch (e) {
    voices = [];
    renderStateError($("voices-list"), e, loadVoices);
    return;
  }
  renderVoicesList();
}

function renderVoicesList() {
  const list = $("voices-list");
  list.innerHTML = "";
  // 搜索过滤：名称或文本内容子串匹配（大小写不敏感）
  const q = ($("voices-search").value || "").trim().toLowerCase();
  const shown = q
    ? voices.filter(v =>
        v.name.toLowerCase().includes(q) || (v.text || "").toLowerCase().includes(q))
    : voices;
  if (!voices.length) {
    renderEmptyState(list, t("voices.empty"), {
      label: t("voices.addTitle"),
      onClick: () => { const n = $("voice-add-name"); if (n) n.focus(); }
    });
    return;
  }
  if (!shown.length) {
    const hint = document.createElement("div");
    hint.className = "hint history-empty";
    hint.textContent = t("voices.searchEmpty");
    list.appendChild(hint);
    return;
  }
  for (const v of shown) list.appendChild(makeVoiceRow(v));
}

/* 单行音色：名称 + 时长 + 文本预览 + 试听/编辑/删除；编辑态行内改名与文本 */
function makeVoiceRow(v) {
  const row = document.createElement("div");
  row.className = "voice-row";
  const info = document.createElement("div");
  info.className = "voice-info";
  const name = document.createElement("span");
  name.className = "voice-name";
  name.textContent = v.name;
  const meta = document.createElement("span");
  meta.className = "voice-meta hint";
  meta.textContent = (v.durationSec ? WavUtil.formatDuration(v.durationSec) : "")
    + (v.text ? " ｜ " + (v.text.length > 40 ? v.text.slice(0, 40) + "…" : v.text) : "");
  if (v.text) meta.title = v.text;
  info.appendChild(name);
  info.appendChild(meta);
  const btns = document.createElement("span");
  btns.className = "voice-btns";

  const audio = document.createElement("audio");
  audio.preload = "none";
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "btn-ghost";
  playBtn.textContent = t("voiceSelect.play");
  playBtn.onclick = () => {
    if (audio.paused) {
      if (!audio.src) audio.src = "/api/voices/" + v.vid + "/audio";
      audio.play();
    } else audio.pause();
  };
  audio.onplay = () => { playBtn.textContent = t("voiceSelect.pause"); };
  audio.onpause = () => { playBtn.textContent = t("voiceSelect.play"); };
  audio.onended = () => { playBtn.textContent = t("voiceSelect.play"); };
  row.appendChild(audio);

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "btn-ghost";
  editBtn.textContent = t("voices.edit");
  editBtn.onclick = () => enterEdit(row, v);

  const useBtn = document.createElement("button");
  useBtn.type = "button";
  useBtn.className = "btn-ghost";
  useBtn.textContent = t("voices.useInTts");
  useBtn.title = t("voices.useInTtsTip");
  useBtn.onclick = () => useVoiceInTts(v);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "stop-btn";
  delBtn.textContent = t("voices.delete");
  delBtn.onclick = () => deleteVoice(v);

  btns.appendChild(playBtn);
  btns.appendChild(useBtn);
  btns.appendChild(editBtn);
  btns.appendChild(delBtn);
  row.appendChild(info);
  row.appendChild(btns);
  return row;
}

/* 「用于 TTS」：跳到 breeze 的克隆模式并选中该音色（breeze 是当前唯一克隆入口） */
function useVoiceInTts(v) {
  if (window.hubNavigate) window.hubNavigate("#/model/breeze-tts");
  closeVoicesPanel();
  // 面板渲染是异步链（selectModelById → renderWorkspace），轮询等待 breeze 克隆控件就绪
  let tries = 0;
  const timer = setInterval(() => {
    const modeSel = document.getElementById("tts-breeze-mode");
    const pickerRoot = /** @type {any} */ (document.getElementById("voice-picker"));
    const vs = pickerRoot && pickerRoot.__voiceSelect;
    if (modeSel && vs) {
      clearInterval(timer);
      modeSel.value = "voice_clone";
      modeSel.dispatchEvent(new Event("change"));
      vs.setVoice(v.vid);
      return;
    }
    if (++tries > 20) clearInterval(timer);
  }, 100);
}

/* 行内编辑：名称 input + 文本 textarea + 保存/取消 */
function enterEdit(row, v) {
  row.innerHTML = "";
  row.classList.add("editing");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = v.name;
  nameInput.className = "voice-edit-name";
  const textInput = document.createElement("textarea");
  textInput.rows = 2;
  textInput.value = v.text || "";
  textInput.placeholder = t("voices.textPlaceholder");
  textInput.className = "voice-edit-text";
  const btns = document.createElement("div");
  btns.className = "voice-edit-btns";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn";
  saveBtn.textContent = t("voices.save");
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn-ghost";
  cancelBtn.textContent = t("voices.cancel");
  const msg = document.createElement("span");
  msg.className = "hint";
  saveBtn.onclick = async () => {
    msg.textContent = "";
    try {
      await Api.put("/api/voices/{vid}", { name: nameInput.value, text: textInput.value }, { params: { vid: v.vid } });
      afterChange();
    } catch (e) {
      msg.textContent = e.message;
    }
  };
  cancelBtn.onclick = () => renderVoicesList();
  btns.appendChild(saveBtn);
  btns.appendChild(cancelBtn);
  btns.appendChild(msg);
  row.appendChild(nameInput);
  row.appendChild(textInput);
  row.appendChild(btns);
  nameInput.focus();
}

async function deleteVoice(v) {
  if (!window.confirm(t("voices.confirmDelete", { name: v.name }))) return;
  try {
    await Api.del("/api/voices/{vid}", { params: { vid: v.vid } });
    afterChange();
  } catch (e) {
    showToast("error", t("voices.deleteFailed") + t("common.colon") + e.message);
  }
}

/* ---------- 添加 ---------- */
$("voice-add-btn").onclick = async () => {
  const nameEl = $("voice-add-name");
  const textEl = $("voice-add-text");
  const msg = $("voice-add-msg");
  msg.textContent = "";
  const name = nameEl.value.trim();
  const path = addPicker ? addPicker.getValue() : null;
  if (!name) { msg.textContent = t("voices.errNoName"); return; }
  if (!path) { msg.textContent = t("voices.errNoAudio"); return; }
  const body = { name, text: textEl.value.trim() };
  // AudioPicker 上传/录制/裁剪后有 uploadId；本地路径则直接传 path
  if (addPicker.uploadId) body.uploadId = addPicker.uploadId;
  else body.path = path;
  try {
    await Api.post("/api/voices", body);
    nameEl.value = "";
    textEl.value = "";
    addPicker.clear();
    showToast("info", t("voices.added", { name }));
    afterChange();
  } catch (e) {
    msg.textContent = e.message;
  }
};

/* 增删改后的统一收尾：刷新面板列表 + 全部 VoiceSelect */
function afterChange() {
  loadVoices();
  if (window.refreshVoiceSelects) window.refreshVoiceSelects();
}
