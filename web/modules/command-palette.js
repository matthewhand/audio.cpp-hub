/* web/modules/command-palette.js — 命令面板（#88，Ctrl/Cmd-K）
 *
 * 一个扁平搜索框，跳转面板 / 模型 / 实例。候选项由 paletteSources() 现场拼装：
 * 面板项来自 ROUTE_VIEWS，模型项来自 models，实例项来自 instances，因此不需要
 * 额外索引，2s 轮询刷新后候选自动是最新的。
 *
 * 打开/关闭一律走 focusDialog / restoreDialogFocus（async-ui.js），由它负责焦点栈、
 * 背景 inert 与「等焦点目标真的可聚焦」；本模块只管列表渲染与 ↑↓/Enter/Esc 键盘语义。
 * Esc 在输入框里被 stopPropagation，避免和外层的「Esc 关最上层弹窗」抢一次。 */

import { focusDialog, isOpen, restoreDialogFocus } from "./async-ui.js";
import { $, el, t } from "./dom.js";
import { instances, statusText } from "./instances.js";
import { categoryName } from "./models.js";
import { go, modelRoute } from "./routing.js";
import { models } from "./state.js";

/* ---------- 命令面板（Ctrl/Cmd-K）：跳转模型 / 实例 / 面板 ---------- */
let paletteItems = [];
let paletteActive = 0;
function paletteSources() {
  const items = [];
  for (const [route, key] of [["history", "history.title"], ["voices", "voices.title"],
    ["downloads", "dl.managerTitle"], ["settings", "settings.title"]]) {
    const label = t(key);
    items.push({ group: t("palette.group.panels"), label, sub: "#/" + route, search: label + " " + route, run: () => go("#/" + route) });
  }
  for (const m of models) {
    const label = I18N.pick(m, "displayName") || m.id;
    items.push({ group: t("nav.models"), label, sub: categoryName(m.category), search: label + " " + m.id + " " + m.family, run: () => go(modelRoute(m.id)) });
  }
  for (const inst of instances) {
    const label = inst.instanceName || inst.modelId;
    items.push({ group: t("nav.instances"), label, sub: statusText(inst.status) + " ｜ #" + inst.id, search: label + " " + inst.id + " " + inst.modelId, run: () => go("#/instance/" + encodeURIComponent(inst.id)) });
  }
  return items;
}
function renderPalette(query) {
  const q = String(query || "").trim().toLowerCase();
  const all = paletteSources();
  paletteItems = q ? all.filter(it => it.search.toLowerCase().includes(q)) : all;
  if (paletteActive >= paletteItems.length) paletteActive = 0;
  const list = $("command-palette-list");
  list.innerHTML = "";
  if (!paletteItems.length) {
    const empty = el(`<div class="cp-empty"></div>`);
    empty.textContent = t("palette.empty");
    list.appendChild(empty);
    syncPaletteActiveDescendant(); // 空列表也必须同步：否则输入框上的 aria-activedescendant 指向已消失的选项
    return;
  }
  let lastGroup = null;
  paletteItems.forEach((it, i) => {
    if (it.group !== lastGroup) {
      lastGroup = it.group;
      const g = el(`<div class="cp-group"></div>`);
      g.textContent = it.group;
      list.appendChild(g);
    }
    const row = el(`<div class="cp-item" id="cp-opt-${i}" role="option" aria-selected="${i === paletteActive}" data-idx="${i}"><span class="cp-item-label"></span><span class="cp-item-sub"></span></div>`);
    row.querySelector(".cp-item-label").textContent = it.label;
    row.querySelector(".cp-item-sub").textContent = it.sub || "";
    if (i === paletteActive) row.classList.add("active");
    row.onmouseenter = () => setPaletteActive(i);
    row.onclick = () => runPaletteItem(i);
    list.appendChild(row);
  });
  syncPaletteActiveDescendant();
  scrollPaletteActive();
}
function syncPaletteActiveDescendant() {
  const input = $("command-palette-input");
  if (paletteItems.length) input.setAttribute("aria-activedescendant", "cp-opt-" + paletteActive);
  else input.removeAttribute("aria-activedescendant");
}
function setPaletteActive(i) {
  paletteActive = i;
  $("command-palette-list").querySelectorAll(".cp-item").forEach(r => {
    const on = Number(r.dataset.idx) === i;
    r.classList.toggle("active", on);
    r.setAttribute("aria-selected", on ? "true" : "false");
  });
  syncPaletteActiveDescendant();
  scrollPaletteActive();
}
function scrollPaletteActive() {
  const activeEl = $("command-palette-list").querySelector(".cp-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}
export function openCommandPalette() {
  const input = $("command-palette-input");
  input.value = "";
  paletteActive = 0;
  renderPalette("");
  $("command-palette").classList.remove("hidden");
  /* 焦点目标显式给搜索框，别靠「第一个可聚焦元素碰巧是它」：命令面板的键盘语义
     （↑↓ / Enter / 直接打字）全都挂在这个输入框上，焦点落到别处就等于键盘不可用。
     focusDialog 负责等它真的可聚焦——刚摘掉 .hidden 时遮罩的 visibility 过渡
     还没生效，那一瞬 focus() 是空操作（详见 async-ui.js 的 focusWhenRendered）。 */
  focusDialog($("command-palette"), input);
  input.select();
}
export function closeCommandPalette() {
  $("command-palette").classList.add("hidden");
  restoreDialogFocus();
}
function runPaletteItem(i) {
  const it = paletteItems[i];
  if (!it) return;
  closeCommandPalette();
  it.run();
}
$("command-palette-input").addEventListener("input", (e) => { paletteActive = 0; renderPalette(e.target.value); });
$("command-palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (paletteItems.length) setPaletteActive((paletteActive + 1) % paletteItems.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (paletteItems.length) setPaletteActive((paletteActive - 1 + paletteItems.length) % paletteItems.length);
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPaletteItem(paletteActive);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeCommandPalette();
  }
});
$("command-palette").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) closeCommandPalette();
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (isOpen("command-palette")) closeCommandPalette(); else openCommandPalette();
  }
});
