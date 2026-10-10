/* 合成按钮下方状态行的纯文案。en / zh 两份词典各跑一遍。
   运行中写 "Streaming from …"；完成 / 失败行不含 Streaming。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  extractFunction,
  loadEsModule,
  loadI18n,
  makeBrowserSandbox,
  makeFunction,
  readWeb
} from "./helpers/vm.mjs";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";

function load(lang) {
  const sandbox = makeBrowserSandbox({
    navigator: { language: lang === "en" ? "en-US" : "zh-CN" }
  });
  const I18N = loadI18n(sandbox);
  I18N.setLang(lang);
  const ticker = readWeb("modules/live-ticker.js");
  const bundle = [
    extractFunction(readWeb("modules/instances.js"), "formatBusyElapsed"),
    ...[
      "tickerInstanceName",
      "tickerRtf",
      "tickerRtfText",
      "tickerErrorText",
      "liveTickerText",
      "tickerElapsedSec"
    ].map((name) => extractFunction(ticker, name))
  ].join("\n");
  const context = vm.createContext({ t: (k, p) => I18N.t(k, p), TICKER_ERROR_MAX: 60 });
  return new vm.Script(
    `${bundle}\n({ tickerInstanceName, tickerRtf, tickerRtfText, tickerErrorText, liveTickerText, tickerElapsedSec })`,
    {
      filename: "live-ticker-pure.js"
    }
  ).runInContext(context);
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
    "Streaming from breeze · 3.2s"
  );
  assert.equal(
    en.liveTickerText({ phase: "running", name: "breeze", elapsedSec: 0 }).text,
    "Streaming from breeze · 0.0s"
  );
  assert.equal(
    en.liveTickerText({ phase: "running", name: "breeze" }).text,
    "Streaming from breeze"
  );
  assert.equal(en.tickerElapsedSec(5_000, 5_000), 0);
  assert.equal(en.tickerElapsedSec(5_000, 2_000), 0);
  assert.equal(en.tickerElapsedSec(1_000, 4_200), 3.2);
  assert.equal(en.tickerElapsedSec(null, 4_200), 0);
  const rtf = en.liveTickerText({
    phase: "done",
    name: "breeze",
    elapsedSec: 4.1,
    wallSec: 4.1,
    audioSec: 4.1 / 1.07
  });
  assert.equal(rtf.text, "Done on breeze · 4.1s · RTF 1.07×");
  const done = en.liveTickerText({
    phase: "done",
    name: "breeze",
    elapsedSec: 4.1,
    wallSec: 1.18,
    audioSec: 1
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
    "正在从 breeze 流式生成 · 3.2s"
  );
  assert.equal(
    zh.liveTickerText({ phase: "running", name: "breeze", elapsedSec: 0 }).text,
    "正在从 breeze 流式生成 · 0.0s"
  );
  assert.equal(zh.tickerElapsedSec(5_000, 2_000), 0);
  const done = zh.liveTickerText({
    phase: "done",
    name: "breeze",
    elapsedSec: 4.1,
    wallSec: 1.18,
    audioSec: 1
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

test("running ticker paints 0.0s immediately and does not start its own interval", () => {
  const world = createDomWorld();
  const live = world.el('<p id="tts-live" class="live-ticker hidden"></p>');
  world.document.body.appendChild(live);
  world.document.createElement = (tag) => new StubElement(world, tag);
  const timers = [];
  const formatBusyElapsed = makeFunction(
    extractFunction(readWeb("modules/instances.js"), "formatBusyElapsed")
  );
  const elapsed = loadEsModule("modules/elapsed.js", { Date });
  const i18nBox = makeBrowserSandbox({ navigator: { language: "en-US" } });
  const I18N = loadI18n(i18nBox);
  I18N.setLang("en");
  const mod = loadEsModule("modules/live-ticker.js", {
    document: world.document,
    $: world.$,
    t: (k, p) => I18N.t(k, p),
    Date,
    setInterval(fn, ms) {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setTimeout: () => 0,
    clearTimeout() {},
    instances: [{ id: "breeze-id", instanceName: "breeze" }],
    activeInstanceId: "breeze-id",
    formatBusyElapsed,
    syncBusyTimer() {},
    rememberStart: elapsed.rememberStart,
    taskStartMs: elapsed.taskStartMs,
    rawStartMs: elapsed.rawStartMs,
    clearTaskStart: elapsed.clearTaskStart,
    resetElapsed: elapsed.resetElapsed,
    Api: { get: () => Promise.resolve(null) },
    window: { addEventListener() {} }
  });
  const future = Date.now() + 2000;
  mod.noteTaskEvent("task.started", { taskId: "t-run", instanceId: "breeze-id", ts: future });
  const span = live.querySelector(".badge-elapsed");
  assert.ok(span, "elapsed span is in the first paint");
  assert.equal(live.textContent, "Streaming from breeze · ");
  assert.equal(span.textContent, "0.0s");
  assert.equal(span.getAttribute("data-start"), String(future));
  assert.equal(span.className.includes("num"), true);
  assert.equal(timers.length, 0, "status line must not start a second interval");
  assert.equal(span.textContent, "0.0s");

  mod.resetLiveTicker();
  live.children.length = 0;
  mod.noteTaskEvent("task.started", { taskId: "t-run2", instanceId: "breeze-id" });
  const span2 = live.querySelector(".badge-elapsed");
  assert.equal(span2.textContent, "0.0s");
  const started = Number(span2.getAttribute("data-start"));
  assert.ok(Math.abs(started - Date.now()) < 2000);
  mod.resetLiveTicker();
});
