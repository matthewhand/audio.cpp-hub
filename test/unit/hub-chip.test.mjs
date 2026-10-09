/* 页头 chip 的纯显示模型。失败次数是 GET /api/stats totals.failed 的全量累计
   （不是最近一小时）；统计还没到时 failed 为空，调用方不画那一截。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, loadI18n, makeBrowserSandbox, readWeb } from "./helpers/vm.mjs";

function load(lang) {
  const browser = makeBrowserSandbox({
    navigator: { language: lang === "en" ? "en-US" : "zh-CN" }
  });
  const I18N = loadI18n(browser);
  I18N.setLang(lang);
  const src = readWeb("modules/hub-chip.js");
  const bundle = ["hubChipModel", "farmChipModel", "selectChip"].map(n => extractFunction(src, n)).join("\n");
  const context = vm.createContext({ t: (k, p) => I18N.t(k, p), I18N });
  return vm.runInContext(`${bundle}\n({ hubChipModel, farmChipModel, selectChip })`, context);
}

const en = load("en");
const zh = load("zh");

test("hubChipModel：en 就绪点颜色与失败复数", () => {
  const all = en.hubChipModel({ total: 2, ready: 2, failed: 0 });
  assert.equal(all.dot, "ok");
  assert.equal(all.text, "Hub 2/2 ready");
  assert.equal(all.failed, "0 failures");
  assert.equal(all.failN, 0);
  assert.match(all.aria, /Hub 2\/2 ready/);
  assert.match(all.aria, /0 failures/);

  const some = en.hubChipModel({ total: 2, ready: 1, failed: 1 });
  assert.equal(some.dot, "warn");
  assert.equal(some.failed, "1 failure");

  const none = en.hubChipModel({ total: 2, ready: 0, failed: 3 });
  assert.equal(none.dot, "err");
  assert.equal(none.failed, "3 failures");

  const unknown = en.hubChipModel({ total: 2, ready: 2, failed: null });
  assert.equal(unknown.failed, "");
  assert.equal(unknown.failN, null);
  assert.equal(unknown.dot, "ok");
});

test("hubChipModel：zh 文案", () => {
  const all = zh.hubChipModel({ total: 2, ready: 2, failed: 0 });
  assert.equal(all.text, "Hub 2/2 就绪");
  assert.equal(all.failed, "失败 0 次");
  assert.equal(all.dot, "ok");
  const none = zh.hubChipModel({ total: 1, ready: 0, failed: 2 });
  assert.equal(none.dot, "err");
  assert.equal(none.failed, "失败 2 次");
  assert.match(none.aria, /失败 2 次/);
});

test("farmChipModel / selectChip：农场可用走农场，否则退回本机", () => {
  const ok = en.farmChipModel({ hubsUp: 4, hubsTotal: 4, failures: 0 });
  assert.equal(ok.dot, "ok");
  assert.equal(ok.text, "Farm 4/4");
  assert.equal(ok.failed, "0 failures");

  const partial = en.farmChipModel({ hubsUp: 3, hubsTotal: 4, failures: 1 });
  assert.equal(partial.dot, "warn");
  assert.equal(partial.text, "Farm 3/4");
  assert.equal(partial.failed, "1 failure");

  const down = en.farmChipModel({ hubsUp: 0, hubsTotal: 4, failures: 2 });
  assert.equal(down.dot, "err");
  assert.equal(down.failed, "2 failures");

  const farm = en.selectChip({ available: true, hubsUp: 3, hubsTotal: 4, failures: 1 }, { total: 2, ready: 2, failed: 0 });
  assert.equal(farm.source, "farm");
  assert.equal(farm.model.text, "Farm 3/4");

  const local = en.selectChip({ available: false }, { total: 2, ready: 2, failed: 0 });
  assert.equal(local.source, "hub");
  assert.equal(local.model.text, "Hub 2/2 ready");

  const zhFarm = zh.selectChip({ available: true, hubsUp: 1, hubsTotal: 2, failures: 0 }, { total: 1, ready: 0, failed: 9 });
  assert.equal(zhFarm.source, "farm");
  assert.equal(zhFarm.model.text, "农场 1/2");
  assert.equal(zhFarm.model.dot, "warn");
  assert.equal(zhFarm.model.failed, "失败 0 次");

  const zhLocal = zh.selectChip(null, { total: 1, ready: 0, failed: 2 });
  assert.equal(zhLocal.source, "hub");
  assert.equal(zhLocal.model.text, "Hub 0/1 就绪");
});
