/* 合成按钮下方状态行的纯文案。en / zh 两份词典各跑一遍。
   刻意不出现「Streaming」——任务不是流式下发的。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, loadI18n, makeBrowserSandbox, readWeb } from "./helpers/vm.mjs";

function load(lang) {
  const sandbox = makeBrowserSandbox({
    navigator: { language: lang === "en" ? "en-US" : "zh-CN" }
  });
  const I18N = loadI18n(sandbox);
  I18N.setLang(lang);
  const ticker = readWeb("modules/live-ticker.js");
  const bundle = [
    extractFunction(readWeb("modules/instances.js"), "formatBusyElapsed"),
    ...["tickerInstanceName", "tickerRtf", "tickerRtfText", "tickerErrorText", "liveTickerText"]
      .map(name => extractFunction(ticker, name))
  ].join("\n");
  const context = vm.createContext({ t: (k, p) => I18N.t(k, p), TICKER_ERROR_MAX: 60 });
  return new vm.Script(`${bundle}\n({ tickerInstanceName, tickerRtf, tickerRtfText, tickerErrorText, liveTickerText })`, {
    filename: "live-ticker-pure.js"
  }).runInContext(context);
}

const en = load("en");
const zh = load("zh");

test("tickerRtf：墙上耗时 ÷ 音频秒，非正数省略", () => {
  assert.equal(en.tickerRtf(4.1, 1), 4.1);
  assert.equal(en.tickerRtfText(1.18), "1.18×");
  assert.equal(en.tickerRtf(0, 1), null);
  assert.equal(en.tickerRtf(1, 0), null);
  assert.equal(en.tickerRtf(1, -2), null);
  assert.equal(en.tickerRtf(Number.NaN, 1), null);
  assert.equal(en.tickerRtfText(0), "");
});

test("liveTickerText：en 运行 / 完成 / 失败", () => {
  assert.equal(
    en.liveTickerText({ phase: "running", name: "breeze", elapsedSec: 3.2 }).text,
    "Generating on breeze · 3.2s"
  );
  assert.equal(en.liveTickerText({ phase: "running", name: "breeze" }).text, "Generating on breeze");
  const done = en.liveTickerText({
    phase: "done", name: "breeze", elapsedSec: 4.1, wallSec: 1.18, audioSec: 1
  });
  assert.equal(done.text, "Done on breeze · 4.1s · RTF 1.18×");
  assert.equal(done.tone, "ok");
  const noRtf = en.liveTickerText({ phase: "done", name: "breeze", elapsedSec: 4.1, wallSec: 4.1 });
  assert.equal(noRtf.text, "Done on breeze · 4.1s");
  assert.doesNotMatch(noRtf.text, /RTF/);
  const failed = en.liveTickerText({ phase: "failed", name: "breeze", error: "engine\nblew up" });
  assert.equal(failed.text, "Failed on breeze · engine blew up");
  assert.equal(failed.tone, "danger");
  assert.equal(en.liveTickerText({ phase: "failed", name: "breeze" }).text, "Failed on breeze");
  const long = "x".repeat(80);
  assert.match(en.tickerErrorText(long, 60), /…$/);
  assert.equal(en.tickerErrorText(long, 60).length, 61);
  for (const text of [done.text, failed.text, noRtf.text]) {
    assert.doesNotMatch(text, /Streaming/);
  }
});

test("liveTickerText：zh 运行 / 完成 / 失败", () => {
  assert.equal(
    zh.liveTickerText({ phase: "running", name: "breeze", elapsedSec: 3.2 }).text,
    "正在 breeze 上生成 · 3.2s"
  );
  const done = zh.liveTickerText({
    phase: "done", name: "breeze", elapsedSec: 4.1, wallSec: 1.18, audioSec: 1
  });
  assert.equal(done.text, "已在 breeze 上完成 · 4.1s · RTF 1.18×");
  assert.equal(
    zh.liveTickerText({ phase: "done", name: "breeze", elapsedSec: 4.1 }).text,
    "已在 breeze 上完成 · 4.1s"
  );
  const failed = zh.liveTickerText({ phase: "failed", name: "breeze", error: "端口被占用" });
  assert.equal(failed.text, "在 breeze 上失败 · 端口被占用");
  assert.equal(failed.tone, "danger");
  assert.equal(zh.liveTickerText({ phase: "failed", name: "breeze" }).text, "在 breeze 上失败");
  assert.doesNotMatch(done.text, /流式/);
});

test("tickerInstanceName：任务自带名字优先，否则实例列表，最后 #id", () => {
  assert.equal(en.tickerInstanceName({ instanceName: " breeze " }, []), "breeze");
  assert.equal(
    en.tickerInstanceName({ instanceId: "ab" }, [{ id: "ab", instanceName: "sanotts" }]),
    "sanotts"
  );
  assert.equal(en.tickerInstanceName({ instanceId: "ab" }, []), "#ab");
  assert.equal(en.tickerInstanceName(null, null), "");
});
