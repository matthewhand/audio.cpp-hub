/* web/modules/command-palette-lazy.js — 命令面板（Ctrl/Cmd-K）的懒加载外观
 *
 * 与 modules/stats-lazy.js / voices-panel-lazy.js 同一形状：真模块
 * （modules/command-palette.js）只在用户按下 Ctrl/Cmd-K 之后才 import()，
 * 首屏模块图里只留这层几百字节的转发。
 *
 * 为什么要外观而不是在每个调用点直接 import("./command-palette.js")：
 *   - app.js 的 Esc 处理器是**同步**路径，且会在本模块从未加载时被触发
 *     （面板都没开，哪来的 Esc）——外观让它保持同步且无副作用（未加载即 no-op）。
 *   - 全局 Ctrl/Cmd-K 快捷键必须在 chunk 到位前就有效，否则首开直接失灵。
 *     快捷键因此**归外观层所有**，chunk 里不再重复注册：两份监听器会各处理一次
 *     同一次按键（打开又立刻关掉），这是个只在真浏览器里才显形的坑。
 *
 * 与下载 / 设置 / 音色库外观不同的一点：这里**不先亮外壳**。命令面板的核心就是
 * 那个搜索框，而外壳的 input / keydown 监听由 chunk 绑定——外壳先亮会吞掉抢跑
 * 的那几下按键。因此与 openVoicesPanel 一样整块等 chunk 到位再打开（首开多一次
 * 往返，之后走模块缓存）。 */

import { isOpen } from "./async-ui.js";

let mod = null; // 已解析的 command-palette.js 模块命名空间，null 直到首次打开
let inflight = null; // 进行中的动态 import，让连按共享同一次网络往返

/* 加载真模块（幂等、并发去重；失败不缓存，允许下次重试）。 */
function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./command-palette.js").then(
      m => (mod = m),
      e => {
        inflight = null;
        throw e;
      }
    );
  }
  return inflight;
}

/* 打开命令面板：等 chunk 到位后再交给真模块（见文件头「不先亮外壳」的理由）。 */
export async function openCommandPalette() {
  try {
    const m = await ensure();
    m.openCommandPalette();
  } catch (e) {
    // 加载失败就明确报错，而不是让快捷键看起来毫无反应
    console.error("command-palette: failed to load palette module", e);
  }
}

/* 同步关闭：模块从未加载时安全空转（面板只可能由上面的打开路径显示，
    Esc 处理器以面板可见为前提）。 */
export function closeCommandPalette() {
  if (mod) mod.closeCommandPalette();
}

/* 全局 Ctrl/Cmd-K：外观层求值时就挂上，因此 chunk 落地前的第一次按键也有效。
    chunk 侧刻意不再注册同一个监听器（见文件头）。 */
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
    e.preventDefault();
    if (isOpen("command-palette")) closeCommandPalette();
    else openCommandPalette();
  }
});
