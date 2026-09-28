/* web/modules/sidebar.js — 操作历史侧栏
 *
 * 页头 🕘 打开的全屏面板，也是任务与历史的统一列表：历史记录加载与渲染、
 * 分组（重命名 / 删除 / 移动）与折叠、分组菜单、四要素详情、隐私模式遮罩，
 * 以及把任务行与历史行组装成同一份列表（renderSidebarList，含行节点复用）。
 * 历史记录回填 TTS 表单走 panels 模块的 fillTtsForm。
 *
 * 同 tasks.js：任务行需要本模块的队列接口，本模块的任务行又需要队列，
 * 两模块之间是一处刻意的循环依赖（只在运行期回调里互相调用）。 */

import { parseApiError, renderEmptyState, renderStateError, showSkeleton, showToast } from "./async-ui.js";
import { $, el, markRowEnter } from "./dom.js";
import { t } from "./i18n-bridge.js";
import { fillTtsForm } from "./panels.js";
import { goPanel } from "./routing.js";
import { selectedModel, selectedModelId } from "./state.js";
import { makeTaskRow, taskDetails, taskViews } from "./tasks.js";
import { bindMenuKeys, focusDialog, restoreDialogFocus } from "./ui.js";

/* ---------- 历史全屏面板：页头 🕘 打开；遮罩点击 / × / Esc 关闭 ---------- */
export function openHistoryPanel() {
  const wasHidden = $("history-panel").classList.contains("hidden");
  $("history-panel").classList.remove("hidden");
  if (wasHidden) {
    focusDialog($("history-panel"));
    loadHistory();
  }
}
$("history-btn").onclick = () => goPanel("history");
export function closeHistoryPanel() {
  $("history-panel").classList.add("hidden");
  restoreDialogFocus();
  window.hubPanelClosed("history");
}
$("history-close").onclick = closeHistoryPanel;
$("history-panel").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) closeHistoryPanel();
});

/* ---------- 隐私模式：隐藏历史记录中的提示词，用无关占位文字替代（localStorage hub-privacy 持久化） ---------- */
export function privacyOn() {
  return localStorage.getItem("hub-privacy") === "1";
}
/* 按当前隐私模式刷新历史列表中所有文本预览与切换按钮状态；真实文本保存在 dataset.realText 中 */
export function applyHistoryPrivacy() {
  const btn = $("history-privacy");
  btn.textContent = t("history.privacyBtn");
  btn.classList.toggle("active", privacyOn());
  btn.title = privacyOn() ? t("history.privacyOn") : t("history.privacyOff");
  for (const textEl of document.querySelectorAll("#history-list .history-text")) {
    const real = textEl.dataset.realText || "";
    textEl.textContent = privacyOn() && real ? t("history.masked") : real || t("history.noText");
    if (!privacyOn() && real) textEl.title = real;
    else textEl.removeAttribute("title");
  }
}
$("history-privacy").onclick = () => {
  localStorage.setItem("hub-privacy", privacyOn() ? "0" : "1");
  applyHistoryPrivacy();
};
// 语言切换后占位文字与按钮 title 需随语言刷新
I18N.onChange(applyHistoryPrivacy);
applyHistoryPrivacy();

export function historyModelId() {
  const m = selectedModel();
  return m ? m.id : null;
}

/* 当前模型的 TTS 历史记录（非 TTS 恒为空数组），由 loadHistory 维护，renderSidebarList 消费 */
export let sidebarHistoryItems = [];
/* 当前模型的历史分组（仅 TTS，非 TTS 恒为空数组），由 loadHistory 维护 */
export let sidebarGroups = [];
/* 组折叠状态（内存）：groupId（未分组为 ""）→ true 表示折叠 */
export const groupCollapsed = new Map();
/* 历史行「详情」展开态与内容缓存：taskId → 完整记录；与任务行 taskDetails 同模式，重渲染不丢 */
export const historyDetails = new Map();

export const sidebarRows = new Map();

