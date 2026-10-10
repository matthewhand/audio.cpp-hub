/* web/modules/last-take.js — 「上一条录音」条（概念稿 .take）
 *
 * 位置：合成按钮（#tts-submit）正上方。组成与概念稿一致：
 *   圆形播放按钮 30px → 「Last take」标题 + 「实例 · 1 分钟前」→ 波形（80 根圆角条）
 *   → 「0:03 / 0:07」→ 下载 → 再生成一次（repeat 图标）。
 *
 * 数据源只有一个：tts 任务结束时 tasks.js 已经用来填 #tts-player.src 的那个历史
 * wav URL（renderTaskResult 里同一行调 noteTtsTake）。本模块**不重建请求体、
 * 也不换播放地址**：播放仍由 #tts-player 自己按那个 URL 走，下载链接也还是同一个
 * 文件。代价是浏览器会把这个文件取两次（<audio> 自己一次 + 为画波形的这一次
 * fetch）；改成 blob URL 可以只取一次，但那样就把面板上那个规范的历史 URL 顶掉了
 * （下载链接与既有的结果区语义都依赖它），不划算。
 * 解码失败 / 浏览器没有 WebAudio 时画一排等高的矮条，播放不受影响（波形只是装饰，
 * 不是播放器）。
 *
 * 计时器：只有「多久之前」这一个相对时间，由本模块自己的 30s interval 重画，
 * 第一次有录音之前不开、strip 收起时关掉。这不是 elapsed.js 的生成耗时——
 * 那一类文本全站只有 instances.js 的一个 interval 在写，本模块不碰。 */

import { $, t } from "./dom.js";
import { tickerInstanceName } from "./live-ticker.js";

/* 波形几何：viewBox 宽 = 条数，一条占 1 个用户单位（条宽 0.8，间隙 0.2） */
const BAR_COUNT = 80;
const BAR_HEIGHT = 28;
const BAR_WIDTH = 0.8;
const BAR_GAP = 0.2;
const BAR_MIN = 2; // 最小条高（用户单位）：静音段也要看得见
/* 「多久之前」的刷新间隔 */
const RELATIVE_TICK_MS = 30000;
/* 下载文件名里的实例名：只留安全字符，避免实例名里的路径分隔符进 download 属性 */
const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

/* ---------- 纯函数 ---------- */

/**
 * 一路 PCM 采样 → buckets 根柱的峰值（0..1）。
 *
 * 每根柱取它那一段里 |采样| 的最大值（波形要的是包络，不是均值）；桶比采样点还多时，
 * 每个桶仍然至少读到一个采样（不足一桶就重复最近的那个），不会凭空造峰也不会留洞。
 * 越界（解码器给过 1 以上的值）钳到 1。立体声只取声道 0：波形要的是包络，取一路就够，
 * 两路取平均反而会把峰值压低。
 * @param {Float32Array|number[]} data 某一声道的采样
 * @param {number} buckets 桶数
 * @returns {number[]} 长度 = buckets 的 0..1 数组
 */
export function peaksFromChannelData(data, buckets) {
  const n = Math.max(1, Math.trunc(Number(buckets)) || 1);
  const src = data && typeof data.length === "number" ? data : [];
  const len = src.length;
  const out = new Array(n);
  for (let b = 0; b < n; b++) {
    const start = Math.floor((b * len) / n);
    const end = Math.max(start + 1, Math.floor(((b + 1) * len) / n));
    let peak = 0;
    for (let i = start; i < end && i < len; i++) {
      const v = Math.abs(Number(src[i]) || 0);
      if (v > peak) peak = v;
    }
    out[b] = len > 0 ? Math.min(1, peak) : 0;
  }
  return out;
}

/** 秒 → m:ss（不足 1 小时；过小时 h:mm:ss）。非法值一律 0:00。纯函数。 */
export function formatClock(sec) {
  const s = Number(sec);
  const total = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (v) => String(v).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(ss) : m + ":" + pad(ss);
}

/**
 * 「多久之前」：不足 1 分钟 = 刚刚，之后按分钟 / 小时 / 天。走词典（en + zh）。
 * 未来的时间戳按「刚刚」处理，不显示负数。
 * @param {number} at 事件毫秒时间戳
 * @param {number} now 当前毫秒时间戳
 */
export function relativeAgo(at, now) {
  const t0 = Number(at);
  const n = Number(now);
  if (!Number.isFinite(t0) || t0 <= 0 || !Number.isFinite(n) || n <= 0) return "";
  const min = Math.floor(Math.max(0, n - t0) / 60000);
  if (min < 1) return t("take.justNow");
  if (min < 60) return t("take.minutesAgo", { n: I18N.num(min) });
  const hours = Math.floor(min / 60);
  if (hours < 24) return t("take.hoursAgo", { n: I18N.num(hours) });
  return t("take.daysAgo", { n: I18N.num(Math.floor(hours / 24)) });
}

