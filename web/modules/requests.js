/* web/modules/requests.js — request log & latency panel (#/requests, issue #198)
 *
 * Answers "was that stutter the hub, the network, or the client?" for /v1 traffic.
 * Data comes from the in-memory request log in reqmetrics.go:
 *   GET /api/metrics/summary          per-instance state + rolling p50/p90
 *   GET /api/metrics/recent?limit=N   newest-first request metadata (no text/audio)
 *   GET /api/metrics/requests/{id}    one request with its chunk timeline
 * While the panel is open it polls every POLL_MS; polling stops on close, when the
 * tab is hidden, or when the user pauses it. Nothing here is persisted. */

import { $, el, t as globalT, Api } from "./dom.js";
import { showSkeleton, renderStateError, focusDialog, restoreDialogFocus } from "./async-ui.js";

/* Panel-only strings live here (same pattern as activity-queue.js) so they cost
   nothing on first load; only obs.title / obs.pause, used by index.html, are in
   the global dictionaries. */
const OBS_LOCALES = {
  en: {
    "live": "Live · every {s}s",
    "paused": "Paused",
    "resume": "Resume",
    "noInstances": "No running instances.",
    "empty": "No /v1 requests recorded since the hub started.",
    "hubLine": "Hub started {started} · up {uptime} · log is in memory only (last 100 per instance, no text or audio)",
    "state.loaded": "Loaded",
    "state.cold": "Cold",
    "state.loading": "Loading",
    "state.starting": "Starting",
    "state.gone": "Gone",
    "state.unknown": "Unknown",
    "stateSource": "Source: {src}",
    "lastUse": "Last use",
    "ago": "{d} ago",
    "unloadIn": "Idle unload in",
    "never": "Never",
    "unloaded": "Unloaded",
    "busy": "Busy",
    "vram": "VRAM",
    "ram": "RAM",
    "device": "Device",
    "inFlight": "In flight",
    "queue": "queue",
    "lastLoad": "Last cold load",
    "started": "Instance started",
    "window": "{n} req · {err} err · {cold} cold · first audio p50 {fa50} / p90 {fa90} · total p50 {tt50} / p90 {tt90}",
    "windowEmpty": "No requests",
    "filter": "Instance",
    "all": "All instances",
    "unrouted": "Unrouted (errors)",
    "running": "running",
    "chars": "{n} chars",
    "inAudio": "in {s}s",
    "queueWait": "queue {v}",
    "firstAudio": "first audio {v}",
    "ttfb": "TTFB {v}",
    "total": "total {v}",
    "outAudio": "out {s}s",
    "chunked": "sentence-chunked",
    "streamed": "streamed",
    "cold": "cold load",
    "nearRestart": "near restart ({why})",
    "gaps": "{n} gaps >100ms (max {max})",
    "underrun": "underrun {v}",
    "aborted": "client aborted",
    "noTimeline": "No chunk timeline (not a streamed reply).",
    "timelineTitle": "Chunk timeline — {n} writes",
    "timelineAria": "{n} audio writes, {gaps} gaps over 100 ms",
    "chunkTip": "at {at} · gap {gap} · {bytes} · headroom {head}",
    "timelineLegend": "{gaps} gaps >100 ms · max gap {max} · min headroom {head} (negative = client starved)",
    "segmentsTitle": "Sentence segments — {n}",
    "segment": "#{i}: {chars} chars · engine {v} · {status}"
  },
  zh: {
    "live": "实时 · 每 {s} 秒",
    "paused": "已暂停",
    "resume": "继续",
    "noInstances": "没有运行中的实例。",
    "empty": "Hub 启动以来尚无 /v1 请求记录。",
    "hubLine": "Hub 启动于 {started} · 已运行 {uptime} · 日志仅在内存（每实例最近 100 条，不含文本或音频）",
    "state.loaded": "已加载",
    "state.cold": "冷（未加载）",
    "state.loading": "加载中",
    "state.starting": "启动中",
    "state.gone": "已退出",
    "state.unknown": "未知",
    "stateSource": "来源：{src}",
    "lastUse": "上次使用",
    "ago": "{d} 前",
    "unloadIn": "空闲卸载倒计时",
    "never": "从不",
    "unloaded": "已卸载",
    "busy": "忙碌",
    "vram": "显存",
    "ram": "内存",
    "device": "设备",
    "inFlight": "进行中",
    "queue": "排队",
    "lastLoad": "上次冷加载",
    "started": "实例启动",
    "window": "{n} 次 · {err} 错误 · {cold} 冷加载 · 首段音频 p50 {fa50} / p90 {fa90} · 总耗时 p50 {tt50} / p90 {tt90}",
    "windowEmpty": "无请求",
    "filter": "实例",
    "all": "全部实例",
    "unrouted": "未路由（错误）",
    "running": "进行中",
    "chars": "{n} 字",
    "inAudio": "输入 {s} 秒",
    "queueWait": "排队 {v}",
    "firstAudio": "首段音频 {v}",
    "ttfb": "首字节 {v}",
    "total": "总计 {v}",
    "outAudio": "输出 {s} 秒",
    "chunked": "分句流式",
    "streamed": "流式",
    "cold": "冷加载",
    "nearRestart": "临近重启（{why}）",
    "gaps": "{n} 处间隔 >100ms（最大 {max}）",
    "underrun": "欠载 {v}",
    "aborted": "客户端中断",
    "noTimeline": "无分块时间线（非流式响应）。",
    "timelineTitle": "分块时间线 — {n} 次写出",
    "timelineAria": "{n} 次音频写出，{gaps} 处超过 100 毫秒的间隔",
    "chunkTip": "时刻 {at} · 间隔 {gap} · {bytes} · 余量 {head}",
    "timelineLegend": "{gaps} 处间隔 >100 毫秒 · 最大间隔 {max} · 最小余量 {head}（负数 = 客户端断粮）",
    "segmentsTitle": "分句片段 — {n}",
    "segment": "#{i}：{chars} 字 · 引擎 {v} · {status}"
  }
};

