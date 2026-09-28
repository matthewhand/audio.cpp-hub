/* web/modules/async-ui.js — 跨功能复用的 UI 原语（#88）
 *
 * 原先这些散落在单体 app.js 的各处调用点上（骨架屏只有历史面板有、错误提示各自拼文案、
 * 弹窗焦点栈只有 voices-panel 用），这里收成两组可复用原语：
 *
 *   A. 通知与异步状态
 *      - notify / showToast：toast 堆叠，堆在 #toast-root（ARIA live region），hover 暂停自动关闭
 *      - showSkeleton / renderEmptyState / renderStateError / renderListError：列表三态占位
 *      - setButtonBusy：按钮内联 loading，替代不必要的全局遮罩
 *      - parseApiError / stateErrorMessage：后端 {"code","params"} 错误体 → 本地化文案
 *      - applyEvents / startEventsPolling：/api/events 轮询 → toast（见 B 的说明）
 *      - isOpen：弹窗可见性判定
 *
 *   B. 弹窗机制
 *      - OVERLAY_IDS / visibleOverlays / topmostOverlay：可见弹窗栈（按 DOM 顺序 ≈ 堆叠顺序）
 *      - focusDialog / restoreDialogFocus：焦点栈 + 背景 inert，嵌套弹窗逐层还原
 *        （focusDialog 会等焦点目标真的可聚焦，见下方 focusWhenRendered）
 *      - bindMenuKeys：弹出菜单键盘导航（HF 仓库菜单 / 历史分组菜单共用）
 *      - dismissToast：先播滑出动画再移除节点
 *      - showBusy / hideBusy：全局等待遮罩 + 实时耗时，只给「不知道要等多久、
 *        期间不允许再操作」的批量操作用（当前是清空操作历史）
 *
 * 依赖刻意单向：本模块 → dom.js（$ / el / esc / t / Api）。dom.js 是零 import 的叶子，
 * ui.js 的焦点栈与这里的 toast/三态之间不再需要来回引用，因此也不会形成环。
 * 「Esc 只关最上层弹窗」等全局键盘绑定在 web/app.js 里。 */

import { $, Api, el, esc, t } from "./dom.js";

const TOAST_LEVELS = ["success", "error", "info", "warn"];
const TOAST_DEFAULT_TIMEOUT = 8000;

/* ---------- A. 通知与异步状态 ---------- */

/* toast 组件：notify({level,message,timeout}) → {node, dismiss()}
   level: success | error | info | warn；timeout 毫秒，0 表示不自动关闭 */