export async function loadHistory() {
  $("history-list").removeAttribute("aria-busy");
  const modelId = historyModelId();
  const m = selectedModel();
  // 分组仅 TTS 支持：非 TTS 模型隐藏「新建分组」入口
  $("history-group-new").classList.toggle("hidden", !m || m.category !== "tts");
  if (!m || m.category !== "tts") {
    // 非 TTS 无落盘历史，侧栏只展示任务记录
    sidebarGroups = [];
    sidebarHistoryItems = [];
    renderSidebarList();
    return;
  }
  let items, groups;
  // 尚无任何实际行（仅空态/错误态）时显示骨架；后续轮询/刷新复用已有节点，避免闪动
  if (!$("history-list").querySelector(".history-row, .history-group-header")) showSkeleton($("history-list"), 3);
  try {
    const [res, gres] = await Promise.all([
      fetch("/api/history/" + modelId),
      fetch("/api/history/" + modelId + "/groups")
    ]);
    const text = await res.text();
    if (!res.ok) throw parseApiError(text);
    items = JSON.parse(text);
    groups = gres.ok ? await gres.json() : [];
  } catch (e) {
    // 等待响应期间用户可能已切换模型：过期响应直接丢弃，避免覆盖新模型的列表
    if (historyModelId() !== modelId) return;
    sidebarHistoryItems = [];
    sidebarGroups = [];
    renderStateError($("history-list"), e, loadHistory);
    return;
  }
  // 同上：响应晚到时当前模型可能已不是 modelId，过期数据不得渲染
  if (historyModelId() !== modelId) return;
  sidebarHistoryItems = items;
  sidebarGroups = groups;
  // 清理已不在列表中的详情展开缓存（记录被删/淘汰后不留残留）
  const aliveIds = new Set(items.map(i => i.taskId));
  for (const id of historyDetails.keys()) if (!aliveIds.has(id)) historyDetails.delete(id);
  renderSidebarList();
}

export function taskRowSig(task, ctx) {
  return JSON.stringify([task.status, task.position, task.createdAt, task.startedAt, task.finishedAt,
    task.text, task.instanceName, task.error, taskDetails.has(task.id), ctx,
    task.status === "RUNNING" ? Math.floor((Date.now() - (task.startedAt || task.createdAt)) / 1000) : 0]);
}

export function renderSidebarList() {
  const list = $("history-list");
  const modelId = historyModelId();
  if (!modelId) {
    sidebarRows.clear();
    renderEmptyState(list, t("history.empty"));
    return;
  }
  const tasks = [...taskViews.values()].filter(x => x.modelId === modelId);
  const active = tasks.filter(x => x.status === "QUEUED" || x.status === "RUNNING")
    .sort((a, b) => a.createdAt - b.createdAt);
  const finished = tasks.filter(x => x.status !== "QUEUED" && x.status !== "RUNNING")
    .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt));
  const historyIds = new Set(sidebarHistoryItems.map(i => i.taskId));
  const ctx = privacyOn() + ":" + I18N.lang();
  const desired = [];
  const used = new Set();
  const pushRow = (key, sig, make) => {
    used.add(key);
    const cached = sidebarRows.get(key);
    if (cached && cached.sig === sig) { desired.push(cached.node); return; }
    const node = make();
    sidebarRows.set(key, { node, sig });
    desired.push(node);
  };
  for (const task of active) {
    pushRow("t:" + task.id, taskRowSig(task, ctx), () => makeTaskRow(task));
  }
  for (const task of finished) {
    // TTS 成功/失败都已写历史，由历史行代表；CANCELLED 无历史记录，仍需显示
    if (task.category === "tts" && historyIds.has(task.id)) continue;
    pushRow("t:" + task.id, taskRowSig(task, ctx), () => makeTaskRow(task));
  }
  // 历史区按分组展开为渲染序列（组标题行 + 组内记录行；无分组时退化为旧版平直列表）
  for (const row of historyRowsFlattened(modelId, ctx)) {
    if (row.header) { pushRow(row.key, row.sig, row.make); continue; }
    const item = row.item;
    pushRow("h:" + modelId + ":" + item.taskId, JSON.stringify([item, historyDetails.has(item.taskId), ctx]), () => makeHistoryRow(item));
  }
  // 清理不再展示的行缓存（删记录/切模型/任务淘汰）
  for (const key of sidebarRows.keys()) if (!used.has(key)) sidebarRows.delete(key);
  // 按序对齐：仅当某位置节点不符时才 insertBefore（同文档内移动节点不会中断媒体播放）
  for (let i = 0; i < desired.length; i++) {
    if (list.children[i] !== desired[i]) list.insertBefore(desired[i], list.children[i] || null);
  }
  while (list.children.length > desired.length) list.removeChild(list.lastChild);
  if (!desired.length) renderEmptyState(list, t("history.empty"));
}