function t(key, params) {
  const short = key.startsWith("obs.") ? key.slice(4) : null;
  const dict = OBS_LOCALES[I18N.lang()] || OBS_LOCALES.en;
  const val = short != null ? (dict[short] ?? OBS_LOCALES.en[short]) : undefined;
  if (val === undefined) return globalT(key, params);
  return params ? val.replace(/\{(\w+)\}/g, (m, n) => (params[n] !== undefined ? String(params[n]) : m)) : val;
}

const POLL_MS = 2000;
const RECENT_LIMIT = 50;

let timer = null;
let paused = false;
let loading = false;
let loadedOnce = false;
let filter = ""; // instance name filter ("" = all)
let expanded = null; // request id whose chunk timeline is open
const detailCache = new Map(); // id -> full record (finished requests never change)

/* ---------- open / close ---------- */
export function openRequestsPanel() {
  if (!$("requests-css")) {
    const link = document.createElement("link");
    link.id = "requests-css";
    link.rel = "stylesheet";
    link.href = "/requests.css";
    document.head.append(link);
  }
  const panel = $("requests-panel");
  const wasHidden = panel.classList.contains("hidden");
  panel.classList.remove("hidden");
  if (wasHidden) focusDialog(panel);
  loadRequests();
  schedule();
}

export function closeRequestsPanel() {
  stopPolling();
  $("requests-panel").classList.add("hidden");
  restoreDialogFocus();
  if (window.hubPanelClosed) window.hubPanelClosed("requests");
}

function isVisible() {
  return !$("requests-panel").classList.contains("hidden") && document.visibilityState !== "hidden";
}

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule() {
  stopPolling();
  if (paused || !isVisible()) return;
  timer = setTimeout(async () => {
    timer = null;
    await loadRequests();
    schedule();
  }, POLL_MS);
}

export async function loadRequests() {
  if (loading) return;
  loading = true;
  const body = $("requests-body");
  if (!loadedOnce) showSkeleton(body, 3);
  try {
    const q = new URLSearchParams({ limit: String(RECENT_LIMIT) });
    if (filter) q.set("instance", filter);
    const [summary, recent] = await Promise.all([
      Api.get("/api/metrics/summary"),
      Api.get("/api/metrics/recent?" + q.toString())
    ]);
    let detail = null;
    if (expanded) detail = await loadDetail(expanded, recent);
    loadedOnce = true;
    render(summary, recent, detail);
  } catch (e) {
    loadedOnce = false;
    renderStateError(body, e, () => loadRequests());
  } finally {
    loading = false;
  }
}

