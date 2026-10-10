/* 「上一条录音」条（web/modules/last-take.js）：四个纯函数 + 一条渲染路径。
 *
 * 渲染路径挂 DOM 桩、桩 AudioContext 与桩 fetch，走真实的 noteTtsTake / seedLastTake /
 * play / timeupdate 入口：条在第一次合成完成前收起，完成后长出 80 根条，
 * 解码失败退化成等高矮条但照样能播。相对时间的文案按 en / zh 两份真词典各跑一遍。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDomWorld, StubElement } from "./helpers/dom-stub.mjs";
import {
  extractFunction,
  loadEsModule,
  loadI18n,
  makeBrowserSandbox,
  makeFunction,
  readWeb
} from "./helpers/vm.mjs";

const MIN = 60 * 1000;
const T0 = 1_700_000_000_000;

/* live-ticker.js 的实例名解析（真源码，抽出来注入沙箱，不在测试里另写一份） */
const tickerInstanceName = makeFunction(
  extractFunction(readWeb("modules/live-ticker.js"), "tickerInstanceName")
);

function i18nFor(lang) {
  const box = makeBrowserSandbox({ navigator: { language: lang === "en" ? "en-US" : "zh-CN" } });
  const I18N = loadI18n(box);
  I18N.setLang(lang);
  return I18N;
}

function pure(lang = "en", extra = {}) {
  const I18N = i18nFor(lang);
  return loadEsModule("modules/last-take.js", {
    $: () => null,
    t: (k, p) => I18N.t(k, p),
    I18N,
    tickerInstanceName,
    document: {},
    Date,
    Promise,
    window: {},
    setInterval: () => 0,
    clearInterval() {},
    ...extra
  });
}

/* ---------- 纯函数 ---------- */

test("peaksFromChannelData：静音全 0、越界钳 1、采样比桶少时每桶仍读到一个采样", () => {
  const mod = pure();

  const silence = mod.peaksFromChannelData(new Float32Array(800), 80);
  assert.equal(silence.length, 80);
  assert.deepEqual([...new Set(silence)], [0]);

  // 每桶一段：桶 i 的采样是 i，所以峰值单调上升，最后一桶是 1
  const ramp = mod.peaksFromChannelData(
    Float32Array.from({ length: 80 }, (_, i) => i / 79),
    80
  );
  assert.equal(ramp[0], 0);
  assert.equal(ramp[79], 1);
  for (let i = 1; i < 80; i++) assert.ok(ramp[i] > ramp[i - 1], i + " should grow");

  // 负值取绝对值；超过 1 的值钳到 1（解码器给脏数据也不越界）
  const loud = mod.peaksFromChannelData(new Float32Array([-0.5, 0.25, 1.4, -9]), 4);
  assert.deepEqual(Array.from(loud), [0.5, 0.25, 1, 1]);

  // 3 个采样 / 80 桶：每桶至少读到 1 个采样（不够一桶就重复最近的那个），不凭空造峰
  const few = mod.peaksFromChannelData(new Float32Array([0.1, 0.2, 0.3]), 80);
  assert.equal(few.length, 80);
  assert.ok(Math.abs(few[0] - 0.1) < 1e-6, "第一桶读到第一个采样");
  assert.ok(Math.abs(Math.max(...Array.from(few)) - 0.3) < 1e-6, "最响的那个采样仍然在图上");
  assert.ok(Array.from(few).every((v) => v >= 0 && v <= 1));

  // 空 / 非数组：给出 80 个 0，不抛错
  assert.deepEqual([...new Set(mod.peaksFromChannelData(null, 80))], [0]);
  assert.deepEqual([...new Set(mod.peaksFromChannelData([], 8))], [0]);
  assert.equal(mod.peaksFromChannelData(new Float32Array(10), 0).length, 1);
});

test("formatClock：m:ss、超过一小时、以及非法值", () => {
  const mod = pure();
  assert.equal(mod.formatClock(0), "0:00");
  assert.equal(mod.formatClock(3), "0:03");
  assert.equal(mod.formatClock(7.9), "0:07");
  assert.equal(mod.formatClock(61), "1:01");
  assert.equal(mod.formatClock(600), "10:00");
  assert.equal(mod.formatClock(3661), "1:01:01");
  assert.equal(mod.formatClock(-4), "0:00");
  assert.equal(mod.formatClock(Number.NaN), "0:00");
  assert.equal(mod.formatClock(null), "0:00");
});

