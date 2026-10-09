/* 实例卡片两拨纯逻辑的格式化：忙碌徽标合并（resolveBusy / formatBusyElapsed）与
   内存条（memRowModel / clampPct / formatMiB / memStatsLabel / memAriaText /
   memRowHtml / memBlockHtml / applyMemBars）。都从真实源码里抽出来在 node:vm 里求值，
   文案经注入的 t() 桩走英文词典原文（中文由 check:i18n 的 parity 保证存在）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { extractFunction, readWeb } from "./helpers/vm.mjs";
import { createDomWorld } from "./helpers/dom-stub.mjs";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/* 英文词典里与这些函数相关的条目（与 web/i18n.en.js 保持一致） */
const DICT = {
  "instance.generating": "Generating…",
  "instance.memKeyRam": "RAM",
  "instance.memKeyVram": "VRAM",
  "instance.memNow": "now",
  "instance.memStatPeak": "Peak",
  "instance.memStatAvg": "Avg",
  "instance.memStatIdle": "Idle",
  "instance.memAriaRam": "RAM {cur} now, peak {peak}, average {avg} {unit}",
  "instance.memAriaRamIdle": "RAM {cur} now, peak {peak}, average {avg}, idle {idle} {unit}",
  "instance.memAriaVram": "VRAM {cur} now, peak {peak}, average {avg} {unit}",
  "instance.memAriaVramIdle": "VRAM {cur} now, peak {peak}, average {avg}, idle {idle} {unit}",
  "instance.memTipVram": "VRAM {cur} · peak {peak} · avg {avg} ({source})",
  "instance.memTipMeta": "{n} samples · {state}",
  "instance.memSource.drm": "DRM fdinfo",
  "instance.memSource.nvidia-smi": "nvidia-smi",
  "instance.memSource.none": "unknown",
  "instance.memBusy": "generating",
  "instance.memIdle": "idle"
};

const NAMES = [
  // 忙碌徽标
  "resolveBusy", "formatBusyElapsed",
  // 内存条：私有小工具 + 纯函数
  "msOr", "memMiB", "numOr", "opt", "num1", "memUnitFormat",
  "formatMiB", "clampPct", "memBarScale", "memRowModel", "memStatsLabel", "memAriaText",
  "formatIdleFor", "idleSinceOf", "instanceSubtitle", "aggregateVram", "formatVramHead",
  "memSeries", "sparkPoints", "pushSparkSample", "nextSparkState", "sparkHtml",
  "memRowHtml", "memBlockHtml", "applyMemBars"
];

function load() {
  const src = readWeb("modules/instances.js");
  const bundle = NAMES.map(n => extractFunction(src, n)).join("\n");
  const t = (key, params) => {
    let s = DICT[key] || key;
    for (const [k, v] of Object.entries(params || {})) s = s.split("{" + k + "}").join(String(v));
    return s;
  };
  const esc = (v) => String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const context = vm.createContext({
    t, esc, MEM_MIB: 1024 * 1024, SPARK_W: 74, SPARK_H: 16, SPARK_CAP: 60
  });
  return new vm.Script(`${bundle}\n({ ${NAMES.join(", ")} })`, {
    filename: "instances-pure.js"
  }).runInContext(context);
}

const {
  resolveBusy, formatBusyElapsed, formatMiB, clampPct, memBarScale,
  memRowModel, memStatsLabel, memAriaText, memSeries, sparkPoints,
  formatIdleFor, idleSinceOf, instanceSubtitle, aggregateVram, formatVramHead,
  pushSparkSample, nextSparkState, memRowHtml, memBlockHtml, applyMemBars
} = load();

/* vm realm 造出来的对象原型与测试 realm 不同。本文件从 node:assert/strict 引入，
   deepEqual 即 deepStrictEqual，原型不等会报
   “Values have same structure but are not reference-equal”。
   JSON 往返摊平回测试 realm（与 api-client.test.mjs 的 plain 同一做法）。 */
const plain = (v) => JSON.parse(JSON.stringify(v));

/* ---------- 忙碌徽标：SSE + 轮询合并 ---------- */

