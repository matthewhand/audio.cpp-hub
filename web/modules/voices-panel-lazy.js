/* web/modules/voices-panel-lazy.js — 音色库管理面板的懒加载外观
 *
 * 与 modules/stats-lazy.js / modules/file-browser-lazy.js 同一形状：真模块
 * （modules/voices-panel.js）只在用户点了页头 🎙（或路由到 #/voices）之后才
 * import()，首屏模块图里只留这层几百字节的转发。
 *
 * 为什么要外观而不是在每个调用点直接 import("./voices-panel.js")：
 *   - routing.js 的 applyRoute 与 app.js 的 Esc 处理器都是**同步**路径，且会在
 *     本模块从未加载时被触发（面板都没开，哪来的 Esc）——外观让这两条保持同步
 *     且无副作用（未加载即 no-op）。
 *   - web/voice-select.js 是**经典脚本**，import 不了 ES 模块，它按下拉的「管理」
 *     按钮走 window.openVoicesPanel；外观是这块 window 全局的唯一挂载点。
 *
 * 曾经是经典脚本 web/voices-panel.js（首屏就下载的 9.2 KiB），随 perf:budget 的
 * 棘轮改成懒加载 chunk，实测表见 scripts/perf-budget.mjs 顶注。 */

import { $ } from "./dom.js";

let mod = null;       // 已解析的 voices-panel.js 模块命名空间，null 直到首次打开
let inflight = null;  // 进行中的动态 import，让并发打开共享同一次网络往返

/* 加载真模块（幂等、并发去重；失败不缓存，允许下次重试）。 */
function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./voices-panel.js").then(
      m => (mod = m),
      e => {
        inflight = null;
        throw e;
      }
    );
  }
  return inflight;
}

/* 打开音色库：等 chunk 到位后再加载列表（首开多一次往返，之后走模块缓存）。 */
export async function openVoicesPanel() {
  try {
    const m = await ensure();
    m.openVoicesPanel();
  } catch (e) {
    // 加载失败就明确报错，而不是让点击看起来毫无反应
    console.error("voices-panel: failed to load panel module", e);
  }
}

/* 同步关闭：模块从未加载时（不可能开着面板——Esc 与 applyRoute 的关闭分支都以
   面板已可见为前提）安全空转。 */
export function closeVoicesPanel() {
  if (mod) mod.closeVoicesPanel();
}

/* 页头 🎙 必须在 chunk 到位前就能用，因此在外观层接线。
   goPanel / hubTogglePanel 由 routing.js 传入以避开与它的模块环。
   刻意用 dom.js 的 $（而不是 file-browser-lazy / stats-lazy 那种裸
   document.getElementById）：$("id").onclick 会被 scripts/ui-inventory.mjs 认成
   「这个按钮的 click 处理在这里」，裸 getElementById 认不出来。 */
export function wireVoicesButton(goPanel) {
  const btn = $("voices-btn");
  if (btn) btn.onclick = () => goPanel("voices");
}

/* 经典脚本 voice-select.js 的「管理音色库」按钮走 window（它不能 import 本模块）。
   挂载时机没问题：voice-select.js 在解析期就求值，但只在点击那一刻才读
   window.openVoicesPanel，那时本文件（defer 模块）早已执行完。 */
window.openVoicesPanel = openVoicesPanel;
window.closeVoicesPanel = closeVoicesPanel;
