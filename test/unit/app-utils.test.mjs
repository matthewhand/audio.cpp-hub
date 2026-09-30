/* #72 单元测试：web/ 里的纯工具函数（转义、URL 白名单、镜像改写、字节格式化、key=value 解析）。
   这些函数不可导入，通过 vm 抽取源码函数体测试，不修改前端。
   #100 把 app.js 拆成 ES 模块后，这些函数分散在 web/modules/*.js，
   因此这里按「谁拥有这个函数」逐个指定源文件。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, extractFunction, makeFunction, makeI18nStub } from "./helpers/vm.mjs";

/* 函数 → 现在拥有它的文件（相对 web/）。
   设置弹窗拆成外观层 + 懒加载 chunk 后，可执行文件登记的解析函数（启动弹窗也在用）
   归首屏常驻的外观层 modules/settings-lazy.js。 */
const SRC = {
  esc: "modules/dom.js",
  safeHttpUrl: "modules/dom.js",
  hfMirrorOf: "modules/models.js",
  fmtBytes: "modules/downloads.js",
  parseEnvText: "modules/settings-lazy.js",
  parseSessionOptionsText: "modules/settings-lazy.js"
};

function load(name, deps = {}) {
  const file = SRC[name];
  if (!file) throw new Error(`no source file declared for ${name}`);
  return makeFunction(extractFunction(readWeb(file), name), deps);
}

const t = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (_m, n) => String(p[n] ?? _m)) : k);

test("app: esc 转义 HTML 特殊字符并处理 null", () => {
  const esc = load("esc");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
  assert.equal(esc(42), "42");
});

test("app: safeHttpUrl 只放行 http(s)", () => {
  const safeHttpUrl = load("safeHttpUrl");
  assert.equal(safeHttpUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHttpUrl("  http://example.com  "), "http://example.com");
  assert.equal(safeHttpUrl("HTTPS://EXAMPLE.COM"), "HTTPS://EXAMPLE.COM");
  assert.equal(safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpUrl("ftp://example.com"), "");
  assert.equal(safeHttpUrl(null), "");
  assert.equal(safeHttpUrl({}), "");
});

test("app: hfMirrorOf 改写 huggingface.co 域名", () => {
  const hfMirrorOf = load("hfMirrorOf");
  assert.equal(hfMirrorOf("https://huggingface.co/org/repo"), "https://hf-mirror.com/org/repo");
  assert.equal(hfMirrorOf(null), null);
});

/* 数字/单位排版已收口到 I18N.bytes（Intl），fmtBytes 只剩兜底分支 + 委托，
   因此这里断言契约与兜底，不硬编码 ICU 的空格/千分位。 */
test("app: fmtBytes 委托 I18N.bytes，非法值兜底为 ?", () => {
  const I18N = makeI18nStub();
  const fmtBytes = load("fmtBytes", { I18N });
  assert.equal(fmtBytes(null), "?");
  assert.equal(fmtBytes(undefined), "?");
  assert.equal(fmtBytes(-1), "?");
  assert.deepEqual(I18N.calls, []); // 兜底分支不应打到 I18N
  assert.equal(fmtBytes(0), "BYTES(0)");
  assert.equal(fmtBytes(1536), "BYTES(1536)");
  assert.equal(fmtBytes(1024 ** 4), `BYTES(${1024 ** 4})`);
  assert.deepEqual(I18N.calls, [0, 1536, 1024 ** 4]);
});

test("app: parseEnvText 解析并校验 KEY=VALUE", () => {
  const parseEnvText = load("parseEnvText", {
    $: (id) => ({ value: id === "exec-env" ? "A=1\n\nB = two\n" : "" }),
    t
  });
  assert.deepEqual({ ...parseEnvText() }, { A: "1", B: "two" });
  assert.throws(
    () => load("parseEnvText", { $: () => ({ value: "1BAD=x" }), t })(),
    /exec\.envInvalid|1/
  );
  assert.throws(
    () => load("parseEnvText", { $: () => ({ value: "NOEQ" }), t })(),
    /exec\.envInvalid|1/
  );
});

test("app: parseSessionOptionsText 允许点号键", () => {
  const parseSessionOptionsText = load("parseSessionOptionsText", {
    $: (id) => ({
      value: id === "launch-adv-options" ? "voxcpm2.weight_type=q8_0\nthreads=4\n" : ""
    }),
    t
  });
  assert.deepEqual(
    { ...parseSessionOptionsText() },
    { "voxcpm2.weight_type": "q8_0", threads: "4" }
  );
  assert.throws(
    () => load("parseSessionOptionsText", { $: () => ({ value: "oops" }), t })(),
    /launch\.advInvalid|1/
  );
});
