/* #74 性能预算：对首屏关键资源做 raw + gzip 体积与请求数检查。
   不需要浏览器——按真实工作目录 web/ 的文件与 index.html 的引用计算。
   预算超标时退出码为 1（CI 据此失败）。 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const KIB = 1024;

/* 预算（单位 KiB / 次数 / ms）。依据 2026-09 现状留出合理增长余量。
 *
 * ⚠ 2026-09 重新标定：#87（设计令牌）/ #88（异步态）/ #89（i18n 拆分，
 * 多出 i18n.zh.js + i18n.en.js 两个请求）/ #98（api-client.js）合入后，
 * 首屏实际体积已越过旧预算，而 #90（PWA：motion.js + pwa.js）再叠加
 * 约 5.8 KiB raw / 2.9 KiB gzip / 2 个请求。
 *
 * ⚠ 2026-09 再次重新标定：#100 把 `app.js` 拆成 ES 模块后，浏览器不再只取一个
 * app.js，而是顺着 import 图逐个取 web/modules/*.js（20 个文件）。体积只多了
 * import/export 与文件头的开销（约 +18 KiB raw / +17.5 KiB gzip，raw 反而略降——
 * 拆文件去掉了重复的文件级注释），但**首屏请求数从 15 涨到 35**。
 * 这是「无构建 + 原生 ES 模块」的固有代价：合并成一个请求就必须引入打包器，
 * 与本项目的硬约束冲突。缓解手段是 web/sw.js 预缓存全部模块（回访命中缓存），
 * 以及这些请求全部同源、HTTP/1.1 keep-alive 下并行发出。
 * 这里的预算是按「实际初载资源」重新标定的快照，属有意放宽，不是悄悄关掉检查——
 * 后续仍按同一口径棘轮收紧。 */
export const BUDGETS = {
  jsRawKiB: 348, // 初始 JS 未压缩合计（实测 324.5）
  jsGzipKiB: 127, // 初始 JS gzip 传输合计（实测 115.4）
  cssRawKiB: 72, // 初始 CSS 未压缩（实测 64.9）
  cssGzipKiB: 19, // 初始 CSS gzip 传输（实测 16.6）
  totalGzipKiB: 146, // JS + CSS gzip 合计（实测 132.0，不含 HTML，HTML 很小）
  subresourceRequests: 40, // 初始 <script src> + 模块图 + <link stylesheet> 数量（实测 35）
  ttiTargetMs: 1500 // 目标 TTI（本地/局域网，中端笔电）——浏览器指标，本脚本不测量
};
const CSS = ["style.css"];

/** 从模块入口出发，按 import 的相对路径递归收集全部模块文件。 */
function collectModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const abs = path.join(WEB, file);
    if (!fs.existsSync(abs)) continue;
    seen.add(file);
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(/\bfrom\s+"\.\/?([^"]+)"|\bimport\s+"\.\/?([^"]+)"/g)) {
      const spec = m[1] || m[2];
      if (spec) queue.push(path.join(path.dirname(file), spec));
    }
  }
  return [...seen].sort();
}

function bytes(file) {
  const p = path.join(WEB, file);
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

function gzipBytes(file) {
  const p = path.join(WEB, file);
  return fs.existsSync(p) ? zlib.gzipSync(fs.readFileSync(p)).length : 0;
}

function sum(list, fn) {
  return list.reduce((acc, f) => acc + fn(f), 0);
}

function kib(n) {
  return (n / KIB).toFixed(1);
}

export function measure() {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  /* 初载资源一律从 index.html 反推，不再维护一份手写文件名清单：
     清单一旦漏项（例如 i18n 拆分出的 i18n.zh.js / i18n.en.js、api-client.js、
     motion.js、pwa.js）就会静默低估预算基线，让检查形同虚设。
     ES 模块化后还要顺 app.js 的 import 图把 web/modules/*.js 计入首屏——
     浏览器不会把它们合并成一个请求。 */
  const scripts = [
    ...[...html.matchAll(/<script\b(?![^>]*type="module")[^>]*src="\/?([^"]+)"/g)].map((m) => m[1])
  ];
  /* app.js 是 <script type="module">，浏览器按 import 图逐个取 web/modules/*.js，
     这些请求同样发生在首屏，因此必须计入体积与请求数预算。 */
  const moduleEntry = html.match(/<script\b[^>]*type="module"[^>]*src="\/?([^"]+)"/);
  if (moduleEntry) scripts.push(...collectModules(moduleEntry[1]));
  const styles = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*href="\/?([^"]+)"/g)].map(
    (m) => m[1]
  );
  const CSS_HIT = styles.filter((f) => CSS.includes(f));
  const jsFiles = scripts.filter((f) => !CSS.includes(f));
  return {
    /* 引用了不存在的文件时按 0 计，不让 check 崩掉——体积超标会照常报出来。 */
    jsRaw: sum(jsFiles, bytes),
    jsGzip: sum(jsFiles, gzipBytes),
    cssRaw: sum(CSS_HIT, bytes),
    cssGzip: sum(CSS_HIT, gzipBytes),
    subresourceRequests: scripts.length + styles.length,
    initialFiles: [...jsFiles, ...CSS_HIT]
  };
}

export function check(measured = measure()) {
  const results = [
    ["初始 JS raw", measured.jsRaw / KIB, BUDGETS.jsRawKiB, "KiB"],
    ["初始 JS gzip", measured.jsGzip / KIB, BUDGETS.jsGzipKiB, "KiB"],
    ["初始 CSS raw", measured.cssRaw / KIB, BUDGETS.cssRawKiB, "KiB"],
    ["初始 CSS gzip", measured.cssGzip / KIB, BUDGETS.cssGzipKiB, "KiB"],
    ["JS+CSS gzip 合计", (measured.jsGzip + measured.cssGzip) / KIB, BUDGETS.totalGzipKiB, "KiB"],
    ["初始子资源请求数", measured.subresourceRequests, BUDGETS.subresourceRequests, "个"]
  ];
  return results.map(([label, actual, budget, unit]) => ({
    label,
    actual,
    budget,
    unit,
    ok: actual <= budget
  }));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const measured = measure();
  const results = check(measured);
  console.log("性能预算检查（首屏关键资源，web/）");
  console.log("| 指标 | 实测 | 预算 | 结果 |");
  console.log("| --- | --- | --- | --- |");
  for (const r of results) {
    const fmt = r.unit === "KiB" ? `${r.actual.toFixed(1)} ${r.unit}` : `${r.actual} ${r.unit}`;
    const bud = r.unit === "KiB" ? `${r.budget} ${r.unit}` : `${r.budget} ${r.unit}`;
    console.log(`| ${r.label} | ${fmt} | ${bud} | ${r.ok ? "✅" : "❌ 超标"} |`);
  }
  console.log(
    `\nTTI 目标：≤ ${BUDGETS.ttiTargetMs} ms（本地/局域网，中端笔电；由真实浏览器测量，本脚本不校验）。`
  );
  console.log(
    `明细：JS raw ${kib(measured.jsRaw)} KiB / gzip ${kib(measured.jsGzip)} KiB；CSS raw ${kib(measured.cssRaw)} KiB / gzip ${kib(measured.cssGzip)} KiB。`
  );
  console.log(
    `初载资源（${measured.initialFiles.length} 个，取自 index.html 与 app.js 的 import 图）：${measured.initialFiles.join(" ")}`
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n✗ ${failed.length} 项超出预算：${failed.map((r) => r.label).join("、")}`);
    process.exit(1);
  }
  console.log("\n✓ 全部在预算内");
}
