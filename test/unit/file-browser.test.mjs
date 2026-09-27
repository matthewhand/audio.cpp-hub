/* #72 单元测试：file-browser.js 的 formatSize（现统一委托 I18N.bytes，空值返回空串）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, extractFunction, makeFunction } from "./helpers/vm.mjs";

const src = readWeb("file-browser.js");

test("file-browser: formatSize 委托 I18N.bytes", () => {
  const calls = [];
  const fn = makeFunction(extractFunction(src, "formatSize"), {
    I18N: {
      bytes: (b) => {
        calls.push(b);
        return "DELEGATED";
      },
    },
  });
  assert.equal(fn(1234), "DELEGATED");
  assert.deepEqual(calls, [1234]);
});

test("file-browser: formatSize 空值返回空串且不触达 I18N", () => {
  const fn = makeFunction(extractFunction(src, "formatSize"), {
    I18N: {
      bytes: () => {
        throw new Error("I18N.bytes 不应被调用");
      },
    },
  });
  assert.equal(fn(null), "");
  assert.equal(fn(undefined), "");
});
