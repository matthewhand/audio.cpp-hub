/* web/modules/events.js — hub 事件流
 *
 * 轮询 /api/events，把后端推送的实例状态变化等事件转成 toast。
 * 事件去重用的 seenEvents 只在本模块内使用。 */

import { Api } from "./api.js";
import { showToast } from "./async-ui.js";

/* ---------- 事件通知（toast） ---------- */
export let eventsInitialized = false;
export const seenEvents = new Set();

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