/**
 * 播放进度 → 已播的条数（0..n）。时长未知（0 / NaN）时返回 0，不假装在播放。
 * @param {number} pos 当前秒
 * @param {number} dur 总时长秒
 * @param {number} n 条数
 */
export function progressToBarIndex(pos, dur, n) {
  const bars = Math.max(0, Math.trunc(Number(n)) || 0);
  if (!bars) return 0;
  const d = Number(dur);
  const p = Number(pos);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(p)) return 0;
  const ratio = Math.min(1, Math.max(0, p / d));
  return Math.min(bars, Math.round(ratio * bars));
}

/** 解码失败 / 没有 WebAudio 时的占位：一排等高的矮条。 */
export function flatPeaks() {
  return new Array(BAR_COUNT).fill(0);
}

/** 条的几何：x / y / 宽 / 高。纯函数，单测直接断言这四个属性。 */
export function barBox(index, peak) {
  const h = Math.max(BAR_MIN, Math.min(BAR_HEIGHT, Math.round((Number(peak) || 0) * BAR_HEIGHT)));
  const slot = index * (BAR_WIDTH + BAR_GAP);
  const round2 = (v) => Math.round(v * 100) / 100;
  return { x: round2(slot), y: round2((BAR_HEIGHT - h) / 2), w: BAR_WIDTH, h: round2(h) };
}

/* ---------- 模块状态 ---------- */

/* 唯一的当前录音：{taskId, modelId, instanceId, instanceName, url, text, at} */
let take = null;
/* 已渲染的 <rect>，用于只改 class 不重建整棵 SVG */
let barNodes = [];
/* 已渲染的进度（条数），避免 timeupdate 每拍重写 80 个 class */
let playedBars = -1;
/* 已知总时长（秒）：解码出的 AudioBuffer 先给出，之后由 loadedmetadata 纠正 */
let durationSec = 0;
let relativeTimer = null;
let wired = false;

const root = () => $("last-take");
const player = () => $("tts-player");

/* ---------- 渲染 ---------- */

/** 一整棵波形 SVG（单棵 <svg> + 80 个 <rect>）。几何全部写成 SVG 属性，没有 style 属性。 */
function waveHtml(peaks) {
  const list = Array.isArray(peaks) ? peaks : [];
  let rects = "";
  for (let i = 0; i < BAR_COUNT; i++) {
    const box = barBox(i, list[i] || 0);
    rects += `<rect class="rest" x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="0.5"></rect>`;
  }
  return `<svg class="take-wave-svg" viewBox="0 0 ${BAR_COUNT} ${BAR_HEIGHT}" preserveAspectRatio="none" aria-hidden="true" focusable="false">${rects}</svg>`;
}

function drawWave(peaks) {
  const wave = $("last-take-wave");
  if (!wave) return;
  wave.innerHTML = waveHtml(peaks);
  barNodes = wave.querySelectorAll("rect");
  playedBars = -1;
  paintProgress(0);
}

function paintProgress(count) {
  if (count === playedBars) return;
  playedBars = count;
  for (let i = 0; i < barNodes.length; i++) {
    barNodes[i].classList.toggle("played", i < count);
  }
}

function renderMeta() {
  if (!take) return;
  const name = $("last-take-name");
  if (name) name.textContent = tickerInstanceName(take, []);
  const ago = $("last-take-ago");
  if (ago) ago.textContent = relativeAgo(take.at, Date.now());
}

