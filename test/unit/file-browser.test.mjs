/* #72 单元测试：file-browser.js 的 formatSize，以及 relocalize() 的注册关系。
   字节排版已收口到 I18N.bytes（Intl），这里断言「null 不打扰 I18N、其余委托」
   的契约，不硬编码 ICU 的空格/千分位。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchBrace, readWeb, extractFunction, makeFunction, makeI18nStub } from "./helpers/vm.mjs";

const src = readWeb("file-browser.js");

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
   FileBrowser.relocalize 是单例方法，由 web/app.js 的 rerenderAll 在语言切换时调用。
   现状是「防御性路径」而非活 bug：fb-overlay 打开时 <header> 被 syncInert 设成 inert，
   页头语言按钮点不到，所以没有可达的用户路径。但删掉那行不会有任何测试报警，
   于是这里把它钉住。断言只针对「rerenderAll 体内出现该调用」——rerenderAll 会重渲
   一堆模块，逐一 stub 只会把测试绑死在无关的重构上。 */
const appSrc = readWeb("app.js");

function rerenderAllBody() {
  const open = appSrc.indexOf("{", appSrc.indexOf("function rerenderAll"));
  return appSrc.slice(open, matchBrace(appSrc, open) + 1);
}

test("app: rerenderAll 在语言切换时调用 FileBrowser.relocalize", () => {
  const body = rerenderAllBody();
  assert.match(body, /FileBrowser\s*\.\s*relocalize\s*\(/);
});

test("app: rerenderAll 在 FileBrowser 未加载时安全跳过", () => {
  /* index.html 里 file-browser.js 是经典脚本、app.js 是 defer 的模块入口，前者一定
     先求值；但 rerenderAll 也被 I18N.onChange 之外的路径间接触发，这里锁住「脚本缺席
     时不抛」的防御分支，避免将来有人把它改成无条件调用。 */
  const body = rerenderAllBody();
  assert.match(body, /if\s*\(\s*window\.FileBrowser\s*&&\s*FileBrowser\.relocalize\s*\)/);
});

test("file-browser: relocalize 未打开弹窗时直接返回且不碰 DOM", () => {
  /* overlay 是 IIFE 内的模块级 let，只在首次 open() 时创建，脚本刚求值完时为 null。
     抽出的函数体看不到闭包，靠 makeFunction 注入同名依赖还原这一点。 */
  const fn = makeFunction(extractFunction(src, "relocalize"), {
    window: {},
    overlay: null,
    I18N: { t: (k) => k }
  });
  assert.equal(fn(), undefined);
});
