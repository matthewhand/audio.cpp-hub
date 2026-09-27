/* 通用 UI 基础设施：toast 通知、任务等待遮罩、弹窗可访问性（焦点管理 / Esc 只关最上层）、
   事件流轮询（把后端事件转成 toast）。 */
import { $, el } from "./dom.js";
import { t } from "./i18n.js";
import { apiGet } from "./api.js";

/* ---------- 事件通知（toast） ---------- */
export function showToast(level, message) {
  const root = $("toast-root");
  const node = el(`<div class="toast ${level === "error" ? "error" : "info"}">
    <span class="toast-text"></span><button class="toast-close">×</button></div>`);
  node.querySelector(".toast-text").textContent = message;
  node.querySelector(".toast-close").onclick = () => dismissToast(node);
  root.appendChild(node);
  setTimeout(() => dismissToast(node), 8000);
}

/* 先播放滑出动画再移除节点；reduced-motion 下动画被压缩，由 timeout 兜底 */
export function dismissToast(node) {
  if (!node.isConnected || node.classList.contains("leaving")) return;
  node.classList.add("leaving");
  node.addEventListener("animationend", () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400);
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

/* ---------- 任务等待遮罩（spinner + 实时计时） ---------- */
let busyTimer = null;
export function showBusy(label) {
  $("busy-label").textContent = label;
  const start = performance.now();
  $("busy-elapsed").textContent = "0.0s";
  $("busy-overlay").classList.remove("hidden");
  busyTimer = setInterval(() => {
    $("busy-elapsed").textContent = ((performance.now() - start) / 1000).toFixed(1) + "s";
  }, 100);
  return start;
}
export function hideBusy() {
  clearInterval(busyTimer);
  busyTimer = null;
  $("busy-overlay").classList.add("hidden");
}

/* ---------- 移动端抽屉菜单（模型/实例列表） ---------- */
export function openDrawer() {
  $("left").classList.add("open");
  $("drawer-overlay").classList.remove("hidden");
}
export function closeDrawer() {
  $("left").classList.remove("open");
  $("drawer-overlay").classList.add("hidden");
}
$("menu-toggle").onclick = openDrawer;
$("drawer-overlay").onclick = closeDrawer;

/* ---------- 弹窗可访问性：焦点管理 / Esc 只关最上层 ---------- */
/* 可见弹窗按 DOM 顺序（≈ 堆叠顺序），最后一个即最上层 */
const OVERLAY_IDS = ["instance-detail-modal", "launch-modal", "downloads-modal",
  "model-dl-modal", "settings-modal", "history-panel", "voices-panel"];
const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
let dialogReturnFocus = null;

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
/* 打开弹窗：记录触发元素并把焦点移入弹窗 */
export function focusDialog(overlay) {
  if (!overlay) return;
  dialogReturnFocus = document.activeElement;
  const card = overlay.querySelector(".modal, .history-panel-card") || overlay;
  if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
  const first = overlay.querySelector(FOCUSABLE_SEL);
  (first || card).focus();
}
/* 关闭弹窗：焦点还原到打开它的元素 */
export function restoreDialogFocus() {
  if (dialogReturnFocus && typeof dialogReturnFocus.focus === "function") dialogReturnFocus.focus();
  dialogReturnFocus = null;
}
export function closeTopmostOverlay() {
  const overlay = topmostOverlay();
  if (!overlay) return;
  const closer = overlayClosers.get(overlay.id);
  if (closer) { closer(); return; }
  overlay.classList.add("hidden");
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

/* 供经典脚本（voices-panel.js / audio-picker.js）通过 window 调用 */
window.showToast = showToast;
window.focusDialog = focusDialog;
window.restoreDialogFocus = restoreDialogFocus;
