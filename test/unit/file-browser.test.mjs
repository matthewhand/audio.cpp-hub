/* #72 单元测试：file-browser.js 的 formatSize，以及 relocalize() 的注册关系。
   字节排版已收口到 I18N.bytes（Intl），这里断言「null 不打扰 I18N、其余委托」
   的契约，不硬编码 ICU 的空格/千分位。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBrace, readWeb, extractFunction, makeFunction, makeI18nStub } from "./helpers/vm.mjs";

const src = readWeb("modules/file-browser.js");

test("file-browser: formatSize 委托 I18N.bytes", () => {
  const I18N = makeI18nStub();
  const fn = makeFunction(extractFunction(src, "formatSize"), { window: {}, I18N });
  assert.equal(fn(1234), "BYTES(1234)");
  assert.deepEqual(I18N.calls, [1234]);
  assert.equal(fn(0), "BYTES(0)");
  assert.equal(fn(1024 ** 3), `BYTES(${1024 ** 3})`);
  assert.deepEqual(I18N.calls, [1234, 0, 1024 ** 3]);
});

test("file-browser: formatSize 空值返回空串且不调用 I18N", () => {
  const I18N = makeI18nStub();
  const fn = makeFunction(extractFunction(src, "formatSize"), { window: {}, I18N });
  assert.equal(fn(null), "");
  assert.equal(fn(undefined), "");
  assert.deepEqual(I18N.calls, []);
});

/* ---- relocalize() 的注册关系（防止 wiring 被静默删掉而退化成死代码） ----
   文件选择器是懒加载 chunk（web/modules/file-browser.js），首屏只有外观层
   modules/file-browser-lazy.js；relocalize 由外观层转给已加载的 chunk，而外观层
   由 web/app.js 的 rerenderAll 在语言切换时调用。
   现状是「防御性路径」而非活 bug：fb-overlay 打开时 <header> 被 syncInert 设成 inert，
   页头语言按钮点不到，所以没有可达的用户路径。但删掉那行不会有任何测试报警，
   于是这里把它钉住。断言只针对「rerenderAll 体内出现该调用」——rerenderAll 会重渲
   一堆模块，逐一 stub 只会把测试绑死在无关的重构上。 */
const appSrc = readWeb("app.js");
const lazySrc = readWeb("modules/file-browser-lazy.js");

function rerenderAllBody() {
  const open = appSrc.indexOf("{", appSrc.indexOf("function rerenderAll"));
  return appSrc.slice(open, matchBrace(appSrc, open) + 1);
}

test("app: rerenderAll 在语言切换时调用外观层的 relocalizeFileBrowser", () => {
  const body = rerenderAllBody();
  assert.match(body, /relocalizeFileBrowser\s*\(/);
});

test("外观层: chunk 未加载时 relocalize / cancel 都是 no-op", () => {
  /* 首屏切语言时 chunk 十有八九还没拉过（浏览弹窗没开过），此时转发必须空转而不是
     抛错；将来有人把它改成无条件转发就会在这里失败。 */
  assert.match(
    lazySrc,
    /export function relocalizeFileBrowser\(\)\s*{\s*if \(mod\) mod\.relocalize\(\);\s*}/
  );
  assert.match(
    lazySrc,
    /export function cancelFileBrowser\(\)\s*{\s*if \(mod\) mod\.cancel\(\);\s*}/
  );
});

test("外观层: 打开路径经动态 import 拉 chunk，且并发打开共享同一次加载", () => {
  /* 「点浏览…」才付这 17 KiB 是这次改动的全部意义，所以把 import() 钉在这里：
     改成静态 import 就会把它拽回首屏模块图，perf:budget 会立刻超标。 */
  assert.match(lazySrc, /import\("\.\/file-browser\.js"\)/);
  assert.match(lazySrc, /if \(!inflight\)/);
});

test("file-browser: relocalize 未打开弹窗时直接返回且不碰 DOM", () => {
  /* overlay 是模块级 let，只在首次 open() 时创建，模块刚求值完时为 null。
     抽出的函数体看不到闭包，靠 makeFunction 注入同名依赖还原这一点。 */
  const fn = makeFunction(extractFunction(src, "relocalize"), {
    window: {},
    overlay: null,
    I18N: { t: (k) => k }
  });
  assert.equal(fn(), undefined);
});