function notify(opts) {
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

/* 解析后端错误响应，保留 code/params 供 i18n 映射 */
export function parseApiError(text) {
  /** @type {HubHttpError} */
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

/* 骨架屏：列表拉取期间占位（container 置 aria-busy，真实内容由各 render* 清除） */
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

/* 错误态：message + 重试按钮；raw=true 时 message 视为已组装 */
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

/* 列表加载失败的可见提示 + 重试按钮（替代空白列表）的旧签名入口：
   message 已组装好，因此走 renderStateError 的 raw 分支。 */
export function renderListError(container, message, retry) {
  if (!container) return;
  renderStateError(container, new Error(message), retry, true);
}

/* 按钮内联 loading 态：局部操作（提交表单、生成证书）用它就够了，不需要全局遮罩 */
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

/* ---------- A'. hub 事件流 → toast ----------
   /api/events 的唯一产物就是 toast，因此与 toast 同居本模块。
   事件去重用的 seenEvents 只在下面的 applyEvents 里使用。 */
export const seenEvents = new Set();
let eventsInitialized = false;

/* 轮询数据回调：把新事件转成 toast（首次拉取只建立基线，不弹历史事件） */
export function applyEvents(data) {
  // 事件窗口由服务端限制为最近 20 条：seenEvents 同步收缩，避免长期运行无界增长
  const valid = new Set(data.map(ev => ev.time + "|" + ev.message));
  for (const k of seenEvents) if (!valid.has(k)) seenEvents.delete(k);
  const fresh = [];
  for (const ev of data) {
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

/* 失败静默：事件流是通知性数据，瞬时失败丢一轮即可（服务端窗口只保留最近 20 条） */
export function onEventsError() { /* 静默 */ }

/* 建立 2s 轮询（由 web/app.js 在启动时调用一次）。事件流不需要句柄，无残留收尾需求。 */
export function startEventsPolling() {
  return Api.poll("/api/events", applyEvents, { list: true, onError: onEventsError });
}

/* ---------- B. 弹窗机制 ---------- */

/* 可见弹窗按 DOM 顺序（≈ 堆叠顺序），最后一个即最上层。
   命令面板（#88）、文件浏览器与全局等待遮罩（#89）共用同一套焦点陷阱与 inert 机制。 */
export const OVERLAY_IDS = ["instance-detail-modal", "launch-modal", "downloads-modal",
  "model-dl-modal", "settings-modal", "command-palette", "history-panel", "voices-panel",
  "fb-overlay", "busy-overlay"];
export const FOCUSABLE_SEL = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/* 弹窗返回焦点的栈：支持嵌套弹窗（如启动弹窗里打开文件浏览器）逐层还原 */
const dialogFocusStack = [];
/* 焦点重试的帧预算（见 focusWhenRendered）：只在焦点真的没落上时才会用到，
   30 帧 ≈ 0.5s @60fps，足够盖过遮罩的淡入过渡（--dur-2 = 200ms，约 12 帧）*/
const FOCUS_RETRY_FRAMES = 30;
/* 焦点重试的代次号：每次 focusDialog / restoreDialogFocus 都作废上一次的重试，
   免得「已经关掉的弹窗」或「被新弹窗顶掉的弹窗」在下一帧把焦点又抢回去 */
let focusTicket = 0;

/* 把焦点移入 node，但只在它真的能接住焦点时才算成功。
   为什么必须重试：.modal-overlay.hidden 用 visibility:hidden（而不是 display:none）
   保留布局盒，好让遮罩淡出/缩放退场（见 web/style.css 的 .modal-overlay.hidden 规则）。
   CSS 过渡是在下一次样式更新里才启动的——刚去掉 .hidden 那一帧，
   getComputedStyle 仍返回 visibility:hidden，而对 visibility:hidden 的元素调用
   focus() 是空操作。于是「打开弹窗就把焦点移进去」会静默失败：弹窗看得见，
   document.activeElement 却留在 body，键盘用户拿到一个没有焦点的对话框
   （命令面板最明显：↑↓ / Enter 全都不响应，非得点一下搜索框）。
   这里不按固定时长盲等，而是盯着真实结果（document.activeElement === node）逐帧重试：
   落上就立刻停、一个 rAF 都不多等；节点被移出文档或超出帧预算也立刻停。 */
function focusWhenRendered(node) {
  if (!node || typeof node.focus !== "function") return;
  const ticket = ++focusTicket;
  let frames = 0;
  const attempt = () => {
    if (ticket !== focusTicket) return; // 已被后续的开关弹窗取代：不再抢焦点
    node.focus();
    if (document.activeElement === node) return; // 落上了，收工
    if (++frames > FOCUS_RETRY_FRAMES || !node.isConnected) return;
    requestAnimationFrame(attempt);
  };
  attempt();
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
function syncInert() {
  const open = visibleOverlays();
  const top = open.length ? open[open.length - 1] : null;
  /* toast-root 不设 inert：inert 会把 aria-live 区域移出无障碍树，弹窗内的错误提示就读不到了 */
  const regions = [document.querySelector("header"), $("main-content"), document.querySelector("footer"),
    $("drawer-overlay")];
  for (const r of regions) if (r) setInert(r, !!top);
  for (const o of open) setInert(o, o !== top);
}
/* 打开弹窗：记录触发元素、把背景设为 inert，并把焦点移入弹窗。
   preferred 可显式指定焦点目标（必须在弹窗内，否则忽略）：命令面板用它锁定搜索框，
   不靠「第一个可聚焦元素碰巧是它」这种依赖 DOM 顺序的巧合。 */
export function focusDialog(overlay, preferred) {
  if (!overlay) return;
  dialogFocusStack.push(document.activeElement);
  const card = overlay.querySelector(".modal, .history-panel-card, .command-palette-card, .fb-modal, .busy-box") || overlay;
  if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "-1");
  syncInert();
  const target = preferred && overlay.contains(preferred) ? preferred : overlay.querySelector(FOCUSABLE_SEL) || card;
  focusWhenRendered(target);
}
/* 关闭弹窗：先解除/重算 inert，再把焦点还原到打开它的元素。
   顺带作废可能还在排队的焦点重试，否则关掉弹窗后它会在下一帧把焦点抢回来。 */
export function restoreDialogFocus() {
  const prev = dialogFocusStack.pop();
  focusTicket++;
  syncInert();
  if (prev && typeof prev.focus === "function") prev.focus();
  /* 还原没落上时的兜底：prev 是 document.body（Ctrl/Cmd-K 从没聚焦过的页面直接唤起
     命令面板就是这种情况）或已被重画掉时，focus() 是空操作，焦点会滞留在刚关掉的弹窗
     里——命令面板的输入框此刻 visibility:hidden，既看不见也 Tab 不到，键盘用户等于
     被丢在够不着的位置。确认还原失败就 blur 掉，交回文档开头。 */
  const ae = /** @type {HTMLElement | null} */ (document.activeElement);
  if (ae && ae !== document.body && ae !== prev && typeof ae.blur === "function") ae.blur();
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

/* 全局等待遮罩（#89）：给「不知道要等多久、期间必须挡住其它操作」的批量操作。
   与 setButtonBusy 的分工：按钮内联 loading 适合单个局部操作（提交表单、生成证书），
   这里的遮罩适合跨多个请求、进度不可知的批量操作——当前唯一使用方是「清空操作历史」，
   它要对每条已结束任务发一次 DELETE，条数事先不可知。
   Esc 被 web/app.js 显式忽略：等的是一个不可中断的批量过程。 */
let busyTimer = null;
let busyReturnFocus = null;

export function showBusy(label) {
  if (busyTimer) return; // 已在等待中：忽略重入，避免叠加计时器与两次焦点还原
  $("busy-label").textContent = label || t("busy.label");
  $("busy-elapsed").textContent = "0.0s";
  busyReturnFocus = document.activeElement;
  $("busy-overlay").classList.remove("hidden");
  syncInert();
  $("busy-overlay").focus();
  const start = performance.now();
  busyTimer = setInterval(() => {
    $("busy-elapsed").textContent = ((performance.now() - start) / 1000).toFixed(1) + "s";
  }, 100);
}
export function hideBusy() {
  clearInterval(busyTimer);
  busyTimer = null;
  $("busy-overlay").classList.add("hidden");
  syncInert();
  if (busyReturnFocus && typeof busyReturnFocus.focus === "function") busyReturnFocus.focus();
  busyReturnFocus = null;
}