async function loadDetail(id, recent) {
  const row = (recent.requests || []).find(r => r.id === id);
  const done = row && !row.inFlight;
  if (done && detailCache.has(id)) return detailCache.get(id);
  try {
    const full = await Api.get("/api/metrics/requests/" + encodeURIComponent(id));
    if (done) detailCache.set(id, full);
    return full;
  } catch {
    return null; // rotated out of the ring
  }
}

/* ---------- rendering ---------- */
function render(summary, recent, detail) {
  const body = $("requests-body");
  const scrollTop = body.scrollTop;
  body.innerHTML = "";
  body.appendChild(renderHubLine(summary));
  const insts = Array.isArray(summary.instances) ? summary.instances : [];
  if (insts.length) {
    const grid = el(`<div class="obs-instances"></div>`);
    for (const s of insts) grid.appendChild(renderInstance(s));
    body.appendChild(grid);
  } else {
    body.appendChild(hint(t("obs.noInstances")));
  }
  body.appendChild(renderFilter(insts));
  const rows = Array.isArray(recent.requests) ? recent.requests : [];
  if (!rows.length) {
    body.appendChild(hint(t("obs.empty")));
  } else {
    const list = el(`<ol class="obs-requests" aria-live="off"></ol>`);
    for (const r of rows) list.appendChild(renderRequest(r, r.id === expanded ? detail : null));
    body.appendChild(list);
  }
  body.scrollTop = scrollTop;
  syncLiveLabel();
}

function syncLiveLabel() {
  const live = $("requests-live");
  live.textContent = paused ? t("obs.paused") : t("obs.live", { s: POLL_MS / 1000 });
  live.classList.toggle("paused", paused);
  $("requests-pause").textContent = paused ? t("obs.resume") : t("obs.pause");
  $("requests-pause").setAttribute("aria-pressed", paused ? "true" : "false");
}

function hint(text) {
  const p = el(`<p class="hint obs-hint"></p>`);
  p.textContent = text;
  return p;
}

function renderHubLine(s) {
  const line = el(`<div class="obs-hub hint"></div>`);
  line.textContent = t("obs.hubLine", {
    started: s.hubStartedAt ? I18N.date(s.hubStartedAt) : "—",
    uptime: formatDur(s.hubUptimeMs)
  });
  return line;
}

const STATE_CLASS = { loaded: "ok", cold: "idle", loading: "warn", starting: "warn", gone: "err", unknown: "idle" };

function renderInstance(s) {
  const card = el(`<div class="obs-instance card"></div>`);
  const head = el(`<div class="obs-instance-head"><div class="obs-instance-title"></div><span class="obs-state"></span></div>`);
  head.querySelector(".obs-instance-title").textContent = s.instance + (s.modelFamily ? " · " + s.modelFamily : "");
  head.querySelector(".obs-instance-title").title = s.modelId || "";
  const badge = head.querySelector(".obs-state");
  badge.textContent = t("obs.state." + (s.state || "unknown"));
  badge.classList.add(STATE_CLASS[s.state] || "idle");
  if (s.stateSource) badge.title = t("obs.stateSource", { src: s.stateSource });
  card.appendChild(head);

  const mem = s.memory || {};
  const cells = [
    [t("obs.lastUse"), s.sinceLastUseMs != null ? t("obs.ago", { d: formatDur(s.sinceLastUseMs) }) : "—"],
    [t("obs.unloadIn"), unloadText(s)],
    [t("obs.vram"), mem.vramBytes != null ? I18N.bytes(mem.vramBytes) : "—"],
    [t("obs.ram"), mem.ramBytes != null ? I18N.bytes(mem.ramBytes) : "—"],
    [t("obs.device"), s.device || s.backend || "—"],
    [t("obs.inFlight"), `${s.inFlight || 0} / ${t("obs.queue")} ${s.queueDepth || 0}`],
    [t("obs.lastLoad"), s.lastColdLoadAt ? I18N.date(s.lastColdLoadAt) : "—"],
    [t("obs.started"), s.startedAt ? I18N.date(s.startedAt) : "—"]
  ];
  card.appendChild(grid(cells));

  const wins = s.windows || {};
  const table = el(`<div class="obs-windows"></div>`);
  for (const key of ["15m", "1h"]) {
    const w = wins[key] || {};
    const row = el(`<div class="obs-window"><span class="obs-window-key"></span><span class="obs-window-val"></span></div>`);
    row.querySelector(".obs-window-key").textContent = key;
    row.querySelector(".obs-window-val").textContent = w.count
      ? t("obs.window", {
          n: I18N.num(w.count),
          err: I18N.num(w.errors || 0),
          cold: I18N.num(w.coldLoads || 0),
          fa50: ms(w.firstAudioP50Ms),
          fa90: ms(w.firstAudioP90Ms),
          tt50: ms(w.totalP50Ms),
          tt90: ms(w.totalP90Ms)
        })
      : t("obs.windowEmpty");
    table.appendChild(row);
  }
  card.appendChild(table);
  return card;
}