test("resolveBusy：SSE 说在忙就用 SSE，起点取 task.started 的 ts", () => {
  const busy = resolveBusy({ startMs: 1756400000000 }, { taskCount: 0 });
  assert.deepEqual(plain(busy), { busy: true, startMs: 1756400000000, source: "sse" });
  // 事件没带 ts：徽标照常亮，计时省略
  assert.deepEqual(plain(resolveBusy({ startMs: null }, { taskCount: 0 })),
    { busy: true, startMs: null, source: "sse" });
});

test("resolveBusy：没有 SSE 时回退到轮询（taskCount 或采样器 busy）", () => {
  const byCount = resolveBusy(null, { taskCount: 3, runningStartedAt: 1756400001000 });
  assert.deepEqual(plain(byCount), { busy: true, startMs: 1756400001000, source: "poll" });
  const byMemory = resolveBusy(null, { taskCount: 0, memory: { busy: true } });
  assert.deepEqual(plain(byMemory), { busy: true, startMs: null, source: "poll" });
  // 轮询也不知道起点时省略计时（不编一个）
  const noStart = resolveBusy(null, { taskCount: 1, runningStartedAt: "nope" });
  assert.deepEqual(plain(noStart), { busy: true, startMs: null, source: "poll" });
});

test("resolveBusy：不忙时三个字段都干净", () => {
  assert.deepEqual(plain(resolveBusy(null, { taskCount: 0, memory: { busy: false } })),
    { busy: false, startMs: null, source: null });
  assert.deepEqual(plain(resolveBusy(null, null)), { busy: false, startMs: null, source: null });
  // taskCount 不是数字（旧 hub / 异常数据）时不误判成忙碌
  assert.deepEqual(plain(resolveBusy(null, { taskCount: "x" })),
    { busy: false, startMs: null, source: null });
});

test("formatBusyElapsed：60s 内一位小数，之后分秒", () => {
  assert.equal(formatBusyElapsed(3.24), "3.2s");
  assert.equal(formatBusyElapsed(0), "0.0s");
  assert.equal(formatBusyElapsed(59.96), "1m 00s");
  assert.equal(formatBusyElapsed(65), "1m 05s");
  assert.equal(formatBusyElapsed(600.4), "10m 00s");
  assert.equal(formatBusyElapsed(-1), "");
  assert.equal(formatBusyElapsed(Number.NaN), "");
  assert.equal(formatBusyElapsed(undefined), "");
});

/* ---------- 内存条：单位 / 百分比 / 比例尺 ---------- */

test("formatMiB：≥ 1024 MiB 用一位小数 GiB，否则取整 MiB", () => {
  assert.equal(formatMiB(942), "942 MiB");
  assert.equal(formatMiB(1023.6), "1024 MiB");
  assert.equal(formatMiB(1024), "1.0 GiB");
  assert.equal(formatMiB(4.2 * 1024), "4.2 GiB");
  assert.equal(formatMiB(8 * 1024), "8.0 GiB");
  assert.equal(formatMiB(0), "0 MiB");
  assert.equal(formatMiB(-1), "");
  assert.equal(formatMiB(undefined), "");
});

test("clampPct：钳到 0–100 并保留一位小数", () => {
  assert.equal(clampPct(0), 0);
  assert.equal(clampPct(42.35), 42.4);
  assert.equal(clampPct(100), 100);
  assert.equal(clampPct(180), 100);
  assert.equal(clampPct(-5), 0);
  assert.equal(clampPct(Number.NaN), 0);
  assert.equal(clampPct("50"), 0);
});

test("memRowModel：RAM 用 max(峰值, 当前) × 1.25，不设总量", () => {
  const row = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  assert.equal(row.kind, "ram");
  assert.equal(row.cur, 942);
  assert.equal(row.peak, 988);
  assert.equal(row.avg, 700);
  assert.equal(row.total, null);
  assert.equal(row.idle, null);
  // avg is ignored for RAM: head is max(peak, current), then × 1.25
  assert.equal(row.scale, Math.max(988, 942) * 1.25);
  assert.equal(row.fillPct, clampPct((942 / (988 * 1.25)) * 100));
  assert.equal(row.peakPct, clampPct((988 / (988 * 1.25)) * 100));
  assert.equal(row.avgPct, clampPct((700 / (988 * 1.25)) * 100));
  assert.equal(row.hot, false);
  const withTotal = memRowModel("ram", {
    ramBytes: 100 * MIB,
    ramPeakBytes: 100 * MIB,
    ramTotalBytes: 10000 * MIB
  });
  assert.equal(withTotal.scale, 10000);
  assert.equal(withTotal.total, 10000);
});

