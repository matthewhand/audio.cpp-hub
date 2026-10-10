/* 合成按钮下方状态行的纯文案 + 渲染路径。en / zh 两份词典各跑一遍。
   运行中写 "Streaming from …"（有历史时带 RTF 预估）；完成 / 失败行不含 Streaming。 */
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
  // medianRtf 读模块常量 RTF_SAMPLE_CAP（抽出来的函数不带模块作用域），所以这里要注入
  const NAMES = [
    "tickerInstanceName",
    "tickerRtf",
    "tickerRtfText",
    "tickerRtfEstText",
    "taskRtf",
    "medianRtf",
    "tickerErrorText",
    "liveTickerText",
    "tickerElapsedSec"
  ];
  const bundle = [
    extractFunction(readWeb("modules/instances.js"), "formatBusyElapsed"),
    ...NAMES.map((name) => extractFunction(ticker, name))
  ].join("\n");
  const context = vm.createContext({
    t: (k, p) => I18N.t(k, p),
    TICKER_ERROR_MAX: 60,
    RTF_SAMPLE_CAP: 10
  });
  return new vm.Script(`${bundle}\n({ ${NAMES.join(", ")} })`, {
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
  assert.equal(en.tickerRtfEstText(1.07), "1.1×");
  assert.equal(en.tickerRtfEstText(0.94), "0.9×");
  assert.equal(en.tickerRtfEstText(0), "");
  assert.equal(en.tickerRtfEstText(null), "");
  assert.equal(en.tickerRtfEstText(Number.NaN), "");
});