function unloadText(s) {
  if (s.idleUnloadMs == null || s.idleUnloadMs <= 0) return t("obs.never");
  if (s.state === "cold") return t("obs.unloaded");
  if (s.inFlight > 0) return t("obs.busy");
  return s.unloadInMs != null ? formatDur(s.unloadInMs) : "—";
}

function grid(cells) {
  const g = el(`<div class="stats-grid obs-grid"></div>`);
  for (const [label, value] of cells) {
    const c = el(`<div class="stats-cell"><span class="stats-cell-label"></span><span class="stats-cell-value"></span></div>`);
    c.querySelector(".stats-cell-label").textContent = label;
    c.querySelector(".stats-cell-value").textContent = value;
    g.appendChild(c);
  }
  return g;
}

function renderFilter(insts) {
  const bar = el(`<div class="obs-filter"><label class="hint" for="requests-filter"></label><select id="requests-filter"></select></div>`);
  bar.querySelector("label").textContent = t("obs.filter");
  const sel = bar.querySelector("select");
  const names = ["", ...insts.map(i => i.instance), "_unrouted"];
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n === "" ? t("obs.all") : n === "_unrouted" ? t("obs.unrouted") : n;
    if (n === filter) o.selected = true;
    sel.appendChild(o);
  }
  sel.onchange = () => {
    filter = sel.value;
    expanded = null;
    loadRequests();
  };
  return bar;
}

function renderRequest(r, detail) {
  const li = el(`<li class="obs-req"></li>`);
  const failed = r.status >= 400 || r.error;
  li.classList.toggle("err", !!failed);
  li.classList.toggle("live", !!r.inFlight);

  const btn = el(`<button type="button" class="obs-req-head"></button>`);
  btn.setAttribute("aria-expanded", detail ? "true" : "false");
  const top = el(`<span class="obs-req-top"><span class="obs-req-time"></span><span class="obs-req-who"></span><span class="obs-req-status"></span></span>`);
  top.querySelector(".obs-req-time").textContent = new Date(r.time).toLocaleTimeString();
  top.querySelector(".obs-req-who").textContent =
    `${r.instance} · ${r.task || r.route}` + (r.client ? ` · ${r.client}` : "") + (r.callerIp ? ` · ${r.callerIp}` : "");
  top.querySelector(".obs-req-status").textContent = r.inFlight ? t("obs.running") : String(r.status || "—");
  btn.appendChild(top);

  const chips = el(`<span class="obs-chips"></span>`);
  const add = (text, cls) => {
    const c = el(`<span class="obs-chip"></span>`);
    c.textContent = text;
    if (cls) c.classList.add(cls);
    chips.appendChild(c);
  };
  if (r.inputChars != null) add(t("obs.chars", { n: I18N.num(r.inputChars) }));
  if (r.inputAudioSec != null) add(t("obs.inAudio", { s: r.inputAudioSec.toFixed(1) }));
  if (r.queueWaitMs) add(t("obs.queueWait", { v: ms(r.queueWaitMs) }), r.queueWaitMs > 1000 ? "warn" : "");
  if (r.firstAudioMs != null) add(t("obs.firstAudio", { v: ms(r.firstAudioMs) }));
  else if (r.ttfbMs != null) add(t("obs.ttfb", { v: ms(r.ttfbMs) }));
  add(t("obs.total", { v: ms(r.totalMs != null ? r.totalMs : r.elapsedMs) }));
  if (r.outputAudioSec != null) add(t("obs.outAudio", { s: r.outputAudioSec.toFixed(1) }));
  if (r.rtf != null) add("RTF " + r.rtf.toFixed(2), r.rtf > 1 ? "warn" : "");
  if (r.streamed) add(r.streamMode === "sentence-chunked" ? t("obs.chunked") : t("obs.streamed"));
  if (r.coldLoad) add(t("obs.cold"), "warn");
  if (r.nearRestart) add(t("obs.nearRestart", { why: r.restartReason || "" }), "warn");
  if (r.gapsOver100ms) add(t("obs.gaps", { n: r.gapsOver100ms, max: ms(r.maxGapMs) }), "warn");
  if (r.underrun) add(t("obs.underrun", { v: ms(-r.minHeadroomMs) }), "err");
  if (r.clientAborted) add(t("obs.aborted"), "warn");
  btn.appendChild(chips);
  if (r.error) {
    const e = el(`<span class="obs-req-error"></span>`);
    e.textContent = r.error;
    btn.appendChild(e);
  }
  btn.onclick = () => {
    expanded = expanded === r.id ? null : r.id;
    loadRequests();
  };
  li.appendChild(btn);
  if (detail) li.appendChild(renderTimeline(detail));
  return li;
}