test("memRowModel：VRAM 已知总量时以总量为比例尺，未知时 × 1.25", () => {
  const withTotal = memRowModel("vram", {
    vramBytes: 4.2 * 1024 * MIB,
    vramPeakBytes: 4.3 * 1024 * MIB,
    vramAvgBytes: 3.7 * 1024 * MIB,
    vramTotalBytes: 8 * GIB
  });
  assert.equal(withTotal.scale, 8192);
  assert.equal(withTotal.total, 8192);
  assert.equal(withTotal.fillPct, clampPct((4.2 * 1024 / 8192) * 100));
  assert.equal(withTotal.hot, false);

  const noTotal = memRowModel("vram", {
    vramBytes: 4 * 1024 * MIB,
    vramPeakBytes: 4.2 * 1024 * MIB
  });
  assert.equal(noTotal.scale, 4.2 * 1024 * 1.25);
  assert.equal(noTotal.total, null);
  // Unknown total uses max(peak, current, avg) × 1.25, not a near-full fill.
  const avgHeads = memRowModel("vram", {
    vramBytes: 4 * 1024 * MIB,
    vramPeakBytes: 4.2 * 1024 * MIB,
    vramAvgBytes: 5 * 1024 * MIB
  });
  assert.equal(avgHeads.scale, 5 * 1024 * 1.25);
  assert.equal(avgHeads.fillPct, clampPct((4 * 1024) / (5 * 1024 * 1.25) * 100));
  assert.ok(avgHeads.fillPct < 80);
  const zeroTotal = memRowModel("vram", {
    vramBytes: 4 * 1024 * MIB,
    vramPeakBytes: 4 * 1024 * MIB,
    vramTotalBytes: 0
  });
  assert.equal(zeroTotal.total, null);
  assert.equal(zeroTotal.scale, 4 * 1024 * 1.25);
  assert.equal(zeroTotal.fillPct, 80);

  // 数据把当前值顶到总量之上（异常读数）时百分比仍钳在 100
  const over = memRowModel("vram", { vramBytes: 9 * GIB, vramTotalBytes: 8 * GIB });
  assert.equal(over.fillPct, 100);
  assert.equal(over.hot, true);
  // ≥ 85% 才用「快满」渐变
  const nearly = memRowModel("vram", { vramBytes: 6.9 * GIB, vramTotalBytes: 8 * GIB });
  assert.equal(nearly.hot, true);
  const roomy = memRowModel("vram", { vramBytes: 5 * GIB, vramTotalBytes: 8 * GIB });
  assert.equal(roomy.hot, false);
});

test("memRowModel：缺失字段（没有 memory / 没有 VRAM / 没有峰值均值）", () => {
  assert.equal(memRowModel("ram", null), null);
  assert.equal(memRowModel("vram", null), null);
  assert.equal(memRowModel("ram", {}), null);
  // VRAM 从未读到：那一行直接不画
  assert.equal(memRowModel("vram", { ramBytes: 100 * MIB }), null);
  // 只有当前值：峰值 / 均值退回当前值，空闲仍是未知
  const bare = memRowModel("ram", { ramBytes: 100 * MIB });
  assert.equal(bare.peak, 100);
  assert.equal(bare.avg, 100);
  assert.equal(bare.idle, null);
  assert.equal(bare.scale, 125);
  // 空闲基线来自后端新增字段，缺失即省略
  const idle = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramIdleBytes: 598 * MIB
  });
  assert.equal(idle.idle, 598);
});

test("memRowModel：全 0 的比例尺退到 1 MiB（不除零）", () => {
  const row = memRowModel("ram", { ramBytes: 0 });
  assert.equal(row.scale, 1);
  assert.equal(row.fillPct, 0);
});

/* ---------- 内存条：文案 ---------- */

test("memStatsLabel：整行一个单位，行尾出现一次；Idle 未知则省略", () => {
  const mib = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    ramIdleBytes: 598 * MIB
  });
  assert.equal(memStatsLabel(mib), "Peak 988 · Avg 700 · Idle 598 MiB");
  const noIdle = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  assert.equal(memStatsLabel(noIdle), "Peak 988 · Avg 700 MiB");
  // 行内最大值 ≥ 1024 MiB：整行换算成 GiB
  const gib = memRowModel("vram", {
    vramBytes: 4.1 * GIB,
    vramPeakBytes: 4.2 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramIdleBytes: 3.6 * GIB
  });
  assert.equal(memStatsLabel(gib), "Peak 4.2 · Avg 3.7 · Idle 3.6 GiB");
});

