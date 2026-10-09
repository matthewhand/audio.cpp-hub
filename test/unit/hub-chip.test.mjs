/* 页头 chip 的纯显示模型。失败次数是 GET /api/stats totals.failed 的全量累计
   （不是最近一小时）；统计还没到时 failed 为空，调用方不画那一截。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFunction, loadI18n, makeBrowserSandbox, makeFunction, readWeb } from "./helpers/vm.mjs";

function load(lang) {
  const sandbox = makeBrowserSandbox({
    navigator: { language: lang === "en" ? "en-US" : "zh-CN" }
  });
  const I18N = loadI18n(sandbox);
  I18N.setLang(lang);
  const fn = extractFunction(readWeb("modules/hub-chip.js"), "hubChipModel");
  return makeFunction(fn, { t: (k, p) => I18N.t(k, p), I18N });
}

const en = load("en");
const zh = load("zh");

test("hubChipModel：en 就绪点颜色与失败复数", () => {
  const all = en({ total: 2, ready: 2, failed: 0 });
  assert.equal(all.dot, "ok");
  assert.equal(all.text, "Hub 2/2 ready");
  assert.equal(all.failed, "0 failures");
  assert.equal(all.failN, 0);
  assert.match(all.aria, /Hub 2\/2 ready/);
  assert.match(all.aria, /0 failures/);

  const some = en({ total: 2, ready: 1, failed: 1 });
  assert.equal(some.dot, "warn");
  assert.equal(some.failed, "1 failure");

  const none = en({ total: 2, ready: 0, failed: 3 });
  assert.equal(none.dot, "err");
  assert.equal(none.failed, "3 failures");

  const unknown = en({ total: 2, ready: 2, failed: null });
  assert.equal(unknown.failed, "");
  assert.equal(unknown.failN, null);
  assert.equal(unknown.dot, "ok");
});

test("hubChipModel：zh 文案", () => {
  const all = zh({ total: 2, ready: 2, failed: 0 });
  assert.equal(all.text, "Hub 2/2 就绪");
  assert.equal(all.failed, "失败 0 次");
  assert.equal(all.dot, "ok");
  const none = zh({ total: 1, ready: 0, failed: 2 });
  assert.equal(none.dot, "err");
  assert.equal(none.failed, "失败 2 次");
  assert.match(none.aria, /失败 2 次/);
});