test("relativeAgo：en 走「just now / N min ago / N h ago」，zh 同样成文", () => {
  const en = pure("en");
  assert.equal(en.relativeAgo(T0, T0), "just now");
  assert.equal(en.relativeAgo(T0, T0 + 59000), "just now");
  assert.equal(en.relativeAgo(T0, T0 + MIN), "1 min ago");
  assert.equal(en.relativeAgo(T0, T0 + 45 * MIN), "45 min ago");
  assert.equal(en.relativeAgo(T0, T0 + 60 * MIN), "1 h ago");
  assert.equal(en.relativeAgo(T0, T0 + 5 * 3600 * 1000), "5 h ago");
  assert.equal(en.relativeAgo(T0, T0 + 30 * 3600 * 1000), "1 d ago");
  // 未来的时间戳（服务端时钟快）不显示负数
  assert.equal(en.relativeAgo(T0 + 60000, T0), "just now");
  assert.equal(en.relativeAgo(null, T0), "");
  assert.equal(en.relativeAgo(0, T0), "");
  assert.equal(en.relativeAgo(T0, null), "");

  const zh = pure("zh");
  assert.equal(zh.relativeAgo(T0, T0), "刚刚");
  assert.equal(zh.relativeAgo(T0, T0 + MIN), "1 分钟前");
  assert.equal(zh.relativeAgo(T0, T0 + 3 * 3600 * 1000), "3 小时前");
  assert.equal(zh.relativeAgo(T0, T0 + 2 * 86400 * 1000), "2 天前");
});

test("progressToBarIndex：0 / 中点 / 末尾 / 时长未知", () => {
  const mod = pure();
  assert.equal(mod.progressToBarIndex(0, 7, 80), 0);
  assert.equal(mod.progressToBarIndex(3.5, 7, 80), 40);
  assert.equal(mod.progressToBarIndex(7, 7, 80), 80);
  assert.equal(mod.progressToBarIndex(9, 7, 80), 80, "超出总时长钳到末尾");
  assert.equal(mod.progressToBarIndex(-1, 7, 80), 0);
  assert.equal(mod.progressToBarIndex(3, 0, 80), 0, "时长 0 不假装在播放");
  assert.equal(mod.progressToBarIndex(3, null, 80), 0);
  assert.equal(mod.progressToBarIndex(Number.NaN, 7, 80), 0);
  assert.equal(mod.progressToBarIndex(3, 7, 0), 0);
});

test("barBox / flatPeaks / takeAudioUrl：几何、最小条高与历史 URL 拼法", () => {
  const mod = pure();
  const loud = mod.barBox(7, 1);
  assert.equal(loud.h, 28);
  assert.equal(loud.y, 0);
  assert.equal(loud.w, 0.8);
  assert.equal(loud.x, 7);
  // 静音段也有 2 单位高（居中），不是 0
  const quiet = mod.barBox(0, 0);
  assert.equal(quiet.h, 2);
  assert.equal(quiet.y, 13);
  assert.equal(mod.barBox(3, 9).h, 28, "越界的峰值仍钳在画布内");

  const flat = mod.flatPeaks();
  assert.equal(flat.length, 80);
  assert.deepEqual([...new Set(flat)], [0]);

  // 与 tasks.js 填 #tts-player.src 的拼法一致
  assert.equal(
    mod.takeAudioUrl({ id: "ab12cd34", modelId: "breeze-tts" }),
    "/api/history/breeze-tts/ab12cd34/audio"
  );
  assert.equal(mod.takeAudioUrl({ id: "ab12cd34" }), "");
  assert.equal(mod.takeAudioUrl(null), "");
});

/* ---------- 渲染路径 ---------- */

