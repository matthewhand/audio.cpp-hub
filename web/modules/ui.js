/* web/modules/ui.js — 外壳 UI 原语
 *
 * 弹窗可见性栈与焦点管理（focusDialog / restoreDialogFocus）、背景 inert、
 * 弹出菜单键盘导航（bindMenuKeys）、toast 滑出动画（dismissToast）、全局 busy 遮罩。
 * 这些是跨功能复用的纯 UI 机制，不认识任何具体业务面板；
 * 「Esc 只关最上层弹窗」等全局键盘绑定在 web/app.js 里。
 *
 * focusDialog / restoreDialogFocus 另有同名 window 转发器（见 web/legacy-globals.js），
 * 供 audio-picker.js / voices-panel.js 这两个仍在模块之前执行的经典脚本调用。
 * toast 的创建（notify / showToast）在 async-ui.js，它单向依赖本模块的 dismissToast。 */

import { $ } from "./dom.js";

/* ---------- 弹窗可访问性：焦点管理 / Esc 只关最上层 ---------- */
/* 可见弹窗按 DOM 顺序（≈ 堆叠顺序），最后一个即最上层。
   command-palette（#88）与 fb-overlay / busy-overlay（#89）共用同一套焦点陷阱与 inert 机制。 */
export const OVERLAY_IDS = ["instance-detail-modal", "launch-modal", "downloads-modal",
  "model-dl-modal", "settings-modal", "command-palette", "history-panel", "voices-panel",
  "fb-overlay", "busy-overlay"];
export const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/* 弹窗返回焦点的栈：支持嵌套弹窗（如启动弹窗里打开文件浏览器）逐层还原 */
const dialogFocusStack = [];

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
function syncInert() {
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
  const card = overlay.querySelector(".modal, .history-panel-card, .command-palette-card, .fb-modal, .busy-box") || overlay;
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

/* 先播放滑出动画再移除节点；reduced-motion 下动画被压缩，由 timeout 兜底 */
export function dismissToast(node) {
  if (!node.isConnected || node.classList.contains("leaving")) return;
  node.classList.add("leaving");
  node.addEventListener("animationend", () => node.remove(), { once: true });
  setTimeout(() => node.remove(), 400);
}

/* 弹出菜单键盘导航（#89）：上下方向键 / Home / End 在 role=menu 的菜单项间移动焦点。
   HF 仓库菜单（models.js）与历史分组菜单（sidebar.js）共用。 */
export function bindMenuKeys(menuEl, sel) {
  menuEl.addEventListener("keydown", (e) => {
    const items = [...menuEl.querySelectorAll(sel)];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1].focus(); }
  });
}

/* ---------- 任务等待遮罩（spinner + 实时计时） ---------- */
/* #busy-overlay（全局等待遮罩 + 实时耗时）的接线已停用：唯一使用方（HTTPS 证书生成）
   按 #88 的统一异步状态改用 setButtonBusy() 按钮内联 loading。遮罩的 DOM / 样式 / ARIA
   属性仍保留在 index.html，并已登记进 OVERLAY_IDS（Esc 关闭时被显式忽略），
   需要全局阻塞反馈时取消下面注释即可（焦点锁 + inert + 焦点还原均已就绪）。
   export let busyTimer = null;
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
   let busyReturnFocus = null;
   */