test("taskRtf / medianRtf：只看同一实例最近 10 条已完成任务", () => {
  const t = (id, instanceId, wallSec, audioSec, extra) => ({
    id,
    instanceId,
    status: "DONE",
    startedAt: 1000,
    finishedAt: 1000 + wallSec * 1000,
    result: { durationSec: audioSec },
    ...extra
  });
  assert.equal(en.taskRtf(t("a", "i1", 4, 2)), 2);
  assert.equal(en.taskRtf(t("a", "i1", 4, null)), null);
  assert.equal(en.taskRtf(t("a", "i1", null, 2)), null);
  assert.equal(en.taskRtf(null), null);
  // finishedAt 早于 startedAt：脏数据，跳过
  assert.equal(
    en.taskRtf({
      id: "a",
      instanceId: "i1",
      status: "DONE",
      startedAt: 5000,
      finishedAt: 1000,
      result: { durationSec: 2 }
    }),
    null
  );
  // 没跑过的任务 JSON 里 startedAt / finishedAt 是 null，不能当成 0 算出离谱的墙上耗时
  assert.equal(
    en.taskRtf({
      id: "a",
      instanceId: "i1",
      status: "DONE",
      startedAt: null,
      finishedAt: 1000,
      result: { durationSec: 2 }
    }),
    null
  );
  assert.equal(
    en.taskRtf({
      id: "a",
      instanceId: "i1",
      status: "DONE",
      startedAt: 1000,
      finishedAt: null,
      result: { durationSec: 2 }
    }),
    null
  );
  assert.equal(
    en.taskRtf({ id: "a", instanceId: "i1", status: "DONE", startedAt: 1000, finishedAt: 1000 }),
    null
  ); // taskRtf 是纯算术，不认状态；「只认已完成」由 medianRtf 把关
  assert.equal(
    en.taskRtf({
      id: "a",
      instanceId: "i1",
      status: "RUNNING",
      startedAt: 1,
      finishedAt: 5,
      result: { durationSec: 1 }
    }),
    0.004
  );

  // 空 / 非数组 / 空实例 id
  assert.equal(en.medianRtf([], "i1"), null);
  assert.equal(en.medianRtf(null, "i1"), null);
  assert.equal(en.medianRtf("nope", "i1"), null);
  assert.equal(en.medianRtf([t("a", "i1", 4, 2)], ""), null);
  assert.equal(en.medianRtf([t("a", "i1", 4, 2)], null), null);
  // 全是缺时长的条目：算不出来
  assert.equal(en.medianRtf([t("x", "i1", 4, null), t("y", "i1", 4, undefined)], "i1"), null);

  const same = [t("a", "i1", 4, 2), t("b", "i1", 6, 3), t("c", "i1", 5, 2.5)];
  assert.equal(en.medianRtf(same, "i1"), 2);
  // 别台实例的样本一律忽略
  assert.equal(en.medianRtf(same.concat([t("z", "i2", 100, 0.1)]), "i1"), 2);
  assert.equal(en.medianRtf([t("z", "i2", 100, 0.1)], "i1"), null);
  // 缺一段时长的条目被跳过，剩下的仍能算出中位数
  assert.equal(
    en.medianRtf([t("x", "i1", 4, null), t("a", "i1", 4, 2), t("b", "i1", 6, 3)], "i1"),
    2
  );
  // 只认 DONE：运行中 / 排队 / 失败 / 取消都不算「生成过」
  for (const status of ["RUNNING", "QUEUED", "FAILED", "CANCELLED"]) {
    assert.equal(en.medianRtf([t("a", "i1", 4, 2, { status })], "i1"), null);
  }

  // 偶数个取中间两个的平均：(2 + 3) / 2，与输入顺序无关
  assert.equal(en.medianRtf([t("a", "i1", 2, 1), t("b", "i1", 6, 2)], "i1"), 2.5);
  assert.equal(en.medianRtf([t("b", "i1", 6, 2), t("a", "i1", 2, 1)], "i1"), 2.5);
  // 奇数个取中间那一个
  assert.equal(en.medianRtf([t("a", "i1", 1, 1), t("b", "i1", 4, 2), t("c", "i1", 3, 1)], "i1"), 2);
  // 单个样本就是它自己
  assert.equal(en.medianRtf([t("a", "i1", 3, 1)], "i1"), 3);

  // 只留最近 10 条：10 条旧样本（墙上 100s、RTF 100，finishedAt 全部更早）+ 10 条新样本
  // （墙上 1s、RTF 1）。按「全部」取会是 (1 + 100) / 2 = 50.5
  const fresh = [];
  const stale = [];
  for (let i = 0; i < 10; i++) {
    fresh.push(t("f" + i, "i1", 1, 1, { startedAt: 2_000_000, finishedAt: 2_001_000 }));
    stale.push(t("s" + i, "i1", 100, 1, { startedAt: 1_000, finishedAt: 101_000 }));
  }
  assert.equal(en.medianRtf(fresh.concat(stale), "i1"), 1);
  // 不做离群剔除：离群值只要够新就照样进样本（9 条 RTF 1 + 最新 1 条 RTF 89）
  const outlier = t("x", "i1", 89, 1, { startedAt: 3_000_000, finishedAt: 3_089_000 });
  assert.equal(en.medianRtf(fresh.concat([outlier]), "i1"), 1);
  // finishedAt 相同（同一批落盘）时按数组顺序截取，仍是平凡中位数
  assert.equal(en.medianRtf([t("a", "i1", 1, 1), t("b", "i1", 4, 2), t("c", "i1", 3, 1)], "i1"), 2);
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
  // 有 RTF 历史时，运行中就带预估（一位小数 + 「~」），在实例名与计时之间
  assert.equal(
    en.liveTickerText({ phase: "running", name: "breeze", rtfEstimate: 1.07 }).text,
    "Streaming from breeze · RTF ~1.1×"
  );
  assert.equal(
    en.liveTickerText({
      phase: "running",
      name: "breeze",
      elapsedSec: 3.2,
      rtfEstimate: 1.07
    }).text,
    "Streaming from breeze · RTF ~1.1× · 3.2s"
  );
  // 没有历史时不给「RTF ~~」，仍回到原来的两段式
  assert.equal(
    en.liveTickerText({
      phase: "running",
      name: "breeze",
      elapsedSec: 3.2,
      rtfEstimate: null
    }).text,
    "Streaming from breeze · 3.2s"
  );
  assert.equal(
    en.liveTickerText({
      phase: "running",
      name: "breeze",
      elapsedSec: 3.2,
      rtfEstimate: 0
    }).text,
    "Streaming from breeze · 3.2s"
  );
  // 计时是活的：渲染时用 elapsedSec 缺省（NaN）拿「不带数字」的前缀，再接共享计时片段
  assert.equal(
    en.liveTickerText({
      phase: "running",
      name: "breeze",
      elapsedSec: NaN,
      rtfEstimate: 1.07
    }).text,
    "Streaming from breeze · RTF ~1.1×"
  );
  assert.equal(
    en.liveTickerText({ phase: "running", name: "breeze", elapsedSec: NaN }).text,
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
  // 完成态用精确 RTF（两位小数），不吃运行中的预估
  const done = en.liveTickerText({
    phase: "done",
    name: "breeze",
    elapsedSec: 4.1,
    wallSec: 1.18,
    audioSec: 1,
    rtfEstimate: 9.9
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
  assert.equal(
    zh.liveTickerText({
      phase: "running",
      name: "breeze",
      elapsedSec: 3.2,
      rtfEstimate: 1.07
    }).text,
    "正在从 breeze 流式生成 · RTF ~1.1× · 3.2s"
  );
  assert.equal(
    zh.liveTickerText({
      phase: "running",
      name: "breeze",
      elapsedSec: NaN,
      rtfEstimate: 1.07
    }).text,
    "正在从 breeze 流式生成 · RTF ~1.1×"
  );
  assert.equal(
    zh.liveTickerText({ phase: "running", name: "breeze", elapsedSec: 3.2 }).text,
    "正在从 breeze 流式生成 · 3.2s"
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

/* ---- 渲染路径：挂上 DOM 桩与可控时钟，走 noteTaskEvent / noteTask / 选中实例切换三条真实入口 ---- */

const T0 = 1_700_000_000_000;
const settle = () => new Promise((resolve) => setImmediate(resolve));

function mountTicker() {
  const world = createDomWorld();
  const live = world.el('<p id="tts-live" class="live-ticker hidden"></p>');
  world.document.body.appendChild(live);
  world.document.createElement = (tag) => new StubElement(world, tag);
  const timers = [];
  const clock = { now: T0 };
  const fetches = [];
  const formatBusyElapsed = makeFunction(
    extractFunction(readWeb("modules/instances.js"), "formatBusyElapsed")
  );
  const elapsed = loadEsModule("modules/elapsed.js", { Date: { now: () => clock.now } });
  const i18nBox = makeBrowserSandbox({ navigator: { language: "en-US" } });
  const I18N = loadI18n(i18nBox);
  I18N.setLang("en");
  const winListeners = new Map();
  // breeze 最近两条：8s/5 = 1.6 与 8s/10 = 0.8 → 中位数 1.2；calm 只有一条：2s/4 = 0.5
  const doneTask = (id, instanceId, wallSec, audioSec) => ({
    id,
    instanceId,
    status: "DONE",
    startedAt: 1_000_000,
    finishedAt: 1_000_000 + wallSec * 1000,
    result: { durationSec: audioSec }
  });
  const history = [
    doneTask("b1", "breeze-id", 8, 5),
    doneTask("b2", "breeze-id", 8, 10),
    doneTask("c1", "calm-id", 2, 4)
  ];
  const sandbox = {
    document: world.document,
    $: world.$,
    t: (k, p) => I18N.t(k, p),
    Date: { now: () => clock.now },
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
    instances: [
      { id: "breeze-id", instanceName: "breeze" },
      { id: "calm-id", instanceName: "calm" }
    ],
    activeInstanceId: "breeze-id",
    formatBusyElapsed,
    syncBusyTimer() {},
    rememberStart: elapsed.rememberStart,
    taskStartMs: elapsed.taskStartMs,
    rawStartMs: elapsed.rawStartMs,
    clearTaskStart: elapsed.clearTaskStart,
    resetElapsed: elapsed.resetElapsed,
    Api: {
      get(url) {
        fetches.push(url);
        return Promise.resolve(url === "/api/tasks" ? history : null);
      }
    },
    window: {
      addEventListener(type, cb) {
        if (!winListeners.has(type)) winListeners.set(type, []);
        winListeners.get(type).push(cb);
      }
    }
  };
  const mod = loadEsModule("modules/live-ticker.js", sandbox);
  return { world, live, mod, clock, fetches, timers, sandbox, winListeners };
}

/* 跑一次任务轮询的 noteTask：startedAt 固定成 T0，让耗时只由可控时钟推进 */
function poll(mod, taskId, instanceId) {
  mod.noteTask({ id: taskId, instanceId, status: "RUNNING", startedAt: T0 });
}

test("running ticker shows the estimated RTF and refetches at most every 30s", async () => {
  const { live, mod, clock, fetches, timers } = mountTicker();
  // 第一帧：中位数还没回来，只画实例名 + 计时
  mod.noteTaskEvent("task.started", { taskId: "t-run", instanceId: "breeze-id", ts: T0 });
  assert.equal(live.textContent, "Streaming from breeze · ");
  assert.equal(live.querySelector(".badge-elapsed").textContent, "0.0s");
  assert.equal(timers.length, 0, "status line must not start a second interval");
  assert.deepEqual(fetches, ["/api/tasks"], "a running task pulls the history once");

  // 清单回来后重画：预估进前缀，计时片段还在，仍不开自己的 interval
  await settle();
  assert.equal(live.textContent, "Streaming from breeze · RTF ~1.2× · ");
  assert.equal(live.querySelector(".badge-elapsed").textContent, "0.0s");
  assert.equal(timers.length, 0);
  assert.equal(live.className, "live-ticker");

  // 2s 轮询的每一拍都在缓存期内，不再发请求，文案不变
  for (let i = 0; i < 3; i++) {
    clock.now += 2000;
    poll(mod, "t-run", "breeze-id");
  }
  await settle();
  assert.equal(fetches.length, 1, "within RTF_POLL_MS the cached median is reused");
  assert.equal(live.textContent, "Streaming from breeze · RTF ~1.2× · ");
  assert.equal(live.querySelector(".badge-elapsed").textContent, "6.0s");

  // 超过 30s：重算一次（结果相同，文案不变）
  clock.now += 31000;
  poll(mod, "t-run", "breeze-id");
  await settle();
  assert.equal(fetches.length, 2, "one refetch after RTF_POLL_MS");
  assert.equal(fetches[1], "/api/tasks");
  assert.equal(live.textContent, "Streaming from breeze · RTF ~1.2× · ");
  assert.equal(live.querySelector(".badge-elapsed").textContent, "37.0s");

  mod.resetLiveTicker();
});

test("running ticker omits the estimate without history and follows switches", async () => {
  const { live, mod, clock, fetches, sandbox } = mountTicker();
  // 这台实例还没有可用历史：整段省略，仍是原来的两段式
  sandbox.Api = {
    get(url) {
      fetches.push(url);
      return Promise.resolve([]);
    }
  };
  mod.noteTaskEvent("task.started", { taskId: "t-run", instanceId: "breeze-id", ts: T0 });
  await settle();
  assert.equal(live.textContent, "Streaming from breeze · ");
  assert.equal(fetches.length, 1);
  clock.now += 2000;
  poll(mod, "t-run", "breeze-id");
  await settle();
  assert.equal(fetches.length, 1, "a null median is cached too");
  mod.resetLiveTicker();

  // 换了选中实例：新实例各自缓存，第一次就为它拉一次
  const second = mountTicker();
  second.mod.startLiveTicker();
  second.mod.noteTaskEvent("task.started", { taskId: "t-run", instanceId: "breeze-id", ts: T0 });
  await settle();
  assert.equal(second.live.textContent, "Streaming from breeze · RTF ~1.2× · ");
  assert.equal(second.fetches.length, 1);
  second.sandbox.activeInstanceId = "calm-id";
  for (const cb of second.winListeners.get("hub-active-instance") || []) cb();
  assert.equal(second.live.className, "live-ticker hidden", "the old task's line comes down");
  assert.equal(second.fetches.length, 2, "switching the selected instance fetches for it");
  second.clock.now += 5000;
  second.mod.noteTaskEvent("task.started", {
    taskId: "t-calm",
    instanceId: "calm-id",
    ts: second.clock.now
  });
  await settle();
  assert.equal(second.live.textContent, "Streaming from calm · RTF ~0.5× · ");
  assert.equal(second.fetches.length, 2, "calm 的中位数用的是刚才那次拉取");
  second.mod.resetLiveTicker();
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