export function historyRowsFlattened(modelId, ctx) {
  const rows = [];
  if (!sidebarGroups.length) {
    for (const item of sidebarHistoryItems) rows.push({ item });
    return rows;
  }
  const known = new Set(sidebarGroups.map(g => g.id));
  const byGroup = new Map();
  for (const item of sidebarHistoryItems) {
    // 记录指向已不存在的组（异常残留）时按未分组处理，保证记录始终可见
    const gid = item.groupId && known.has(item.groupId) ? item.groupId : "";
    if (!byGroup.has(gid)) byGroup.set(gid, []);
    byGroup.get(gid).push(item);
  }
  const pushSection = (gid, name, alwaysShow) => {
    const items = byGroup.get(gid) || [];
    if (!items.length && !alwaysShow) return;
    const collapsed = groupCollapsed.get(gid) === true;
    rows.push({
      header: true,
      key: "g:" + modelId + ":" + gid,
      sig: JSON.stringify([name, items.length, collapsed, ctx]),
      make: () => makeGroupHeaderRow(gid, name, items.length, collapsed)
    });
    if (collapsed) return;
    for (const item of items) rows.push({ item });
  };
  pushSection("", t("history.groupUngrouped"), false);
  for (const g of sidebarGroups) pushSection(g.id, g.name, true);
  return rows;
}

/* 组标题行：折叠开关 + 组名 + 记录数；命名组带重命名/删除，未分组（gid 为空）无管理按钮 */
export function makeGroupHeaderRow(gid, name, count, collapsed) {
  const row = el(`<div class="history-group-header">
    <button type="button" class="group-toggle"></button>
    <span class="group-name"></span>
    <span class="group-count hint"></span>
    <span class="group-btns"></span>
  </div>`);
  const toggle = row.querySelector(".group-toggle");
  toggle.textContent = collapsed ? "▸" : "▾";
  toggle.onclick = () => { groupCollapsed.set(gid, !collapsed); renderSidebarList(); };
  row.querySelector(".group-name").textContent = name;
  row.querySelector(".group-count").textContent = I18N.plural("history.groupCount", count);
  const btns = row.querySelector(".group-btns");
  if (gid) {
    const ren = el(`<button type="button" class="btn-ghost"></button>`);
    ren.textContent = t("history.groupRename");
    ren.onclick = () => renameGroup(gid, name);
    btns.appendChild(ren);
    const del = el(`<button type="button" class="stop-btn"></button>`);
    del.textContent = t("history.groupDelete");
    del.onclick = () => deleteGroup(gid, name);
    btns.appendChild(del);
  }
  return row;
}

/* ---------- 历史分组操作（仅 TTS） ---------- */
$("history-group-new").onclick = async () => {
  const modelId = historyModelId();
  const m = selectedModel();
  if (!modelId || !m || m.category !== "tts") return;
  const name = window.prompt(t("history.groupNamePrompt"));
  if (!name || !name.trim()) return;
  try {
    const res = await fetch("/api/history/" + modelId + "/groups", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    loadHistory();
  } catch (e) {
    showToast("error", t("history.groupFailed") + t("common.colon") + e.message);
  }
};

export async function renameGroup(gid, oldName) {
  const modelId = historyModelId();
  if (!modelId) return;
  const name = window.prompt(t("history.groupNamePrompt"), oldName);
  if (!name || !name.trim() || name.trim() === oldName) return;
  try {
    const res = await fetch("/api/history/" + modelId + "/groups/" + gid, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() })
    });
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    loadHistory();
  } catch (e) {
    showToast("error", t("history.groupFailed") + t("common.colon") + e.message);
  }
}