test("memAriaText：无障碍名称 / 值文本（有无 idle 两个句式）", () => {
  const ram = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  assert.equal(memAriaText(ram), "RAM 942 MiB now, peak 988, average 700 MiB");
  const ramIdle = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    ramIdleBytes: 598 * MIB
  });
  assert.equal(memAriaText(ramIdle), "RAM 942 MiB now, peak 988, average 700, idle 598 MiB");
  const vram = memRowModel("vram", {
    vramBytes: 4.1 * GIB,
    vramPeakBytes: 4.2 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramIdleBytes: 3.6 * GIB,
    vramTotalBytes: 8 * GIB
  });
  assert.equal(memAriaText(vram), "VRAM 4.1 GiB now, peak 4.2, average 3.7, idle 3.6 GiB");
});

/* ---------- 内存条：HTML 形状 ---------- */

test("memRowHtml：role=meter + 填充 / 刻度线（刻度线 aria-hidden）", () => {
  const row = memRowModel("ram", {
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB
  });
  const html = memRowHtml(row);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="1235"/);
  assert.match(html, /aria-valuenow="942"/);
  assert.match(html, /aria-label="RAM 942 MiB now, peak 988, average 700 MiB"/);
  assert.match(html, /class="fill ram"/);
  assert.doesNotMatch(html, /style=/);
  assert.match(html, /data-w="76\.3"/);
  assert.match(html, /data-l="80"/);
  assert.match(html, /data-l="56\.7"/);
  assert.match(html, /class="pk"[^>]*aria-hidden="true"/);
  assert.match(html, /class="avg"[^>]*aria-hidden="true"/);
  assert.match(html, /<span class="k">RAM<\/span>/);
  assert.match(html, /<span class="of">now<\/span>/);
  // 没有 GPU 总量就不出现「/ total」
  assert.doesNotMatch(html, /class="of num"/);
});

test("memBlockHtml：只有 RAM / 隐藏条件 / VRAM 总量与 hot 渐变 / 图例一次", () => {
  assert.equal(memBlockHtml(null), "");
  assert.equal(memBlockHtml({}), "");

  const ramOnly = memBlockHtml({
    ramBytes: 600 * MIB,
    ramPeakBytes: GIB,
    ramAvgBytes: 700 * MIB,
    samples: 4
  });
  assert.match(ramOnly, /role="meter"/);
  assert.doesNotMatch(ramOnly, /class="fill vram"/);
  // 图例每张卡片只出现一次
  assert.equal(ramOnly.match(/mem-legend/g).length, 1);
  // title 里保留采样次数明细
  assert.match(ramOnly, /title="[^"]*4 samples/);

  const vram = memBlockHtml({
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    vramBytes: 4.2 * GIB,
    vramPeakBytes: 4.3 * GIB,
    vramAvgBytes: 3.7 * GIB,
    vramIdleBytes: 3.6 * GIB,
    vramTotalBytes: 8 * GIB,
    vramSource: "nvidia-smi",
    samples: 12,
    busy: true
  });
  assert.match(vram, /class="fill vram"/);
  // VRAM 总量：标签行「/ 8.0 GiB」+ meter 的 valuemax
  assert.match(vram, /\/ 8\.0 GiB/);
  assert.match(vram, /aria-valuemax="8192"/);
  // 4.1 GiB / 8 GiB = 51%：未到 85%，不用 hot 渐变
  assert.doesNotMatch(vram, /fill hot/);
  assert.match(vram, /title="[^"]*nvidia-smi/);
  assert.match(vram, /12 samples · generating/);
  // Idle 在统计行；VRAM 总量在标签行。生成的 markup 不写 style=
  assert.match(vram, /Idle 3\.6/);
  assert.doesNotMatch(vram, /style=/);
  assert.equal(vram.match(/mem-legend/g).length, 1);
  assert.equal(vram.match(/role="meter"/g).length, 2);

  const hot = memBlockHtml({ ramBytes: MIB, vramBytes: 7.5 * GIB, vramTotalBytes: 8 * GIB });
  assert.match(hot, /class="fill vram hot"/);
  assert.match(hot, /data-w="93\.8"/);
  assert.doesNotMatch(hot, /style=/);

  // 9 GiB / 8 GiB 会超出比例尺，填充与刻度都钳到 100，且仍不写 style=
  const clamped = memBlockHtml({
    ramBytes: 942 * MIB,
    ramPeakBytes: 988 * MIB,
    ramAvgBytes: 700 * MIB,
    vramBytes: 9 * GIB,
    vramPeakBytes: 9 * GIB,
    vramAvgBytes: 9 * GIB,
    vramTotalBytes: 8 * GIB
  });
  assert.doesNotMatch(clamped, /style=/);
  assert.match(clamped, /data-w="76\.3"/);
  assert.match(clamped, /data-l="80"/);
  assert.match(clamped, /data-l="56\.7"/);
  assert.match(clamped, /class="fill vram hot" data-w="100"/);
  assert.match(clamped, /data-l="100"/);
});

