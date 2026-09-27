/* #72 单元测试：file-browser.js 的 formatSize（优先委托 WavUtil，缺失时本地实现）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readWeb, extractFunction, makeFunction } from "./helpers/vm.mjs";

const src = readWeb("file-browser.js");

test("file-browser: formatSize 委托 WavUtil.formatSize", () => {
  const calls = [];
  const fn = makeFunction(extractFunction(src, "formatSize"), {
    window: { WavUtil: { formatSize: (b) => { calls.push(b); return "DELEGATED"; } } },
    WavUtil: { formatSize: (b) => { calls.push(b); return "DELEGATED"; } }
  });
  assert.equal(fn(1234), "DELEGATED");
  assert.deepEqual(calls, [1234]);
});

test("file-browser: formatSize 无 WavUtil 时本地格式化", () => {
  const fn = makeFunction(extractFunction(src, "formatSize"), { window: {}, WavUtil: undefined });
  assert.equal(fn(null), "");
  assert.equal(fn(512), "512 B");
  assert.equal(fn(2048), "2.0 KB");
  assert.equal(fn(1024 * 1024), "1.0 MB");
  assert.equal(fn(1024 * 1024 * 1024), "1.00 GB");
});
