/* 命令面板（Ctrl/Cmd-K）：聚合面板跳转 / 模型 / 实例，键盘上下选择 + Enter 执行。
   命令执行统一经路由 go()，因此跳转结果会同步到 URL。 */
import { $, el } from "../core/dom.js";
import { I18N, t } from "../core/i18n.js";
import { state } from "../core/state.js";
import { statusText, categoryName } from "../core/format.js";
import { isOpen, focusDialog, restoreDialogFocus, registerOverlay } from "../core/ui.js";
import { go, modelRoute } from "../core/router.js";

let paletteItems = [];
let paletteActive = 0;

function paletteSources() {
  const items = [];
  for (const [route, key] of [
    ["history", "history.title"],
    ["voices", "voices.title"],
    ["downloads", "dl.managerTitle"],
    ["settings", "settings.title"],
  ]) {
    const label = t(key);
    items.push({
      group: t("palette.group.panels"),
      label,
      sub: "#/" + route,
      search: label + " " + route,
      run: () => go("#/" + route),
    });
  }
  for (const m of state.models) {
    const label = I18N.pick(m, "displayName") || m.id;
    items.push({
      group: t("nav.models"),
      label,
      sub: categoryName(m.category),
      search: label + " " + m.id + " " + m.family,
      run: () => go(modelRoute(m.id)),
    });
  }
  for (const inst of state.instances) {
    const label = inst.instanceName || inst.modelId;
    items.push({
      group: t("nav.instances"),
      label,
      sub: statusText(inst.status) + " ｜ #" + inst.id,
      search: label + " " + inst.id + " " + inst.modelId,
      run: () => go("#/instance/" + encodeURIComponent(inst.id)),
    });
  }
  return items;
}

function renderPalette(query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  const all = paletteSources();
  paletteItems = q ? all.filter((it) => it.search.toLowerCase().includes(q)) : all;
  if (paletteActive >= paletteItems.length) paletteActive = 0;
  const list = $("command-palette-list");
  list.innerHTML = "";
  if (!paletteItems.length) {
    const empty = el(`<div class="cp-empty"></div>`);
    empty.textContent = t("palette.empty");
    list.appendChild(empty);
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
    const row = el(
      `<div class="cp-item" id="cp-opt-${i}" role="option" aria-selected="${i === paletteActive}" data-idx="${i}"><span class="cp-item-label"></span><span class="cp-item-sub"></span></div>`,
    );
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
  $("command-palette-list")
    .querySelectorAll(".cp-item")
    .forEach((r) => {
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
  focusDialog($("command-palette"));
  input.focus();
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

$("command-palette-input").addEventListener("input", (e) => {
  paletteActive = 0;
  renderPalette(e.target.value);
});
$("command-palette-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (paletteItems.length) setPaletteActive((paletteActive + 1) % paletteItems.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (paletteItems.length)
      setPaletteActive((paletteActive - 1 + paletteItems.length) % paletteItems.length);
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
    if (isOpen("command-palette")) closeCommandPalette();
    else openCommandPalette();
  }
});

registerOverlay("command-palette", closeCommandPalette);