test("applyMemBars：把 data-w / data-l 写成 CSSOM 的 width / left", () => {
  const world = createDomWorld();
  const root = world.el(
    '<div class="mem"><div class="fill ram" data-w="61.3"></div><div class="pk" data-l="64.3"></div><div class="avg" data-l="0"></div><i class="pk"></i></div>'
  );
  applyMemBars(root);
  assert.equal(root.querySelector("[data-w]").style.width, "61.3%");
  const ticks = root.querySelectorAll("[data-l]");
  assert.equal(ticks[0].style.left, "64.3%");
  assert.equal(ticks[1].style.left, "0%");
  assert.equal(root.querySelector("i").style.left, undefined);
  applyMemBars(null);
});

/* ---------- 迷你折线 ---------- */

test("sparkPoints：少于两个点不画；平坦序列在中线；高低按 min..max 留边", () => {
  assert.equal(sparkPoints([]), "");
  assert.equal(sparkPoints([10]), "");
  assert.equal(sparkPoints([1, NaN]), "");
  assert.deepEqual(memSeries([1, -1, Infinity, 2, "3"]), [1, 2]);

  const flat = sparkPoints([5, 5, 5], 74, 16);
  assert.equal(flat, "0,8 37,8 74,8");

  const rising = sparkPoints([0, 100], 74, 16).split(" ");
  assert.equal(rising.length, 2);
  const y0 = Number(rising[0].split(",")[1]);
  const y1 = Number(rising[1].split(",")[1]);
  // 值越大越靠上（y 越小），并且不贴 viewBox 的顶和底
  assert.ok(y1 < y0, `${y1} < ${y0}`);
  assert.ok(y0 < 15 && y0 > 1);
  assert.ok(y1 > 1 && y1 < 15);
});

test("pushSparkSample / nextSparkState：上限 60，同一拍不重复，缺 VRAM 不当 0", () => {
  let series = [];
  for (let i = 0; i < 70; i++) series = pushSparkSample(series, i);
  assert.equal(series.length, 60);
  assert.equal(series[0], 10);
  assert.equal(series[59], 69);
  assert.deepEqual(pushSparkSample([1], -5), [1]);
  assert.deepEqual(pushSparkSample([1], Number.NaN), [1]);

  const first = nextSparkState(null, { sampledAt: 1000, ramBytes: 10, vramBytes: 20 });
  assert.deepEqual(plain(first), { at: 1000, ram: [10], vram: [20] });
  // 同一 sampledAt（SSE 触发的重画）不追加
  assert.equal(nextSparkState(first, { sampledAt: 1000, ramBytes: 99, vramBytes: 99 }), first);
  const second = nextSparkState(first, { sampledAt: 2000, ramBytes: 11 });
  assert.deepEqual(plain(second.ram), [10, 11]);
  assert.deepEqual(plain(second.vram), [20]);
});

