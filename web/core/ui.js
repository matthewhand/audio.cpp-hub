/* 通用 UI 基础设施：统一异步状态（toast / 骨架 / 空态 / 错误态 / 按钮 busy）、
   任务等待遮罩、弹窗可访问性（焦点栈 / inert / Esc 只关最上层）、事件流轮询。 */
import { $, el, esc } from "./dom.js";
import { I18N, t } from "./i18n.js";
import { apiGet } from "./api.js";

/* ---------- 统一异步状态：toast ---------- */
const TOAST_LEVELS = ["success", "error", "info", "warn"];
const TOAST_DEFAULT_TIMEOUT = 8000;

/* toast 组件：notify({level,message,timeout}) → {node, dismiss()}
   level: success | error | info | warn；timeout 毫秒，0 表示不自动关闭；
   堆叠渲染在 #toast-root（ARIA live region），hover 暂停自动关闭 */
export function notify(opts) {
  const o = opts || {};
  const level = TOAST_LEVELS.includes(o.level) ? o.level : "info";
  const root = $("toast-root");
  if (!root) return { node: null, dismiss() {} };
  const node = el(`<div class="toast ${level}" role="${level === "error" ? "alert" : "status"}">
    <span class="toast-text"></span><button type="button" class="toast-close">×</button></div>`);
  node.querySelector(".toast-text").textContent = o.message == null ? "" : String(o.message);
  const closeBtn = node.querySelector(".toast-close");
  closeBtn.setAttribute("aria-label", t("common.dismiss"));
  closeBtn.onclick = () => dismissToast(node);
  root.appendChild(node);
  const timeout = o.timeout === undefined ? TOAST_DEFAULT_TIMEOUT : Number(o.timeout);
  if (timeout > 0) {
    let timer = setTimeout(() => dismissToast(node), timeout);
    node.addEventListener("mouseenter", () => clearTimeout(timer));
    node.addEventListener("mouseleave", () => { timer = setTimeout(() => dismissToast(node), timeout); });
  }
  return { node, dismiss: () => dismissToast(node) };
}
/* 兼容旧调用：showToast(level, message) */
export function showToast(level, message) {
  return notify({ level: level === "warning" ? "warn" : level, message });
}

/* 先播放滑出动画再移除节点；reduced-motion 下动画被压缩，由 timeout 兜底 */
export function dismissToast(node) {
  if (!node.isConnected || node.classList.contains("leaving")) return;
  node.classList.add("leaving");
  node.addEventListener("animationend", () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400);
}