/* Chunk timeline: one bar per write burst, height = gap before it (red when >100 ms),
   plus a headroom line telling whether the client could have played gap-free. */
function renderTimeline(d) {
  const wrap = el(`<div class="obs-timeline"></div>`);
  const chunks = Array.isArray(d.chunks) ? d.chunks : [];
  const segs = Array.isArray(d.segments) ? d.segments : [];
  if (!chunks.length && !segs.length) {
    wrap.appendChild(hint(t("obs.noTimeline")));
    return wrap;
  }
  if (chunks.length) {
    const label = el(`<div class="detail-label"></div>`);
    label.textContent = t("obs.timelineTitle", { n: chunks.length });
    wrap.appendChild(label);
    const total = Math.max(1, d.totalMs || chunks[chunks.length - 1].atMs);
    const track = el(`<div class="obs-track" role="img"></div>`);
    track.setAttribute("aria-label", t("obs.timelineAria", { n: chunks.length, gaps: d.gapsOver100ms || 0 }));
    for (const c of chunks) {
      const m = el(`<span class="obs-mark"></span>`);
      m.style.left = Math.min(100, (c.atMs / total) * 100) + "%";
      m.classList.toggle("slow", !!c.slow);
      m.classList.toggle("under", c.headroomMs != null && c.headroomMs < 0);
      m.title = t("obs.chunkTip", { at: ms(c.atMs), gap: ms(c.gapMs), bytes: I18N.bytes(c.bytes), head: c.headroomMs != null ? ms(c.headroomMs) : "—" });
      track.appendChild(m);
    }
    wrap.appendChild(track);
    const legend = el(`<div class="hint obs-legend"></div>`);
    legend.textContent = t("obs.timelineLegend", { gaps: d.gapsOver100ms || 0, max: ms(d.maxGapMs), head: d.minHeadroomMs != null ? ms(d.minHeadroomMs) : "—" });
    wrap.appendChild(legend);
  }
  if (segs.length) {
    const label = el(`<div class="detail-label"></div>`);
    label.textContent = t("obs.segmentsTitle", { n: segs.length });
    wrap.appendChild(label);
    const ol = el(`<ol class="obs-segments"></ol>`);
    for (const s of segs) {
      const li = el(`<li></li>`);
      li.textContent = t("obs.segment", { i: s.index + 1, chars: s.chars, v: ms(s.engineMs), status: s.status || "—" }) + (s.error ? " — " + s.error : "");
      ol.appendChild(li);
    }
    wrap.appendChild(ol);
  }
  return wrap;
}

function ms(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return Math.abs(n) >= 1000 ? (n / 1000).toFixed(2) + "s" : Math.round(n) + "ms";
}

function formatDur(msv) {
  const s = Math.max(0, Math.round((Number(msv) || 0) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

/* ---------- event wiring (DOM ready when the module evaluates) ---------- */
$("requests-close").onclick = () => closeRequestsPanel();
$("requests-refresh").onclick = () => loadRequests();
$("requests-pause").onclick = () => {
  paused = !paused;
  syncLiveLabel();
  if (paused) stopPolling();
  else {
    loadRequests();
    schedule();
  }
};
$("requests-panel").addEventListener("mousedown", (e) => {
  if (e.target === e.currentTarget) closeRequestsPanel();
});
document.addEventListener("visibilitychange", () => {
  if (isVisible()) {
    loadRequests();
    schedule();
  } else stopPolling();
});