test("memBlockHtml：折线是 SVG 属性，不写 style=", () => {
  const html = memBlockHtml({
    ramBytes: 100 * MIB,
    ramPeakBytes: 120 * MIB,
    ramAvgBytes: 80 * MIB,
    ramSeries: [100, 110, 90],
    vramBytes: 200 * MIB,
    vramPeakBytes: 200 * MIB,
    vramAvgBytes: 200 * MIB,
    vramSeries: [200, 200, 200]
  });
  assert.match(html, /class="spark ram"/);
  assert.match(html, /class="spark vram"/);
  assert.match(html, /viewBox="0 0 74 16"/);
  assert.match(html, /width="74"/);
  assert.match(html, /height="16"/);
  assert.match(html, /stroke-width="1\.5"/);
  assert.match(html, /stroke-linejoin="round"/);
  assert.match(html, /stroke-linecap="round"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /<polyline points="[^"]+" fill="none"/);
  assert.doesNotMatch(html, /style=/);
  // 不足两个点：不放空 svg
  const one = memBlockHtml({ ramBytes: MIB, ramSeries: [1] });
  assert.doesNotMatch(one, /<svg/);
  assert.doesNotMatch(one, /style=/);
});

test("memBarScale：总量优先，未知时留 1.25 倍余量", () => {
  assert.equal(memBarScale("vram", 4, 4.2, 5, 8), 8);
  assert.equal(memBarScale("vram", 4, 4.2, 5, 0), 5 * 1.25);
  assert.equal(memBarScale("vram", 4, 4.2, 5, null), 5 * 1.25);
  assert.equal(memBarScale("ram", 100, 80, 500, null), 100 * 1.25);
  assert.equal(memBarScale("ram", 100, 80, 500, 10000), 10000);
  assert.equal(memBarScale("ram", 0, 0, 0, 0), 1);
});

test("formatIdleFor / idleSinceOf", () => {
  const now = 1_700_000_000_000;
  assert.equal(formatIdleFor(now - 12_000, now), "12s");
  assert.equal(formatIdleFor(now - 4 * 60_000, now), "4m");
  assert.equal(formatIdleFor(now - 3 * 3600_000, now), "3h");
  assert.equal(formatIdleFor(now - 50 * 3600_000, now), "2d");
  assert.equal(formatIdleFor(0, now), "");
  assert.equal(idleSinceOf({ idleSinceMs: 50 }, 40), 50);
  assert.equal(idleSinceOf({}, 40), 40);
  assert.equal(idleSinceOf(null, 0), null);
});

test("instanceSubtitle：有 GPU 名就插在型号和设备之间", () => {
  assert.equal(
    instanceSubtitle({ memory: { gpuName: "GTX 1080" }, backend: "vulkan", device: 0, port: 18090 }, "BreezeTTS 2"),
    "BreezeTTS 2 · GTX 1080 · vulkan:0 · :18090"
  );
  assert.equal(
    instanceSubtitle({ backend: "cpu", device: 0, port: 7001 }, "voice"),
    "voice · cpu:0 · :7001"
  );
});

test("aggregateVram：同卡去重，没有总量就省略斜杠，没有显存就省略", () => {
  const GIB = 1024 * MIB;
  const same = aggregateVram([
    { memory: { vramBytes: GIB, vramTotalBytes: 8 * GIB, gpuName: "GTX 1080" } },
    { memory: { vramBytes: 2 * GIB, vramTotalBytes: 8 * GIB, gpuName: "GTX 1080" } }
  ]);
  assert.equal(same.usedBytes, 3 * GIB);
  assert.equal(same.totalBytes, 8 * GIB);
  assert.equal(formatVramHead(same), "3.0 / 8.0 GiB");
  const two = aggregateVram([
    { memory: { vramBytes: GIB, vramTotalBytes: 8 * GIB, gpuName: "A" } },
    { memory: { vramBytes: GIB, vramTotalBytes: 16 * GIB, gpuName: "B" } }
  ]);
  assert.equal(two.totalBytes, 24 * GIB);
  const noTotal = aggregateVram([{ memory: { vramBytes: 512 * MIB } }]);
  assert.equal(noTotal.totalBytes, null);
  assert.equal(formatVramHead(noTotal), "512 MiB");
  assert.doesNotMatch(formatVramHead(noTotal), /\//);
  assert.equal(aggregateVram([{ memory: { ramBytes: MIB } }]), null);
  assert.equal(formatVramHead(null), "");
  const zero = aggregateVram([{ memory: { vramBytes: 0 } }]);
  assert.equal(zero.usedBytes, 0);
  assert.equal(formatVramHead(zero), "0 MiB");
});
