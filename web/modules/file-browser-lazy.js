/* web/modules/file-browser-lazy.js — 服务器端文件选择器的懒加载外观
 *
 * 与 modules/stats-lazy.js 同一形状：真模块（modules/file-browser.js）只在用户点了
 * 「浏览…」（启动弹窗的权重目录 / GGUF / 可执行文件，或音频选择器的本地路径页签）之后
 * 才 import()，首屏模块图里只留这层几百字节的转发。
 *
 * 为什么要外观而不是在每个调用点直接 import("./file-browser.js")：
 * app.js 有两条**同步**路径要碰它——Esc 关最上层弹窗（cancel）与语言切换重画
 * （relocalize），两条都可能在本模块从未加载时触发（fb-overlay 都没建，哪来的 Esc）。
 * 外观把「已加载的命名空间」记在一个模块级变量里，让这两条路径保持同步且无副作用
 * （未加载即 no-op），异步的打开路径才 await chunk。
 *
 * web/audio-picker.js 是经典脚本、不能 import 本模块，它直接
 * import("/modules/file-browser-lazy.js") 走同一个 ensure()，chunk 仍只取一次。 */

let mod = null; // 已解析的 file-browser.js 模块命名空间，null 直到首次打开
let inflight = null; // 进行中的动态 import，让并发打开共享同一次网络往返

/* 加载真模块（幂等、并发去重；失败不缓存，允许下次重试）。 */
function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./file-browser.js").then(
      m => (mod = m),
      e => {
        inflight = null;
        throw e;
      }
    );
  }
  return inflight;
}

/* 打开浏览弹窗：等 chunk 到位后再建 overlay。用户取消时返回 null。 */
export async function browseServerFile(options) {
  const m = await ensure();
  return m.open(options);
}

/* 同步关闭：模块从未加载时（不可能开着弹窗）安全空转。 */
export function cancelFileBrowser() {
  if (mod) mod.cancel();
}

/* 语言切换钩子：模块未加载时无需刷新任何文案。 */
export function relocalizeFileBrowser() {
  if (mod) mod.relocalize();
}