/* ---------- 统一异步状态：错误解析 / 骨架 / 空态 / 错误态 / 按钮 busy ---------- */
/* 解析后端错误响应，保留 code/params 供 i18n 映射 */
export function parseApiError(text) {
  const e = new Error(text ? I18N.errText(text) : t("common.loadFailed"));
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      if (j.code) { e.code = j.code; e.params = j.params || {}; }
      else if (j.error) e.message = String(j.error);
    }
  } catch (err) { /* 非 JSON：保留原文 */ }
  return e;
}
/* 错误信息 i18n：优先 err.<code> 映射，回退 e.message */
export function stateErrorMessage(e) {
  if (e && e.code) {
    const key = "err." + e.code;
    if (I18N.t(key) !== key) return I18N.t(key, e.params || {});
  }
  return e && e.message ? e.message : String(e || "");
}
export function isOpen(id) {
  const n = $(id);
  return !!n && !n.classList.contains("hidden");
}
/* 骨架屏：列表拉取期间占位 */
export function showSkeleton(container, rows) {
  if (!container) return;
  container.setAttribute("aria-busy", "true");
  container.innerHTML = "";
  const wrap = el(`<div class="skeleton" role="status" aria-label="${esc(t("state.loading"))}"></div>`);
  const n = Math.max(1, rows || 4);
  for (let i = 0; i < n; i++) wrap.appendChild(el(`<div class="skeleton-card"></div>`));
  container.appendChild(wrap);
}
/* 空态：message + 可选 CTA 按钮 */
export function renderEmptyState(container, message, cta) {
  if (!container) return;
  container.removeAttribute("aria-busy");
  container.innerHTML = "";
  const box = el(`<div class="state-box empty-state"><p class="state-msg hint"></p><div class="state-actions"></div></div>`);
  box.querySelector(".state-msg").textContent = message;
  if (cta && cta.label) {
    const b = el(`<button type="button" class="btn-ghost"></button>`);
    b.textContent = cta.label;
    b.onclick = cta.onClick;
    box.querySelector(".state-actions").appendChild(b);
  }
  container.appendChild(box);
}
/* 错误态：message + 重试按钮；raw=true 时 message 视为已组装（旧 renderListError 语义） */
export function renderStateError(container, error, retry, raw) {
  if (!container) return;
  container.removeAttribute("aria-busy");
  container.innerHTML = "";
  const box = el(`<div class="state-box load-error"><p class="state-msg hint"></p><div class="state-actions"></div></div>`);
  box.querySelector(".state-msg").textContent = raw
    ? (error && error.message ? error.message : String(error || ""))
    : t("common.loadFailed") + t("common.colon") + stateErrorMessage(error);
  if (retry) {
    const b = el(`<button type="button" class="btn-ghost"></button>`);
    b.textContent = t("common.retry");
    b.onclick = retry;
    box.querySelector(".state-actions").appendChild(b);
  }
  container.appendChild(box);
}
/* 按钮内联 loading 态：替代不必要的全局遮罩 */
export function setButtonBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset.idleText === undefined) btn.dataset.idleText = btn.textContent;
    btn.classList.add("btn-busy");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (busyLabel) btn.textContent = busyLabel;
  } else {
    btn.classList.remove("btn-busy");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (btn.dataset.idleText !== undefined) { btn.textContent = btn.dataset.idleText; delete btn.dataset.idleText; }
  }
}

/* ---------- 事件流轮询 ---------- */
let eventsInitialized = false;
const seenEvents = new Set();

export async function refreshEvents() {
  let events;
  try {
    const data = await apiGet("/api/events");
    events = Array.isArray(data) ? data : [];
  } catch (e) {
    return;
  }
  // 事件窗口由服务端限制为最近 20 条：seenEvents 同步收缩，避免长期运行无界增长
  const valid = new Set(events.map(ev => ev.time + "|" + ev.message));
  for (const k of seenEvents) if (!valid.has(k)) seenEvents.delete(k);
  const fresh = [];
  for (const ev of events) {
    const key = ev.time + "|" + ev.message;
    if (!seenEvents.has(key)) {
      seenEvents.add(key);
      fresh.push(ev);
    }
  }
  if (!eventsInitialized) {
    eventsInitialized = true;
    return;
  }
  fresh.reverse().forEach(ev => showToast(ev.level, ev.message));
}

/* ---------- 任务等待遮罩（spinner + 实时计时）：仅保留给真正全局的阻塞操作 ---------- */
let busyTimer = null;
let busyReturnFocus = null;
export function showBusy(label) {
  $("busy-label").textContent = label;
  const start = performance.now();
  $("busy-elapsed").textContent = "0.0s";
  busyReturnFocus = document.activeElement;
  $("busy-overlay").classList.remove("hidden");
  syncInert();
  $("busy-overlay").focus();
  busyTimer = setInterval(() => {
    $("busy-elapsed").textContent = ((performance.now() - start) / 1000).toFixed(1) + "s";
  }, 100);
  return start;
}
export function hideBusy() {
  clearInterval(busyTimer);
  busyTimer = null;
  $("busy-overlay").classList.add("hidden");
  syncInert();
  if (busyReturnFocus && typeof busyReturnFocus.focus === "function") busyReturnFocus.focus();
  busyReturnFocus = null;
}

/* ---------- 移动端抽屉菜单（模型/实例列表） ---------- */
export function openDrawer() {
  $("left").classList.add("open");
  $("drawer-overlay").classList.remove("hidden");
  $("menu-toggle").setAttribute("aria-expanded", "true");
}
export function closeDrawer() {
  $("left").classList.remove("open");
  $("drawer-overlay").classList.add("hidden");
  $("menu-toggle").setAttribute("aria-expanded", "false");
}
$("menu-toggle").onclick = openDrawer;
$("drawer-overlay").onclick = closeDrawer;