const STRIP_HTML = `<div id="last-take" class="last-take hidden" role="group" aria-labelledby="last-take-title">
    <button type="button" id="last-take-play" class="take-play"><svg class="icon"><use href="#i-play"></use></svg></button>
    <div class="take-head">
      <span class="take-ttl" id="last-take-title">Last take</span>
      <span class="take-meta"><b id="last-take-name"></b><span id="last-take-ago"></span></span>
    </div>
    <div id="last-take-wave" class="take-wave" role="slider" tabindex="0"></div>
    <span class="take-time num"><b id="last-take-cur">0:00</b> / <span id="last-take-dur">0:00</span></span>
    <a id="last-take-download" class="btn-ghost take-ibtn" download="tts.wav"></a>
    <button type="button" id="last-take-rerun" class="take-rerun"></button>
  </div>`;

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** 挂出真实的 TTS 面板片段：录音条 + <audio id="tts-player"> + 文本框 + 合成按钮 */
function mount(world) {
  const panel = new StubElement(world, "div");
  panel.innerHTML =
    STRIP_HTML +
    `<div id="tts-result" class="hidden"><audio id="tts-player" controls=""></audio></div>` +
    `<textarea id="tts-text"></textarea><button id="tts-submit" class="btn"></button>`;
  world.document.body.appendChild(panel);

  const audio = world.$("tts-player");
  audio.paused = true;
  audio.ended = false;
  audio.currentTime = 0;
  audio.duration = Number.NaN;
  audio.playCalls = 0;
  audio.pauseCalls = 0;
  audio.play = function () {
    audio.playCalls++;
    audio.paused = false;
    return Promise.resolve();
  };
  audio.pause = function () {
    audio.pauseCalls++;
    audio.paused = true;
  };

  const submit = world.$("tts-submit");
  submit.clicks = 0;
  submit.click = function () {
    submit.clicks++;
  };
  return { panel, audio, submit };
}

function doneTask(over = {}) {
  return {
    id: "ab12cd34",
    instanceId: "i1",
    instanceName: "breeze",
    modelId: "breeze-tts",
    category: "tts",
    status: "DONE",
    createdAt: T0 - 2 * MIN,
    startedAt: T0 - 2 * MIN,
    finishedAt: T0 - MIN,
    text: "你好，世界",
    ...over
  };
}

/** 声道各一条：声道 1（= 数组下标 1）刻意比声道 0 大很多，用来证明只取声道 0。 */
function channelData(over = {}) {
  return {
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(64)),
    ...over
  };
}

function audioContextStub(channels, duration = 7) {
  const state = { created: 0, closed: 0 };
  const Ctx = function () {
    state.created++;
    this.decodeAudioData = () =>
      Promise.resolve({
        duration,
        getChannelData: (ch) => channels[ch]
      });
    this.close = () => {
      state.closed++;
      return Promise.resolve();
    };
  };
  state.Ctx = Ctx;
  return state;
}