function renderPlayState() {
  const btn = $("last-take-play");
  if (!btn) return;
  const a = player();
  const playing = !!a && !a.paused && !a.ended;
  const use = btn.querySelector("use");
  if (use) use.setAttribute("href", playing ? "#i-pause" : "#i-play");
  const label = t(playing ? "take.pause" : "take.play");
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

/** 时间标签 + 波形进度 + 滑块的 aria 值。timeupdate / ended / 拖动都走这里。 */
function syncProgress() {
  const a = player();
  const dur = durationSec || (a && Number(a.duration)) || 0;
  const pos = a ? Number(a.currentTime) || 0 : 0;
  paintProgress(progressToBarIndex(pos, dur, BAR_COUNT));
  const cur = $("last-take-cur");
  if (cur) cur.textContent = formatClock(pos);
  const total = $("last-take-dur");
  if (total) total.textContent = formatClock(dur);
  const wave = $("last-take-wave");
  if (wave) {
    wave.setAttribute("aria-valuemax", dur.toFixed(2));
    wave.setAttribute("aria-valuenow", pos.toFixed(2));
    wave.setAttribute("aria-valuetext", formatClock(pos) + " / " + formatClock(dur));
  }
}

/** 语言切换与首帧都调它：把标题 / 相对时间 / 下载 / 按钮文案重画一遍。 */
export function renderLastTake() {
  const box = root();
  if (!box) return;
  if (!take) {
    box.classList.add("hidden");
    stopRelativeTimer();
    return;
  }
  box.classList.remove("hidden");
  const dl = $("last-take-download");
  if (dl) {
    dl.setAttribute("href", take.url);
    dl.setAttribute("download", "tts-" + String(take.instanceName || take.instanceId || take.taskId).replace(SAFE_NAME, "_") + ".wav");
    const label = t("take.download");
    dl.setAttribute("aria-label", label);
    dl.title = label;
  }
  renderMeta();
  renderPlayState();
  syncProgress();
  startRelativeTimer();
}

/* ---------- 相对时间计时器 ---------- */

function startRelativeTimer() {
  if (relativeTimer != null) return;
  relativeTimer = setInterval(renderMeta, RELATIVE_TICK_MS);
}

function stopRelativeTimer() {
  if (relativeTimer == null) return;
  clearInterval(relativeTimer);
  relativeTimer = null;
}

/* ---------- 解码（只为画波形） ---------- */

/**
 * 取一次音频算峰值。只为画波形，走一次 fetch()；播放仍由 #tts-player 自己走同一个 URL。
 * 任何一步失败（网络 / 没有 WebAudio / 解码失败）都返回 null，由调用方画等高矮条。
 */
async function decodePeaks(url) {
  if (typeof fetch !== "function") return null;
  try {
    const res = await fetch(url);
    if (!res || res.ok === false) return null;
    const buf = await res.arrayBuffer();
    const Ctx = typeof window === "undefined" ? null : window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(buf);
      const data = decoded && typeof decoded.getChannelData === "function" ? decoded.getChannelData(0) : null;
      if (!data) return null;
      return { peaks: peaksFromChannelData(data, BAR_COUNT), durationSec: Number(decoded.duration) || 0 };
    } finally {
      try {
        if (typeof ctx.close === "function") await ctx.close();
      } catch (e) {
        /* 关闭失败无所谓：浏览器会回收 */
      }
    }
  } catch (e) {
    return null;
  }
}

/** 新的一条录音：画平条占位，再异步换成真波形。 */
function loadWave(url) {
  drawWave(flatPeaks());
  decodePeaks(url).then((got) => {
    if (!take || take.url !== url) return; // 期间又来了新的 take，丢弃这次解码
    if (!got) {
      syncProgress();
      return;
    }
    if (got.durationSec > 0) durationSec = got.durationSec;
    drawWave(got.peaks);
    syncProgress();
  });
}

/* ---------- 交互 ---------- */

export async function togglePlay() {
  const a = player();
  if (!a || !take) return;
  if (a.paused) {
    try {
      await a.play();
    } catch (e) {
      /* 忽略：自动播放被拒或 src 还没就绪，按钮状态仍按实际 paused 刷新 */
    }
  } else {
    a.pause();
  }
  renderPlayState();
  syncProgress();
}

/** 拖到总时长的 fraction 处（0..1）。超出范围钳到两端。 */
export function seekTake(fraction) {
  const a = player();
  const f = Number(fraction);
  if (!a || !Number.isFinite(f)) return;
  const dur = durationSec || Number(a.duration) || 0;
  if (!(dur > 0)) return;
  a.currentTime = Math.min(dur, Math.max(0, f * dur));
  syncProgress();
}

const SEEK_STEP = 0.05; // 方向键：总时长的 5%

function onWaveClick(ev) {
  const wave = $("last-take-wave");
  if (!wave || !take || typeof wave.getBoundingClientRect !== "function") return;
  const box = wave.getBoundingClientRect();
  if (!box || !(box.width > 0)) return;
  seekTake((ev.clientX - box.left) / box.width);
}

function onWaveKey(ev) {
  const a = player();
  const dur = durationSec || (a && Number(a.duration)) || 0;
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    const pos = a ? Number(a.currentTime) || 0 : 0;
    seekTake((pos + (ev.key === "ArrowRight" ? SEEK_STEP : -SEEK_STEP) * (dur || 1)) / (dur || 1));
    return;
  }
  if (ev.key === "Home") {
    ev.preventDefault();
    seekTake(0);
  } else if (ev.key === "End") {
    ev.preventDefault();
    seekTake(1);
  }
}

