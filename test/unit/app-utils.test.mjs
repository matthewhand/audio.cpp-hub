/* #72 单元测试：拆分后的纯工具函数（转义、URL 白名单、镜像改写、字节格式化、key=value 解析）。
   已迁移到 ES module 树的导出直接 dynamic import 真实源码（core/dom.js、core/format.js）；
   仍是模块内私有函数的（hfMirrorOf、parseEnvText、parseSessionOptionsText）从真实源文件抽取函数体求值。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, extractFunction, makeFunction, importWebModule } from "./helpers/vm.mjs";

const { esc, safeHttpUrl } = await importWebModule("core/dom.js");
const { fmtBytes } = await importWebModule("core/format.js");
const { I18N } = await importWebModule("core/i18n.js");

const t = (k, p) => (p ? k.replace(/\{(\w+)\}/g, (_m, n) => String(p[n] ?? _m)) : k);

function loadFrom(file, name, deps = {}) {
  return makeFunction(extractFunction(readWeb(file), name), deps);
}

test("app: esc 转义 HTML 特殊字符并处理 null", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc("<b>&\"'"), "&lt;b&gt;&amp;&quot;&#39;");
  assert.equal(esc(42), "42");
});

test("app: safeHttpUrl 只放行 http(s)", () => {
  assert.equal(safeHttpUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHttpUrl("  http://example.com  "), "http://example.com");
  assert.equal(safeHttpUrl("HTTPS://EXAMPLE.COM"), "HTTPS://EXAMPLE.COM");
  assert.equal(safeHttpUrl("javascript:alert(1)"), "");
  assert.equal(safeHttpUrl("ftp://example.com"), "");
  assert.equal(safeHttpUrl(null), "");
  assert.equal(safeHttpUrl({}), "");
});

test("app: hfMirrorOf 改写 huggingface.co 域名", () => {
  const hfMirrorOf = loadFrom("features/models.js", "hfMirrorOf");
  assert.equal(hfMirrorOf("https://huggingface.co/org/repo"), "https://hf-mirror.com/org/repo");
  assert.equal(hfMirrorOf(null), null);
});

test("app: fmtBytes 委托 I18N.bytes 并处理空值", () => {
  assert.equal(fmtBytes(null), "?");
  assert.equal(fmtBytes(-1), "?");
  assert.equal(fmtBytes(0), I18N.bytes(0));
  assert.equal(fmtBytes(1023), I18N.bytes(1023));
  assert.equal(fmtBytes(1024), I18N.bytes(1024));
  assert.equal(fmtBytes(1536), I18N.bytes(1536));
  assert.equal(fmtBytes(1024 * 1024), I18N.bytes(1024 * 1024));
  assert.equal(fmtBytes(1024 * 1024 * 1024 * 1024), I18N.bytes(1024 * 1024 * 1024 * 1024));
  assert.match(fmtBytes(1024), /B/);
});

test("app: parseEnvText 解析并校验 KEY=VALUE", () => {
  const parseEnvText = loadFrom("features/executables.js", "parseEnvText", {
    $: (id) => ({ value: id === "exec-env" ? "A=1\n\nB = two\n" : "" }),
    t,
  });
  assert.deepEqual({ ...parseEnvText() }, { A: "1", B: "two" });
  assert.throws(
    () =>
      loadFrom("features/executables.js", "parseEnvText", { $: () => ({ value: "1BAD=x" }), t })(),
    /exec\.envInvalid|1/,
  );
  assert.throws(
    () =>
      loadFrom("features/executables.js", "parseEnvText", { $: () => ({ value: "NOEQ" }), t })(),
    /exec\.envInvalid|1/,
  );
});

test("app: parseSessionOptionsText 允许点号键", () => {
  const parseSessionOptionsText = loadFrom("features/executables.js", "parseSessionOptionsText", {
    $: (id) => ({
      value: id === "launch-adv-options" ? "voxcpm2.weight_type=q8_0\nthreads=4\n" : "",
    }),
    t,
  });
  assert.deepEqual(
    { ...parseSessionOptionsText() },
    { "voxcpm2.weight_type": "q8_0", threads: "4" },
  );
  assert.throws(
    () =>
      loadFrom("features/executables.js", "parseSessionOptionsText", {
        $: () => ({ value: "oops" }),
        t,
      })(),
    /launch\.advInvalid|1/,
  );
});
