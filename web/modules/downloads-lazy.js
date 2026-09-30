/* web/modules/downloads-lazy.js — 下载面板的懒加载外观 + 首屏常驻部分
 *
 * 与 modules/stats-lazy.js / modules/file-browser-lazy.js 同一形状，但这里的
 * 切分线不是「整个模块」而是「点击才用得上的部分」：
 *
 *   首屏（留在本外观层）  - 页头 ⬇️ 角标（进行中任务数）与它的 2s 轮询
 *                         （角标在首屏就看得见，app.js 启动时必须建立轮询）
 *   懒加载 chunk         - 下载管理弹窗（#downloads-modal：列表 / 暂停 / 续传 /
 *                         删除 / 填入权重）与按模型下载弹窗（#model-dl-modal：
 *                         包选择 / token / 下载源），即 modules/downloads.js
 *
 * 两个弹窗都只在用户点开后才用得上，而它们的渲染代码（进度条、包单选、token
 * 输入）是全站最长的两段内联 HTML 拼接——放进 chunk 才能真正省下首屏字节。
 * 切分后 downloads 数据仍只有一份：它归本模块（角标与列表共用），chunk 经
 * getDownloads() / hasDownloadsLoaded() / refreshDownloads() 读，不各自轮询。
 *
 * 同步路径（app.js 的 Esc 分派、routing.js 的 applyRoute 关闭分支、语言切换
 * 重画）都经本外观层，chunk 未加载时保持 no-op / 只收起外壳。实测表见
 * scripts/perf-budget.mjs 顶注。 */

import { focusDialog, isOpen, renderStateError, restoreDialogFocus } from "./async-ui.js";
import { $, Api } from "./dom.js";

let mod = null;      // 已解析的 downloads.js 模块命名空间，null 直到首次打开
let inflight = null; // 进行中的动态 import，让并发打开共享同一次网络往返

/* ---------- 首屏常驻：数据 + 角标 + 2s 轮询 ---------- */
let downloads = [];
let downloadsLoaded = false; // 首次成功拉取前才显示骨架屏 / 失败时才给可见错误
let downloadsPoller = null;  // 轮询句柄，本模块持有（refresh 复用它）

/* chunk 读列表的唯一入口（活绑定：拿到的是最新一次轮询结果）。 */
export function getDownloads() {
  return downloads;
}
export function hasDownloadsLoaded() {
  return downloadsLoaded;
}

/* 轮询回调：角标永远重画；列表只在弹窗已开且 chunk 已加载时才重画。 */
function applyDownloads(data) {
  downloadsLoaded = true;
  downloads = data;
  updateDlBadge();
  if (mod && isOpen("downloads-modal")) mod.renderDownloadList();
}

/* 失败处理：已加载过一次就静默（下载列表是 2s 轮询的附属信息，瞬时失败下轮自愈）；
   从未加载成功且面板正开着时，给可见错误 + 重试，避免只剩骨架屏。 */
function onDownloadsError(e) {
  if (downloadsLoaded) return;
  if (mod && isOpen("downloads-modal")) {
    renderStateError($("dl-list"), e, refreshDownloads);
  }
}

/* 立即拉一次：复用轮询句柄（可 await），轮询未建立时直接请求一次 */
export function refreshDownloads() {
  if (downloadsPoller) return downloadsPoller.refresh();
  return Api.list("/api/downloads").then(applyDownloads).catch(onDownloadsError);
}

/* 建立 2s 轮询（由 web/app.js 在启动时调用一次）。句柄只在本模块持有。 */
export function startDownloadsPolling() {
  downloadsPoller = Api.poll("/api/downloads", applyDownloads, { list: true, onError: onDownloadsError });
  return downloadsPoller;
}

/* 页头角标：进行中的任务数（首屏可见，因此不懒加载） */
export function updateDlBadge() {
  const running = downloads.filter(d => d.status === "RUNNING" || d.status === "PENDING").length;
  const badge = $("dl-badge");
  badge.textContent = running;
  badge.classList.toggle("hidden", running === 0);
}

/* ---------- 懒加载 chunk 的接线 ---------- */
/* 加载真模块（幂等、并发去重；失败不缓存，允许下次重试）。 */
function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./downloads.js").then(
      m => (mod = m),
      e => {
        inflight = null;
        throw e;
      }
    );
  }
  return inflight;
}

/* chunk 加载失败时的统一收尾：记录错误，避免点击看起来毫无反应。 */
function failOpen(what, e) {
  console.error("downloads: failed to load panel module (" + what + ")", e);
}

/* 打开 / 关闭之间的竞态：chunk 还在路上时用户按了 Esc（外壳已显示但内容未到）。
   记下来让打开路径在 chunk 落地后不再打开面板，否则「按了 Esc 面板又弹出来」。
   只对「外壳同步显示」的两个弹窗需要：#model-dl-modal 的外壳要等包清单才显示，
   Esc 与 applyRoute 的关闭分支都够不到它，不存在这个窗口。 */
let pendingClose = false;

/* 打开下载管理弹窗：外壳（静态 DOM）同步显示，chunk 到位后再填内容，
   这样点击反馈仍然是即时的（与 stats-lazy 的看板外壳同一手法）。 */
export async function openDownloadsModal() {
  pendingClose = false;
  const modal = $("downloads-modal");
  modal.classList.remove("hidden");
  focusDialog(modal);
  try {
    const m = await ensure();
    if (pendingClose) return; // Esc 先到了：外壳已收回去，别再填内容
    m.openDownloadsModal();
  } catch (e) {
    failOpen("downloads-modal", e);
    modal.classList.add("hidden");
  }
}

/* 同步关闭：chunk 还在路上时（外壳已显示、内容未到）只把外壳收回去并回退路由。 */
export function closeDownloadsModal() {
  if (mod) {
    mod.closeDownloadsModal();
    return;
  }
  if (!isOpen("downloads-modal")) return;
  pendingClose = true;
  $("downloads-modal").classList.add("hidden");
  restoreDialogFocus();
  if (window.hubPanelClosed) window.hubPanelClosed("downloads");
}

/* 打开按模型下载弹窗（模型卡片上的 ⬇）。chunk 未就绪时不先显示外壳——
   它没有可独立展示的内容（包清单要等 GET /api/models/<id>/packages）。 */
export async function openModelDlModal(m) {
  try {
    const chunk = await ensure();
    chunk.openModelDlModal(m);
  } catch (e) {
    failOpen("model-dl-modal", e);
  }
}

/* 同步关闭（Esc / 路由关闭）：未加载即空转（面板不可能已可见，见上方竞态说明）。 */
export function closeModelDlModal() {
  if (mod) mod.closeModelDlModal();
}

/* 语言切换重画（app.js rerenderAll）：未加载即空转，交给 chunk 重新本地化。 */
export function relocalizeDownloads() {
  if (mod) mod.relocalize();
}

/* 页头 ⬇️ 必须在 chunk 到位前就能用，因此在外观层接线。
   goPanel 由 routing.js 传入以避开与它的模块环（与 stats-lazy 同一手法）。 */
export function wireDownloadsButton(goPanel) {
  const btn = $("downloads-btn");
  if (btn) btn.onclick = () => goPanel("downloads");
}