/* ---------- 弹窗可访问性：焦点栈 / inert / Esc 只关最上层 ---------- */
/* 可见弹窗按 DOM 顺序（≈ 堆叠顺序），最后一个即最上层 */
const OVERLAY_IDS = ["instance-detail-modal", "launch-modal", "downloads-modal",
  "model-dl-modal", "settings-modal", "command-palette", "history-panel", "voices-panel",
  "fb-overlay", "busy-overlay"];
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/* 弹窗返回焦点的栈：支持嵌套弹窗（如启动弹窗里打开文件浏览器）逐层还原 */
const dialogFocusStack = [];

/* 各特性模块注册自己的弹窗关闭函数（避免核心层反向依赖特性层） */
const overlayClosers = new Map();
export function registerOverlay(id, closeFn) {
  overlayClosers.set(id, closeFn);
}

export function visibleOverlays() {
  return OVERLAY_IDS.map(id => $(id)).filter(el => el && !el.classList.contains("hidden"));
}
export function topmostOverlay() {
  const open = visibleOverlays();
  return open.length ? open[open.length - 1] : null;
}
function setInert(node, on) {
  if (on) node.setAttribute("inert", "");
  else node.removeAttribute("inert");
}
/* 有弹窗时把主页面区域与非最上层弹窗设为 inert：键盘/读屏无法到达遮罩后的内容 */
export function syncInert() {
  const open = visibleOverlays();
  const top = open.length ? open[open.length - 1] : null;
  /* toast-root 不设 inert：inert 会把 aria-live 区域移出无障碍树，弹窗内的错误提示就读不到了 */
  const regions = [document.querySelector("header"), $("main-content"), document.querySelector("footer"),
    $("drawer-overlay")];
  for (const r of regions) if (r) setInert(r, !!top);
  for (const o of open) setInert(o, o !== top);
}
/* 打开弹窗：记录触发元素、把背景设为 inert，并把焦点移入弹窗 */
export function focusDialog(overlay) {
  if (!overlay) return;
  dialogFocusStack.push(document.activeElement);
  const card = overlay.querySelector(".modal, .history-panel-card, .fb-modal, .busy-box") || overlay;
  if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
  syncInert();
  const first = overlay.querySelector(FOCUSABLE_SEL);
  (first || card).focus();
}
/* 关闭弹窗：先解除/重算 inert，再把焦点还原到打开它的元素 */
export function restoreDialogFocus() {
  const prev = dialogFocusStack.pop();
  syncInert();
  if (prev && typeof prev.focus === "function") prev.focus();
}
export function closeTopmostOverlay() {
  const overlay = topmostOverlay();
  if (!overlay) return;
  if (overlay.id === "busy-overlay") return; // 忙碌遮罩不允许 Esc 关闭
  if (overlay.id === "fb-overlay") { if (window.FileBrowser) FileBrowser.cancel(); return; }
  const closer = overlayClosers.get(overlay.id);
  if (closer) { closer(); return; }
  overlay.classList.add("hidden");
  restoreDialogFocus();
}

/* Tab 焦点锁定在当前最上层弹窗内，防止键盘用户 Tab 到遮罩后的页面 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const overlay = topmostOverlay();
  if (!overlay) return;
  const items = [...overlay.querySelectorAll(FOCUSABLE_SEL)].filter(el => el.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/* Esc：只关最上层弹窗；焦点在可编辑字段时不关闭，避免误丢表单输入 */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const overlay = topmostOverlay();
  if (!overlay) { closeDrawer(); return; }
  const ae = document.activeElement;
  if (ae && overlay.contains(ae) && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  closeTopmostOverlay();
});

/* 供经典脚本（voices-panel.js / audio-picker.js / file-browser.js）通过 window 调用 */
window.showToast = showToast;
window.notify = notify;
window.focusDialog = focusDialog;
window.restoreDialogFocus = restoreDialogFocus;
