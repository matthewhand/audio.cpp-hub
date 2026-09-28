/* #72 单元测试：file-browser.js 的 formatSize。
   字节排版已收口到 I18N.bytes（Intl），这里断言「null 不打扰 I18N、其余委托」
   的契约，不硬编码 ICU 的空格/千分位。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, extractFunction, makeFunction, makeI18nStub } from "./helpers/vm.mjs";

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