function worldModule(world, extra = {}) {
  const timers = [];
  const I18N = i18nFor("en");
  const sandbox = {
    $: world.$,
    document: world.document,
    t: (k, p) => I18N.t(k, p),
    I18N,
    tickerInstanceName,
    Date: { now: () => T0 },
    Promise,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    window: {},
    setInterval(fn, ms) {
      const id = timers.length + 1;
      timers.push({ id, fn, ms });
      return id;
    },
    clearInterval(id) {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    fetch: () => Promise.resolve(channelData()),
    ...extra
  };
  const mod = loadEsModule("modules/last-take.js", sandbox);
  mod.__timers = timers;
  mod.__sandbox = sandbox;
  return mod;
}

test("任务完成后录音条出现：80 根条、实例与相对时间、下载链接与再生成", async () => {
  const world = createDomWorld();
  mount(world);
  // 每桶 10 个采样：第 b 桶的峰值是 b/79——从矮到高一路上去
  const bar = new Float32Array(800);
  for (let i = 0; i < bar.length; i++) bar[i] = Math.floor(i / 10) / 79;
  // 立体声：声道 1 刻意拉满。波形只取声道 0，取错了这里就会 80 根全满格。
  const ctx = audioContextStub([bar, new Float32Array(800).fill(1)]);
  const mod = worldModule(world, {
    window: { AudioContext: ctx.Ctx },
    fetch(url) {
      mod.__fetched = (mod.__fetched || []).concat(url);
      return Promise.resolve(channelData());
    }
  });

  // 没有 take：整条收起，也不开相对时间计时器
  assert.equal(world.$("last-take").classList.contains("hidden"), true);
  assert.equal(mod.__timers.length, 0, "no take, no timer");

  assert.equal(mod.noteTtsTake(doneTask()), true);
  assert.equal(world.$("last-take").classList.contains("hidden"), false);
  assert.equal(world.$("last-take-name").textContent, "breeze");
  assert.equal(world.$("last-take-ago").textContent, "1 min ago");
  assert.equal(
    world.$("last-take-download").getAttribute("href"),
    "/api/history/breeze-tts/ab12cd34/audio"
  );
  assert.equal(world.$("last-take-download").getAttribute("download"), "tts-breeze.wav");
  assert.equal(world.$("last-take").querySelectorAll("rect").length, 80);
  assert.match(world.$("last-take-wave").innerHTML, /viewBox="0 0 80 28"/);
  assert.match(world.$("last-take-wave").innerHTML, /preserveAspectRatio="none"/);
  assert.doesNotMatch(
    world.$("last-take-wave").innerHTML,
    /style=/,
    "CSP: 波形上不许有 style 属性"
  );
  assert.equal(mod.__timers.length, 1, "有 take 之后才开 30s 的相对时间计时器");
  assert.equal(mod.__timers[0].ms, 30000);

  // 还没解码完：先画等高矮条
  assert.equal(world.$("last-take-dur").textContent, "0:00");
  await settle();
  assert.equal(mod.__fetched.length, 1, "波形只取一次音频");
  assert.equal(mod.__fetched[0], "/api/history/breeze-tts/ab12cd34/audio");
  assert.equal(ctx.created, 1, "只为解码建一次 AudioContext");
  assert.equal(ctx.closed, 1, "解码完就关掉");
  assert.equal(world.$("last-take").querySelectorAll("rect").length, 80);
  assert.equal(world.$("last-take-dur").textContent, "0:07", "时长来自解码出的 AudioBuffer");

  // 真波形：一路递增的 80 根，而不是清一色的矮条；也没被更响的声道 1 带成满格
  const heights = [...world.$("last-take").querySelectorAll("rect")].map((r) =>
    Number(r.getAttribute("height"))
  );
  assert.equal(new Set(heights).size > 1, true);
  assert.equal(Math.max(...heights), 28);
  assert.equal(Math.min(...heights), 2, "最低的那根仍是 2 单位的矮条");
  assert.equal(heights[1], 2, "第二桶（1/79）几乎贴地");

  // 非 tts / 未完成的条目不碰这条（条上只放真正落盘的录音）
  assert.equal(mod.noteTtsTake(doneTask({ category: "asr" })), false);
  assert.equal(mod.noteTtsTake(doneTask({ status: "FAILED" })), false);
  assert.equal(mod.noteTtsTake(null), false);
  assert.equal(world.$("last-take").querySelectorAll("rect").length, 80, "已有条不会被清空");

  mod.resetLastTake();
});

test("播放 / 暂停、timeupdate 着色、拖动与方向键定位", async () => {
  const world = createDomWorld();
  const ui = mount(world);
  const ctx = audioContextStub([new Float32Array(800)]);
  const mod = worldModule(world, { window: { AudioContext: ctx.Ctx } });

  assert.equal(mod.noteTtsTake(doneTask()), true);
  await settle();
  // 落版本身会把播放头归零（换 src），下面的计数从这儿开始算
  ui.audio.playCalls = 0;
  ui.audio.pauseCalls = 0;
  assert.equal(ui.audio.playCalls, 0, "落版只换 src，不自己开声");

  // 播放键切换 <audio>，图标与 aria-label 跟着换
  world.fire(world.$("last-take-play"), "click");
  await settle();
  assert.equal(ui.audio.playCalls, 1);
  assert.equal(ui.audio.paused, false);
  const use = world.$("last-take-play").querySelector("use");
  assert.equal(use.getAttribute("href"), "#i-pause");
  assert.equal(world.$("last-take-play").getAttribute("aria-label"), "Pause");
  assert.equal(world.$("last-take-play").title, "Pause");

  world.fire(world.$("last-take-play"), "click");
  assert.equal(ui.audio.pauseCalls, 1);
  assert.equal(use.getAttribute("href"), "#i-play");
  assert.equal(world.$("last-take-play").getAttribute("aria-label"), "Play the last take");

  // timeupdate → 波形着色 + 时间标签 + 滑块的 aria 值
  ui.audio.currentTime = 3.5;
  world.fire(ui.audio, "timeupdate");
  const rects = world.$("last-take").querySelectorAll("rect");
  assert.equal(rects.filter((r) => r.classList.contains("played")).length, 40);
  assert.equal(world.$("last-take-cur").textContent, "0:03");
  assert.equal(world.$("last-take-dur").textContent, "0:07");
  assert.equal(world.$("last-take-wave").getAttribute("aria-valuemax"), "7.00");
  assert.equal(world.$("last-take-wave").getAttribute("aria-valuenow"), "3.50");
  assert.equal(world.$("last-take-wave").getAttribute("aria-valuetext"), "0:03 / 0:07");
  assert.equal(world.$("last-take-wave").getAttribute("role"), "slider");

  // 拖到一半：条与标签一起过去
  mod.seekTake(0.5);
  assert.equal(ui.audio.currentTime, 3.5);
  assert.equal(world.$("last-take-cur").textContent, "0:03");

  // 方向键：右移总时长的 5%，左移回去；End / Home 到两端
  world.fire(world.$("last-take-wave"), "keydown", { key: "Home" });
  assert.equal(ui.audio.currentTime, 0);
  assert.equal(world.$("last-take").querySelectorAll("rect.played").length, 0);
  world.fire(world.$("last-take-wave"), "keydown", { key: "ArrowRight" });
  assert.ok(Math.abs(ui.audio.currentTime - 0.35) < 1e-9, "5% of 7s = 0.35s");
  world.fire(world.$("last-take-wave"), "keydown", { key: "End" });
  assert.equal(ui.audio.currentTime, 7);
  assert.equal(world.$("last-take").querySelectorAll("rect.played").length, 80);
  world.fire(world.$("last-take-wave"), "keydown", { key: "ArrowLeft" });
  assert.ok(Math.abs(ui.audio.currentTime - 6.65) < 1e-9);

  // ended：整条回到未播色
  ui.audio.ended = true;
  ui.audio.paused = true;
  ui.audio.currentTime = 0;
  world.fire(ui.audio, "ended");
  assert.equal(world.$("last-take").querySelectorAll("rect.played").length, 0);
  assert.equal(world.$("last-take-play").querySelector("use").getAttribute("href"), "#i-play");

  mod.resetLastTake();
});

test("解码失败 / 没有 WebAudio：画等高矮条，照样能播", async () => {
  const world = createDomWorld();
  mount(world);
  const mod = worldModule(world, {
    // fetch 失败
    fetch: () => Promise.reject(new Error("offline"))
  });
  assert.equal(mod.noteTtsTake(doneTask()), true);
  assert.equal(world.$("last-take").querySelectorAll("rect").length, 80);
  await settle();
  assert.equal(world.$("last-take").classList.contains("hidden"), false, "取不到音频也不收起这条");
  const heights = [...world.$("last-take").querySelectorAll("rect")].map((r) =>
    Number(r.getAttribute("height"))
  );
  assert.deepEqual([...new Set(heights)], [2], "退化成等高的矮条");

  // 没有 WebAudio（老浏览器 / 无头环境）
  const noCtx = createDomWorld();
  const noCtxUi = mount(noCtx);
  const mod2 = worldModule(noCtx, { window: {} });
  assert.equal(mod2.noteTtsTake(doneTask()), true);
  await settle();
  assert.equal(noCtx.$("last-take").querySelectorAll("rect").length, 80);

  // 播放与定位仍然可用（波形只是装饰）
  noCtx.fire(noCtx.$("last-take-play"), "click");
  await settle();
  assert.equal(noCtxUi.audio.playCalls, 1);
  noCtxUi.audio.duration = 7;
  mod2.seekTake(0.5);
  assert.equal(noCtxUi.audio.currentTime, 3.5);

  mod.resetLastTake();
  mod2.resetLastTake();
});

test("首屏从任务清单里回填上一条录音；没有就保持收起", () => {
  const world = createDomWorld();
  mount(world);
  const mod = worldModule(world, { window: {}, fetch: () => Promise.reject(new Error("offline")) });
  assert.equal(world.$("last-take").classList.contains("hidden"), true);

  assert.equal(
    mod.seedLastTake([
      { id: "aaaa1111", modelId: "m", category: "asr", status: "DONE", finishedAt: T0 },
      { id: "bbbb2222", modelId: "m", category: "tts", status: "FAILED", finishedAt: T0 },
      doneTask({ id: "old00001", finishedAt: T0 - 10 * MIN }),
      doneTask({ id: "new00001", finishedAt: T0 - MIN, instanceName: "calm" })
    ]),
    true
  );
  assert.equal(world.$("last-take").classList.contains("hidden"), false);
  assert.equal(
    world.$("last-take-download").getAttribute("href"),
    "/api/history/breeze-tts/new00001/audio"
  );
  assert.equal(world.$("last-take-name").textContent, "calm");

  // 已经有 take：清单回填不覆盖本次会话已经显示的那条
  assert.equal(mod.seedLastTake([doneTask({ id: "other0001" })]), false);
  assert.equal(
    world.$("last-take-download").getAttribute("href"),
    "/api/history/breeze-tts/new00001/audio"
  );

  // 空清单 / 非数组：不画任何东西
  mod.resetLastTake();
  assert.equal(mod.seedLastTake([]), false);
  assert.equal(mod.seedLastTake(null), false);
  assert.equal(
    mod.seedLastTake([{ id: "x", modelId: "m", category: "tts", status: "DONE", finishedAt: T0 }]),
    true
  );
  mod.resetLastTake();
  assert.equal(world.$("last-take").classList.contains("hidden"), true);
  assert.equal(mod.__timers.length, 0, "收起后不再留着相对时间计时器");
});

test("再生成：把文本改回这条录音的，然后交给合成按钮自己的 handler", () => {
  const world = createDomWorld();
  const ui = mount(world);
  const mod = worldModule(world, { window: {}, fetch: () => Promise.reject(new Error("offline")) });
  mod.noteTtsTake(doneTask());
  world.$("tts-text").value = "被改过的别的文本";

  world.fire(world.$("last-take-rerun"), "click");
  assert.equal(world.$("tts-text").value, "你好，世界", "用这条录音的文本再生成");
  assert.equal(ui.submit.clicks, 1, "请求体照旧由合成按钮的 handler 收集");

  // 表单里已经是同一段文本时不重复改写
  world.fire(world.$("last-take-rerun"), "click");
  assert.equal(ui.submit.clicks, 2);

  // 没有 take 就不触发
  mod.resetLastTake();
  world.fire(world.$("last-take-rerun"), "click");
  assert.equal(ui.submit.clicks, 2);
});

test("语言切换后重画动态文案（相对时间 / 按钮名）", () => {
  const world = createDomWorld();
  mount(world);
  const I18N = i18nFor("zh");
  const mod = loadEsModule("modules/last-take.js", {
    $: world.$,
    document: world.document,
    t: (k, p) => I18N.t(k, p),
    I18N,
    tickerInstanceName,
    Date: { now: () => T0 },
    Promise,
    window: {},
    setInterval: () => 0,
    clearInterval() {},
    fetch: () => Promise.reject(new Error("offline"))
  });
  mod.noteTtsTake(doneTask());
  assert.equal(world.$("last-take-ago").textContent, "1 分钟前");
  assert.equal(world.$("last-take-name").textContent, "breeze");
  I18N.setLang("en");
  mod.renderLastTake();
  assert.equal(world.$("last-take-ago").textContent, "1 min ago");
  assert.equal(world.$("last-take-play").getAttribute("aria-label"), "Play the last take");
  assert.equal(world.$("last-take-download").getAttribute("aria-label"), "Download this take");
  mod.resetLastTake();
});