/* 删除分组：组内记录回未分组（不删记录），折叠状态一并清理 */
export async function deleteGroup(gid, name) {
  const modelId = historyModelId();
  if (!modelId || !window.confirm(t("history.groupConfirmDelete", { name }))) return;
  try {
    const res = await fetch("/api/history/" + modelId + "/groups/" + gid, { method: "DELETE" });
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    groupCollapsed.delete(gid);
    loadHistory();
  } catch (e) {
    showToast("error", t("history.groupFailed") + t("common.colon") + e.message);
  }
}

export async function moveToGroup(taskId, groupId) {
  const modelId = historyModelId();
  if (!modelId) return;
  try {
    const res = await fetch("/api/history/" + modelId + "/" + taskId + "/group", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupId })
    });
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    showToast("info", t("history.groupMoved"));
    loadHistory();
  } catch (e) {
    showToast("error", t("history.groupFailed") + t("common.colon") + e.message);
  }
}

/* 「移动到分组」弹出菜单：单例元素挂 body，定位到锚按钮旁（与 HF 菜单同模式） */
export let groupMenuEl = null;
export let groupMenuAnchor = null;

export function closeGroupMenu() {
  if (groupMenuEl) groupMenuEl.classList.remove("open");
  groupMenuAnchor = null;
}

export function openGroupMenu(anchor, item) {
  if (!groupMenuEl) {
    groupMenuEl = document.createElement("div");
    groupMenuEl.id = "group-menu";
    groupMenuEl.setAttribute("role", "menu");
    document.body.appendChild(groupMenuEl);
    bindMenuKeys(groupMenuEl, "button");
  }
  groupMenuEl.innerHTML = "";
  const addOpt = (gid, name) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    b.textContent = name;
    b.onclick = () => { closeGroupMenu(); moveToGroup(item.taskId, gid); };
    groupMenuEl.appendChild(b);
  };
  addOpt(null, t("history.groupUngrouped"));
  for (const g of sidebarGroups) addOpt(g.id, g.name);
  closeGroupMenu();
  groupMenuAnchor = anchor;
  groupMenuEl.classList.add("open");
  const r = anchor.getBoundingClientRect();
  const mw = groupMenuEl.offsetWidth, mh = groupMenuEl.offsetHeight;
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  let left = r.left;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  groupMenuEl.style.top = top + "px";
  groupMenuEl.style.left = left + "px";
  const first = groupMenuEl.querySelector("button");
  if (first) first.focus();
}

export function toggleGroupMenu(anchor, item) {
  if (groupMenuAnchor === anchor) { closeGroupMenu(); return; }
  openGroupMenu(anchor, item);
}

document.addEventListener("mousedown", (e) => {
  if (groupMenuAnchor && !e.target.closest("#group-menu") && !e.target.closest(".group-move-btn")) closeGroupMenu();
});
/* Esc 关闭分组菜单；弹窗本身的关闭统一由顶层 Escape 处理器负责（只关最上层） */
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGroupMenu(); });
document.addEventListener("scroll", closeGroupMenu, true);
window.addEventListener("resize", closeGroupMenu);

/* 历史行「详情」展开/收起：展开时拉取完整记录缓存进 historyDetails（重渲染不丢展开态） */
export async function toggleHistoryDetail(item) {
  const modelId = historyModelId();
  if (!modelId) return;
  if (historyDetails.has(item.taskId)) {
    historyDetails.delete(item.taskId);
    renderSidebarList();
    return;
  }
  try {
    const res = await fetch("/api/history/" + modelId + "/" + item.taskId);
    const text = await res.text();
    if (!res.ok) throw new Error(I18N.errText(text));
    historyDetails.set(item.taskId, JSON.parse(text));
    renderSidebarList();
  } catch (e) {
    showToast("error", t("history.detailFailed") + t("common.colon") + e.message);
  }
}

