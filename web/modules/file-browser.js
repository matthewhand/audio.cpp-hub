/* web/modules/file-browser.js — 服务器端文件选择器（**懒加载 chunk**）
 *
 * 用途：浏览 hub 所在机器的文件系统（浏览器原生选择器只能选客户端文件）。
 * 所有调用点都是「点一下浏览…」才用得上，因此本模块**不在首屏模块图**里：
 * 调用方经 modules/file-browser-lazy.js 的 import("./file-browser.js") 按需拉取
 * （见该文件；本模块自身的字节只在真的要浏览服务器文件时才付给浏览器）。
 *
 * 用法：const path = await browseServerFile({
 *           mode: "file" | "dir",   // file=选文件，dir=选目录
 *           title: "选择文件",
 *           extensions: [".wav"],   // 可选，仅 file 模式；自动附带“所有文件”选项
 *           startPath: "D:/models"  // 可选，初始目录
 *         });
 *       用户取消时返回 null。
 *
 * 曾经是经典脚本 web/file-browser.js（挂 window.FileBrowser），随 perf:budget 的
 * 棘轮改成 ES 模块懒加载 chunk，实测表见 scripts/perf-budget.mjs 顶注。 */

import { focusDialog, restoreDialogFocus } from "./async-ui.js";
import { Api, t } from "./dom.js";

let overlay = null;
let resolvePromise = null;
let opts = null;
let cwd = "";              // 当前目录（"" 表示根列表视图）
let cwdParent = "";
let entries = [];          // 当前目录条目（服务端已按目录优先排序）
let selectedPath = null;   // 列表中选中的条目
let selectedIsDir = false;
let extFilter = "";        // 生效的扩展名过滤，"" 为全部
let showHidden = false;

/* overlay 内部查询。刻意不叫 $：那是 dom.js 绑定 window.$ 的全站入口，
   本文件只在自己的 overlay 里查，用不上全站选择器。 */
const q = (sel) => overlay.querySelector(sel);

