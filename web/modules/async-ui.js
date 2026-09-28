/* web/modules/async-ui.js — 统一异步状态（#88）
 *
 * 列表与按钮的「加载中 / 空 / 失败」三态，以及 toast 通知。原先这些散落在单体
 * app.js 的各处调用点上（骨架屏只有历史面板有、错误提示各自拼文案），这里收成
 * 一组可复用原语：
 *   - notify / showToast：toast 堆叠，堆在 #toast-root（ARIA live region），hover 暂停自动关闭
 *   - showSkeleton / renderEmptyState / renderStateError：列表三态占位
 *   - setButtonBusy：按钮内联 loading，替代不必要的全局遮罩
 *   - parseApiError / stateErrorMessage：后端 {"code","params"} 错误体 → 本地化文案
 *   - isOpen：弹窗可见性判定
 *
 * 依赖关系刻意单向：本模块 → ui.js（dismissToast）。ui.js 不回引本模块，
 * 因此「弹窗焦点栈」与「异步状态」两块不会形成环。 */

import { $, el, esc } from "./dom.js";
import { t } from "./i18n-bridge.js";
import { dismissToast } from "./ui.js";

const TOAST_LEVELS = ["success", "error", "info", "warn"];
const TOAST_DEFAULT_TIMEOUT = 8000;

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