/* 历史记录的快照路径（相对工作目录，可被 /api/audio/info 探测）；无快照返回 null */
export function historyRefPath(m, rec, name) {
  return rec.refs && rec.refs[name] ? "data/history/" + m.id + "/" + rec.taskId + "." + name + ".wav" : null;
}

export function buildHistoryDetail(item, rec) {
  const modelId = historyModelId();
  const panel = el(`<div class="history-detail"></div>`);
  const masked = privacyOn();
  const addSection = (label) => {
    const sec = el(`<div class="detail-section"><div class="detail-label"></div></div>`);
    sec.querySelector(".detail-label").textContent = label;
    panel.appendChild(sec);
    return sec;
  };
  const voice = rec.voice || {};
  // 生成内容
  const textSec = addSection(t("history.detailText"));
  const textEl = el(`<div class="detail-text"></div>`);
  textEl.textContent = masked ? t("history.masked") : rec.text || t("history.noText");
  textSec.appendChild(textEl);
  // 参考音频：ref=主参考音频，emo=情感参考，spkN=VibeVoice 各说话人
  const refs = rec.refs || {};
  const refOrder = { ref: 0, emo: 1 };
  const refNames = Object.keys(refs).sort((a, b) =>
    (refOrder[a] ?? 2) - (refOrder[b] ?? 2) || a.localeCompare(b));
  if (refNames.length || voice.voiceRef) {
    const audioSec = addSection(t("history.detailRefAudio"));
    for (const name of refNames) {
      audioSec.appendChild(buildRefAudioRow(modelId, item.taskId, name, refs[name]));
    }
    if (!refNames.length && voice.voiceRef) {
      const src = el(`<div class="detail-params"></div>`);
      src.textContent = voice.voiceRef + " " + t("history.detailNoSnapshot");
      audioSec.appendChild(src);
    }
  }
  // 参考文本
  if (voice.referenceText) {
    const sec = addSection(t("history.detailRefText"));
    const div = el(`<div class="detail-text"></div>`);
    div.textContent = masked ? t("history.masked") : voice.referenceText;
    sec.appendChild(div);
  }
  // 音色 / 提示词
  const voiceLines = [];
  if (voice.kind === "speaker" && voice.speaker) voiceLines.push("speaker: " + voice.speaker);
  if (voice.instruct) voiceLines.push(masked ? t("history.masked") : voice.instruct);
  if (rec.options && rec.options.instruction) {
    voiceLines.push(masked ? t("history.masked") : String(rec.options.instruction));
  }
  if (rec.language) voiceLines.push("language: " + rec.language);
  if (voiceLines.length) {
    const sec = addSection(t("history.detailVoice"));
    const div = el(`<div class="detail-text"></div>`);
    div.textContent = voiceLines.join("\n");
    sec.appendChild(div);
  }
  // 其余参数（已单独展示的键不再重复）
  const skip = new Set(["voice_samples", "instruction"]);
  const params = [];
  for (const [k, v] of Object.entries(rec.options || {})) {
    if (skip.has(k)) continue;
    params.push(k + "=" + (typeof v === "object" ? JSON.stringify(v) : String(v)));
  }
  if (params.length) {
    const sec = addSection(t("history.detailParams"));
    const div = el(`<div class="detail-params"></div>`);
    div.textContent = params.join("\n");
    sec.appendChild(div);
  }
  return panel;
}