/**
 * 再生成一次：走合成按钮自己的 handler，请求体照旧由表单收集，不在这里重建。
 * 表单文本若已被改过，先改回这条 take 的文字（按钮的语义就是「用同一段文本再来一次」）。
 * VibeVoice 的台词存在各说话人行里，这里不回填——表单是什么就提交什么。
 */
export function rerunTake() {
  if (!take) return;
  const box = $("tts-text");
  if (box && take.text && String(box.value || "").trim() !== take.text.trim()) {
    box.value = take.text;
    if (typeof Event === "function" && typeof box.dispatchEvent === "function") {
      box.dispatchEvent(new Event("input"));
    }
  }
  const btn = $("tts-submit");
  if (btn && !btn.disabled) btn.click();
}

/** 只绑一次：三个控件 + <audio> 的四个事件。 */
function wire() {
  if (wired) return;
  wired = true;
  const play = $("last-take-play");
  /* 播放键是原生 <button>：空格 / 回车由浏览器自己派发 click，不另挂 keydown
     （挂了就按一次键触发两次 toggle）。 */
  if (play) play.addEventListener("click", () => { togglePlay(); });
  const wave = $("last-take-wave");
  if (wave) {
    wave.addEventListener("click", onWaveClick);
    wave.addEventListener("keydown", onWaveKey);
  }
  const rerun = $("last-take-rerun");
  if (rerun) rerun.addEventListener("click", () => { rerunTake(); });
  const a = player();
  if (a) {
    a.addEventListener("timeupdate", syncProgress);
    a.addEventListener("seeked", syncProgress);
    a.addEventListener("loadedmetadata", () => {
      const dur = Number(a.duration) || 0;
      if (dur > 0) durationSec = dur;
      syncProgress();
    });
    a.addEventListener("play", () => { renderPlayState(); syncProgress(); });
    a.addEventListener("pause", () => { renderPlayState(); syncProgress(); });
    a.addEventListener("ended", () => { renderPlayState(); syncProgress(); });
  }
}

/* ---------- 入口 ---------- */

/** take 的历史 wav URL：与 tasks.js 填 #tts-player.src 的写法完全一致。 */
export function takeAudioUrl(task) {
  if (!task || !task.id || !task.modelId) return "";
  return "/api/history/" + task.modelId + "/" + task.id + "/audio";
}

function setTake(task) {
  const url = takeAudioUrl(task);
  if (!url) return false;
  const prevId = take ? take.taskId : null;
  take = {
    taskId: task.id,
    modelId: task.modelId,
    instanceId: task.instanceId || "",
    instanceName: task.instanceName || "",
    url,
    text: typeof task.text === "string" ? task.text : "",
    at: Number(task.finishedAt) || Number(task.createdAt) || Date.now()
  };
  if (task.id !== prevId) {
    const a = player();
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    durationSec = 0;
    loadWave(url);
  } else if (!barNodes.length) {
    loadWave(url); // 同一 taskId 重复通知（轮询与 SSE 各来一次）：只补画一次波形
  }
  wire();
  renderLastTake();
  return true;
}

/**
 * tts 任务结束时由 tasks.js 调用（就在它填 #tts-player.src 的那一行旁边）。
 * 非 tts / 未完成的条目一律忽略——条上只放真正落了盘的录音。
 * @param {any} task GET /api/tasks/{id} 的任务对象
 */
export function noteTtsTake(task) {
  if (!task || task.category !== "tts" || task.status !== "DONE") return false;
  return setTake(task);
}

/**
 * 首屏 / 模型切换后的任务清单（GET /api/tasks?modelId=…）里挑最新的那条已完成 tts：
 * 刷新页面也能看到上一条录音。只在还没有 take 时生效（不覆盖本次会话已经显示的那条），
 * 挑不出就保持隐藏，不画任何占位内容。
 * @param {any[]} tasks 任务列表
 */
export function seedLastTake(tasks) {
  if (take || !Array.isArray(tasks)) return false;
  let newest = null;
  for (const task of tasks) {
    if (!task || task.category !== "tts" || task.status !== "DONE") continue;
    const at = Number(task.finishedAt) || Number(task.createdAt) || 0;
    if (!takeAudioUrl(task)) continue;
    if (!newest || at > (Number(newest.finishedAt) || Number(newest.createdAt) || 0)) newest = task;
  }
  if (!newest) return false;
  return setTake(newest);
}

/** 收起条并清状态（换会话 / 测试复位用）。 */
export function resetLastTake() {
  take = null;
  barNodes = [];
  playedBars = -1;
  durationSec = 0;
  stopRelativeTimer();
  const box = root();
  if (box) box.classList.add("hidden");
}