function buildOverlay() {
  overlay = document.createElement("div");
  overlay.id = "fb-overlay";
  overlay.className = "modal-overlay fb-overlay hidden";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "fb-title");
  overlay.innerHTML = `
    <div class="modal fb-modal">
      <div class="modal-header">
        <span class="modal-title fb-title" id="fb-title">${t("fb.titleFile")}</span>
        <button type="button" class="modal-close fb-close" aria-label="${t("history.closeTitle")}">×</button>
      </div>
      <div class="fb-toolbar">
        <button type="button" class="fb-up" title="${t("fb.upTitle")}" aria-label="${t("fb.upTitle")}">${t("fb.up")}</button>
        <input type="text" class="fb-path" aria-label="${t("fb.pathPlaceholder")}" placeholder="${t("fb.pathPlaceholder")}">
        <button type="button" class="fb-go">${t("fb.go")}</button>
        <button type="button" class="fb-refresh" title="${t("fb.refreshTitle")}" aria-label="${t("fb.refreshTitle")}">⟳</button>
      </div>
      <div class="fb-roots"></div>
      <div class="fb-subbar">
        <input type="text" class="fb-search" aria-label="${t("fb.searchPlaceholder")}" placeholder="${t("fb.searchPlaceholder")}">
        <select class="fb-ext hidden" aria-label="${t("fb.extLabel")}"></select>
        <label class="checkbox-label fb-hidden-toggle"><input type="checkbox" class="fb-hidden"> ${t("fb.showHidden")}</label>
        <button type="button" class="fb-mkdir">${t("fb.mkdir")}</button>
      </div>
      <div class="fb-list" role="listbox" aria-label="${t("fb.listLabel")}"></div>
      <div class="fb-footer">
        <span class="fb-selection" title=""></span>
        <button type="button" class="fb-pick-current btn-ghost hidden">${t("fb.pickCurrent")}</button>
        <button type="button" class="fb-cancel">${t("fb.cancel")}</button>
        <button type="button" class="fb-confirm btn" disabled>${t("fb.confirm")}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  q(".fb-close").onclick = () => cancel();
  q(".fb-cancel").onclick = () => cancel();
  overlay.onclick = (e) => { if (e.target === overlay) cancel(); };
  q(".fb-up").onclick = () => goUp();
  q(".fb-go").onclick = () => navigate(q(".fb-path").value.trim());
  q(".fb-path").onkeydown = (e) => { if (e.key === "Enter") navigate(q(".fb-path").value.trim()); };
  q(".fb-refresh").onclick = () => cwd ? navigate(cwd) : showRoots();
  q(".fb-search").oninput = renderList;
  q(".fb-ext").onchange = (e) => { extFilter = e.target.value; renderList(); };
  q(".fb-hidden").onchange = (e) => { showHidden = e.target.checked; renderList(); };
  q(".fb-mkdir").onclick = mkdir;
  q(".fb-confirm").onclick = confirmSelection;
  q(".fb-pick-current").onclick = () => finish(cwd || null);

  // Esc 关闭：capture 阶段拦截，避免触发下层 modal 的 Esc 处理
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) {
      e.stopPropagation();
      cancel();
    }
  }, true);
}

function isOpen() {
  return overlay && !overlay.classList.contains("hidden");
}

export async function open(options) {
  if (!overlay) buildOverlay();
  if (isOpen()) cancel(); // 已有打开的实例：按取消处理
  opts = options || {};
  cwd = "";
  cwdParent = "";
  entries = [];
  selectedPath = null;
  extFilter = "";
  showHidden = false;
  q(".fb-hidden").checked = false;
  q(".fb-search").value = "";
  q(".fb-title").textContent = opts.title || (opts.mode === "dir" ? t("fb.titleDir") : t("fb.titleFile"));
  q(".fb-pick-current").classList.toggle("hidden", opts.mode !== "dir");
  buildExtFilter();
  loadRoots();
  overlay.classList.remove("hidden");
  focusDialog(overlay);
  const start = (opts.startPath || "").trim();
  if (start) {
    navigate(start);
  } else {
    showRoots();
  }
  return new Promise((resolve) => { resolvePromise = resolve; });
}

function buildExtFilter() {
  const sel = q(".fb-ext");
  sel.innerHTML = "";
  const exts = opts.mode === "dir" ? null : (opts.extensions || []);
  if (!exts || exts.length === 0) {
    sel.classList.add("hidden");
    return;
  }
  for (const ext of exts) {
    const opt = document.createElement("option");
    opt.value = ext;
    opt.textContent = "*" + ext;
    sel.appendChild(opt);
  }
  const all = document.createElement("option");
  all.value = "";
  all.textContent = t("fb.allFiles");
  sel.appendChild(all);
  // defaultAll：默认不过滤（如 Linux 下可执行文件无扩展名）
  sel.value = opts.defaultAll ? "" : exts[0];
  extFilter = sel.value;
  sel.classList.remove("hidden");
}

/* ---------- 导航 ---------- */
async function loadRoots() {
  const bar = q(".fb-roots");
  bar.innerHTML = "";
  let roots;
  try {
    roots = await Api.list("/api/fs/roots");
  } catch (e) {
    return;
  }
  for (const r of roots) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "fb-root-chip";
    chip.textContent = r.name;
    chip.onclick = () => navigate(r.path);
    bar.appendChild(chip);
  }
}

function showRoots() {
  cwd = "";
  cwdParent = "";
  entries = [];
  selectedPath = null;
  q(".fb-path").value = "";
  renderList();
  setStatus(t("fb.selectRoot"));
}

function goUp() {
  if (cwdParent) {
    navigate(cwdParent);
  } else {
    showRoots();
  }
}

async function navigate(path) {
  if (!path) { showRoots(); return; }
  setStatus(t("fb.loading"));
  try {
    const data = await Api.get("/api/fs/list", { query: { path } });
    cwd = data.path;
    cwdParent = data.parent || "";
    entries = data.entries || [];
    selectedPath = null;
    q(".fb-path").value = cwd;
    renderList();
    setStatus("");
  } catch (e) {
    // 服务端已回应但拒绝：输入的是文件路径 → 跳到其父目录并选中该文件
    if (e && e.status) {
      const parent = parentOf(path);
      if (parent && parent !== path) {
        await navigateInto(parent, path);
        return;
      }
    }
    setStatus(t(e && e.status ? "fb.cannotOpen" : "fb.loadFailed", { msg: e.message || e }));
  }
}

/* 进入目录并选中指定条目（用于“输入完整文件路径后跳转”） */
async function navigateInto(dirPath, selectPath) {
  let data;
  try {
    data = await Api.get("/api/fs/list", { query: { path: dirPath } });
  } catch (e) {
    // 网络 / 超时错误上抛，交调用方 navigate 统一提示；服务端拒绝则就地提示
    if (e && !e.status) throw e;
    setStatus(t("fb.cannotOpen", { msg: e.message || e }));
    return;
  }
  cwd = data.path;
  cwdParent = data.parent || "";
  entries = data.entries || [];
  q(".fb-path").value = cwd;
  const hit = entries.find(e => e.path === selectPath);
  selectedPath = hit ? hit.path : null;
  selectedIsDir = hit ? hit.dir : false;
  renderList();
  setStatus(hit ? "" : t("fb.notInDir", { path: selectPath }));
}

/* 去掉末级路径段（同时兼容 / 与 \ 分隔符） */
function parentOf(path) {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (idx < 0) return "";
  // 末级直接挂在根下：/file → /；\file → \
  if (idx === 0) return trimmed.charAt(0);
  const parent = trimmed.substring(0, idx);
  // Windows 盘符根：C: → C:\
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}

/* ---------- 列表渲染 ---------- */
function visibleEntries() {
  const kw = q(".fb-search").value.trim().toLowerCase();
  return entries.filter(e => {
    if (!showHidden && e.hidden) return false;
    if (kw && !e.name.toLowerCase().includes(kw)) return false;
    if (!e.dir && extFilter && e.ext !== extFilter) return false;
    return true;
  });
}

function renderList() {
  const list = q(".fb-list");
  list.innerHTML = "";
  if (!cwd) {
    list.innerHTML = `<div class="hint fb-empty">${t("fb.empty")}</div>`;
    updateFooter();
    return;
  }
  const rows = visibleEntries();
  if (rows.length === 0) {
    list.innerHTML = `<div class="hint fb-empty">${t("fb.noMatch")}</div>`;
    updateFooter();
    return;
  }
  for (const e of rows) {
    const row = document.createElement("div");
    row.className = "fb-row" + (e.path === selectedPath ? " selected" : "");
    row.setAttribute("role", "option");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-selected", e.path === selectedPath ? "true" : "false");
    const icon = e.dir ? "📁" : "📄";
    const size = e.dir ? "" : formatSize(e.size);
    row.innerHTML = `<span class="fb-icon" aria-hidden="true">${icon}</span>
      <span class="fb-name"></span>
      <span class="fb-size"></span>
      <span class="fb-mtime"></span>`;
    row.querySelector(".fb-name").textContent = e.name;
    row.querySelector(".fb-size").textContent = size;
    row.querySelector(".fb-mtime").textContent = e.mtime || "";
    row.title = e.path;
    row.onclick = () => onRowClick(e);
    row.ondblclick = () => onRowDblClick(e);
    row.onkeydown = (ev) => {
      if (ev.key === "Enter" && e.dir) { ev.preventDefault(); navigate(e.path); }
      else if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onRowClick(e); }
      else if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "End") {
        // roving：方向键在列表内移动选中项并把焦点移过去
        ev.preventDefault();
        const all = visibleEntries();
        const cur = all.findIndex(x => x.path === (selectedPath || e.path));
        let next;
        if (ev.key === "Home") next = 0;
        else if (ev.key === "End") next = all.length - 1;
        else if (ev.key === "ArrowDown") next = Math.min(cur + 1, all.length - 1);
        else next = Math.max(cur - 1, 0);
        const target = all[next];
        if (target) {
          select(target);
          const node = list.querySelectorAll(".fb-row")[next];
          if (node) node.focus();
        }
      }
    };
    list.appendChild(row);
  }
  updateFooter();
}

function onRowClick(e) {
  // 统一交互：单击 = 选中（文件/文件夹两种模式一致），双击 = 进入文件夹
  if (e.dir) {
    select(e);
  } else if (opts.mode !== "dir") {
    select(e);
  }
}

function onRowDblClick(e) {
  if (e.dir) {
    navigate(e.path);
  } else if (opts.mode !== "dir") {
    finish(e.path);
  }
}

function select(e) {
  selectedPath = e.path;
  selectedIsDir = e.dir;
  overlay.querySelectorAll(".fb-row").forEach(r => { r.classList.remove("selected"); r.setAttribute("aria-selected", "false"); });
  const rows = overlay.querySelectorAll(".fb-row");
  visibleEntries().forEach((item, i) => {
    if (item.path === e.path && rows[i]) { rows[i].classList.add("selected"); rows[i].setAttribute("aria-selected", "true"); }
  });
  updateFooter();
}

function updateFooter() {
  const selEl = q(".fb-selection");
  const confirm = q(".fb-confirm");
  if (selectedPath) {
    selEl.textContent = selectedPath;
    selEl.title = selectedPath;
    confirm.disabled = opts.mode === "dir" ? !selectedIsDir : selectedIsDir;
  } else {
    selEl.textContent = opts.mode === "dir" ? t("fb.noSelectionDir") : t("fb.noSelectionFile");
    selEl.title = "";
    confirm.disabled = true;
  }
  q(".fb-pick-current").disabled = !cwd;
}

function confirmSelection() {
  if (!selectedPath) return;
  if (opts.mode === "dir" && !selectedIsDir) return;
  if (opts.mode !== "dir" && selectedIsDir) return;
  finish(selectedPath);
}

/* ---------- 新建文件夹 ---------- */
async function mkdir() {
  if (!cwd) { setStatus(t("fb.needDir")); return; }
  const name = window.prompt(t("fb.mkdirPrompt"));
  if (name == null) return;
  try {
    await Api.post("/api/fs/mkdir", { parent: cwd, name: name.trim() });
    navigate(cwd);
  } catch (e) {
    setStatus(t("fb.mkdirFailed", { msg: e.message || e }));
  }
}

/* ---------- 收尾 ---------- */
function finish(path) {
  close();
  if (resolvePromise) resolvePromise(path);
  resolvePromise = null;
}

export function cancel() {
  finish(null);
}

function close() {
  if (overlay) overlay.classList.add("hidden");
  restoreDialogFocus();
}

function setStatus(text) {
  if (text) {
    let el = q(".fb-status");
    if (!el) {
      el = document.createElement("div");
      el.className = "hint fb-status";
      overlay.querySelector(".fb-modal").insertBefore(el, q(".fb-footer"));
    }
    el.textContent = text;
  } else {
    const el = q(".fb-status");
    if (el) el.remove();
  }
}

/* ---------- 语言切换：重设所有静态文案（由 app.js 统一调用） ----------
   注册在 rerenderAll（web/app.js）里，与 __audioPickers / __voiceSelects 的
   refreshLabels() 并列。FileBrowser 是模块级单例（overlay 只在首次 open 时建），
   因此这里直接按单例调用，不需要 __audioPickers 那样的实例登记表。

   现状：页头语言按钮在 <header> 里，fb-overlay 打开时会被 syncInert 设成 inert，
   设置弹窗又排在 fb-overlay 之下，所以当前 UI 没有「弹窗开着还能切语言」的入口——
   它是防御性路径，不是活 bug。保留的成本是几十行，收益是任何新增的语言切换入口
   （快捷键、命令面板项、嵌套开设置）都不会让已打开的弹窗退回旧语言文案。
   test/unit/file-browser.test.mjs 会锁住这条注册关系。 */
export function relocalize() {
  if (!overlay) return;
  opts = opts || {};
  q(".fb-title").textContent = opts.title || (opts.mode === "dir" ? t("fb.titleDir") : t("fb.titleFile"));
  const up = q(".fb-up");
  up.textContent = t("fb.up");
  up.title = t("fb.upTitle");
  up.setAttribute("aria-label", t("fb.upTitle"));
  q(".fb-close").setAttribute("aria-label", t("history.closeTitle"));
  const pathInput = q(".fb-path");
  pathInput.placeholder = t("fb.pathPlaceholder");
  pathInput.setAttribute("aria-label", t("fb.pathPlaceholder"));
  q(".fb-go").textContent = t("fb.go");
  const refresh = q(".fb-refresh");
  refresh.title = t("fb.refreshTitle");
  refresh.setAttribute("aria-label", t("fb.refreshTitle"));
  const search = q(".fb-search");
  search.placeholder = t("fb.searchPlaceholder");
  search.setAttribute("aria-label", t("fb.searchPlaceholder"));
  q(".fb-ext").setAttribute("aria-label", t("fb.extLabel"));
  q(".fb-list").setAttribute("aria-label", t("fb.listLabel"));
  const hiddenLabel = q(".fb-hidden-toggle");
  hiddenLabel.childNodes.forEach(n => {
    if (n.nodeType === Node.TEXT_NODE) n.textContent = " " + t("fb.showHidden");
  });
  q(".fb-mkdir").textContent = t("fb.mkdir");
  q(".fb-pick-current").textContent = t("fb.pickCurrent");
  q(".fb-cancel").textContent = t("fb.cancel");
  q(".fb-confirm").textContent = t("fb.confirm");
  // 重建扩展名下拉（buildExtFilter 会重置选中值，先记录再恢复）
  const prevExt = extFilter;
  buildExtFilter();
  const extSel = q(".fb-ext");
  if (!extSel.classList.contains("hidden")) {
    extSel.value = prevExt;
    extFilter = extSel.value;
  }
  // footer 的 selection 提示：无选中时按 mode 重填
  if (!selectedPath) {
    q(".fb-selection").textContent = opts.mode === "dir" ? t("fb.noSelectionDir") : t("fb.noSelectionFile");
  }
  // status 提示是旧语言文本，直接移除
  const status = q(".fb-status");
  if (status) status.remove();
}

function formatSize(bytes) {
  if (bytes == null) return "";
  return I18N.bytes(bytes);
}