/* 单条参考音频快照：原始文件名 + 懒加载播放 + 下载 */
export function buildRefAudioRow(modelId, taskId, name, origName) {
  const url = "/api/history/" + modelId + "/" + taskId + "/audio/" + name;
  const row = el(`<div class="detail-ref">
    <span class="ref-name"></span>
    <button type="button" class="ref-play btn-ghost"></button>
    <audio controls preload="none" class="hidden"></audio>
    <a class="btn-ghost" download></a>
  </div>`);
  const nameEl = row.querySelector(".ref-name");
  nameEl.textContent = origName || name;
  nameEl.title = nameEl.textContent;
  const audio = row.querySelector("audio");
  const playBtn = row.querySelector(".ref-play");
  playBtn.textContent = t("history.play");
  playBtn.onclick = () => {
    if (!audio.src) { audio.src = url; audio.classList.remove("hidden"); }
    if (audio.paused) audio.play(); else audio.pause();
  };
  audio.onplay = () => { playBtn.textContent = t("history.pause"); };
  audio.onpause = () => { playBtn.textContent = t("history.play"); };
  audio.onended = () => { playBtn.textContent = t("history.play"); };
  const a = row.querySelector("a");
  a.textContent = t("history.download");
  a.href = url;
  a.download = name + "-" + taskId + ".wav";
  return row;
}

/* 单行历史：信息行（时间 / 文本预览 / 时长与大小 / 按钮）+ 成功行内播放与下载；失败行红字显示 error */
export function makeHistoryRow(item) {
  const audioUrl = "/api/history/" + selectedModelId + "/" + item.taskId + "/audio";
  const row = el(`<div class="history-row${item.ok ? "" : " failed"}${sidebarGroups.length ? " grouped" : ""}">
    <div class="history-info">
      <span class="history-time"></span>
      <span class="history-text"></span>
      <span class="history-meta"></span>
      <span class="history-btns">
        <button type="button" class="history-load"></button>
        <button type="button" class="history-del stop-btn"></button>
      </span>
    </div>
  </div>`);
  const timeEl = row.querySelector(".history-time");
  timeEl.textContent = I18N.date(item.time);
  const textEl = row.querySelector(".history-text");
  // 真实文本存 dataset，隐私模式切换时由 applyHistoryPrivacy 恢复/遮蔽
  textEl.dataset.realText = item.text || "";
  textEl.textContent = privacyOn() && item.text ? t("history.masked") : item.text || t("history.noText");
  if (item.text && !privacyOn()) textEl.title = item.text;
  const meta = [];
  if (item.ok && item.result) {
    if (item.result.durationSec != null) meta.push(item.result.durationSec.toFixed(1) + "s");
    if (item.result.size != null) meta.push(WavUtil.formatSize(item.result.size));
  }
  if (item.instanceName) meta.push(item.instanceName);
  row.querySelector(".history-meta").textContent = meta.join(" ｜ ");
  if (!item.ok) {
    const err = el(`<div class="error-text history-error"></div>`);
    err.textContent = item.error || t("history.failedBadge");
    if (item.error) err.title = item.error;
    row.appendChild(err);
  } else {
    // 懒加载：不预设 src，只有点击“播放”时才向后端拉取 wav 文件
    const player = el(`<div class="history-player">
      <button type="button" class="history-play btn-ghost"></button>
      <audio controls preload="none" class="hidden"></audio>
      <a class="btn-ghost" download></a>
    </div>`);
    const audio = player.querySelector("audio");
    const playBtn = player.querySelector(".history-play");
    playBtn.textContent = t("history.play");
    playBtn.onclick = () => {
      if (!audio.src) {
        audio.src = audioUrl;
        audio.classList.remove("hidden");
      }
      if (audio.paused) audio.play();
      else audio.pause();
    };
    audio.onplay = () => { playBtn.textContent = t("history.pause"); };
    audio.onpause = () => { playBtn.textContent = t("history.play"); };
    audio.onended = () => { playBtn.textContent = t("history.play"); };
    const a = player.querySelector("a");
    a.textContent = t("history.download");
    a.href = audioUrl;
    a.download = "tts-" + item.taskId + ".wav";
    row.appendChild(player);
  }
  const loadBtn = row.querySelector(".history-load");
  loadBtn.textContent = t("history.load");
  loadBtn.onclick = () => loadHistoryRecord(item.taskId);
  const delBtn = row.querySelector(".history-del");
  delBtn.textContent = t("history.delete");
  delBtn.onclick = () => deleteHistoryItem(item.taskId);
  // 「详情」：行内展开四要素完整内容；「移动」：弹出菜单移入分组（仅 TTS 历史有分组）
  const btns = row.querySelector(".history-btns");
  const detailBtn = el(`<button type="button"></button>`);
  detailBtn.textContent = historyDetails.has(item.taskId) ? t("task.collapse") : t("task.detail");
  detailBtn.onclick = () => toggleHistoryDetail(item);
  btns.insertBefore(detailBtn, loadBtn);
  const moveBtn = el(`<button type="button" class="group-move-btn"></button>`);
  moveBtn.textContent = t("history.groupMove");
  moveBtn.onclick = () => toggleGroupMenu(moveBtn, item);
  btns.insertBefore(moveBtn, loadBtn);
  if (historyDetails.has(item.taskId)) {
    row.appendChild(buildHistoryDetail(item, historyDetails.get(item.taskId)));
  }
  return markRowEnter(row, "h:" + selectedModelId + ":" + item.taskId);
}

export async function deleteHistoryItem(taskId) {
  const modelId = historyModelId();
  if (!modelId) return;
  try {
    const res = await fetch("/api/history/" + modelId + "/" + taskId, { method: "DELETE" });
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    // 对应的任务记录一并删除：否则侧栏去重失效，该行会以无按钮的「已完成」任务行复活
    //（旧 /api/run 同步链路的历史没有任务记录，404 属正常）
    const taskRes = await fetch("/api/tasks/" + taskId, { method: "DELETE" });
    if (!taskRes.ok && taskRes.status !== 404) throw new Error(I18N.errText(await taskRes.text()));
    taskViews.delete(taskId);
    taskDetails.delete(taskId);
    historyDetails.delete(taskId);
    loadHistory();
  } catch (e) {
    showToast("error", t("history.deleteFailed") + t("common.colon") + e.message);
  }
}

$("history-refresh").onclick = loadHistory;

export async function deleteFinishedTasks(modelId) {
  const finished = [...taskViews.values()].filter(x =>
    x.modelId === modelId && x.status !== "QUEUED" && x.status !== "RUNNING");
  for (const task of finished) {
    const res = await fetch("/api/tasks/" + task.id, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw new Error(I18N.errText(await res.text()));
    taskViews.delete(task.id);
    taskDetails.delete(task.id);
  }
}

$("history-clear").onclick = async () => {
  const modelId = historyModelId();
  const m = selectedModel();
  if (!modelId || !m || !window.confirm(t("history.confirmClear"))) return;
  if (m.category !== "tts") {
    // 非 TTS 无落盘历史：只删该模型已结束的任务记录
    try {
      await deleteFinishedTasks(modelId);
      renderSidebarList();
    } catch (e) {
      showToast("error", t("history.clearFailed") + t("common.colon") + e.message);
    }
    return;
  }
  try {
    const res = await fetch("/api/history/" + modelId, { method: "DELETE" });
    if (!res.ok) throw new Error(I18N.errText(await res.text()));
    await deleteFinishedTasks(modelId);
    loadHistory();
  } catch (e) {
    showToast("error", t("history.clearFailed") + t("common.colon") + e.message);
  }
};

/* "载入"：拉取单条完整记录回填 TTS 表单（提交组装 / collectParams 的逆操作） */
export async function loadHistoryRecord(taskId) {
  const modelId = historyModelId();
  const m = selectedModel();
  if (!modelId || !m) return;
  let rec;
  try {
    const res = await fetch("/api/history/" + modelId + "/" + taskId);
    const text = await res.text();
    if (!res.ok) throw new Error(I18N.errText(text));
    rec = JSON.parse(text);
  } catch (e) {
    showToast("error", t("history.loadFailed") + t("common.colon") + e.message);
    return;
  }
  fillTtsForm(m, rec);
  showToast("info", t("history.loaded"));
}
