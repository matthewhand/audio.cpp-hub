/* #74 性能预算：对首屏关键资源做 raw + gzip 体积与请求数检查。
   不需要浏览器——按真实工作目录 web/ 的文件与 index.html 的引用计算，
   并沿 ES module 的 import 图（含 `export ... from` 再导出）传递闭包。

   预算针对**首屏同步加载**的资源：静态 import/再导出的模块计入；
   动态 import() 的懒加载模块不计入（首屏不请求），属预期行为。 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const KIB = 1024;

/* 预算（单位 KiB / 次数 / ms）。依据 2026-09 集成后现状留出合理增长余量。
   注意：模块化（ES module 图）天然增加请求数；这些数字是集成后的**实测基线 + 余量**，
   只允许下降不允许上升。后续可用动态 import() 懒加载非首屏面板来压低初始请求数。 */
export const BUDGETS = {
  jsRawKiB: 320, // 首屏 JS 未压缩合计（含 import 闭包）
  jsGzipKiB: 112, // 首屏 JS gzip 传输合计
  cssRawKiB: 72, // 首屏 CSS 未压缩（集成后 style.css 增长）
  cssGzipKiB: 18, // 首屏 CSS gzip 传输
  totalGzipKiB: 130, // JS + CSS gzip 合计（不含 HTML）
  subresourceRequests: 34, // 首屏 <script src> + <link stylesheet> + 同步 import 闭包模块数
  ttiTargetMs: 1500, // 目标 TTI（本地/局域网，中端笔电）——浏览器指标，本脚本不测量
};

function read(file) {
  return fs.readFileSync(path.join(WEB, file), "utf8");
}
function bytes(file) {
  return fs.statSync(path.join(WEB, file)).size;
}
function gzipBytes(file) {
  return zlib.gzipSync(fs.readFileSync(path.join(WEB, file))).length;
}
function sum(list, fn) {
  return list.reduce((acc, f) => acc + fn(f), 0);
}
function kib(n) {
  return (n / KIB).toFixed(1);
}

/* 从 html 中提取所有被引用的本地脚本/样式（去掉查询串、前导 /）。
   引号与属性大小写不敏感（prettier 目前统一双引号，此处防御格式变动）。 */
function referencedAssets(html) {
  const refs = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of html.matchAll(
    /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*\bhref\s*=\s*["']([^"']+)["']/gi,
  ))
    refs.add(m[1]);
  for (const m of html.matchAll(
    /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\brel\s*=\s*["']stylesheet["']/gi,
  ))
    refs.add(m[1]);
  return [...refs]
    .map((r) => r.replace(/^\//, "").split("?")[0])
    .filter((r) => !/^https?:/.test(r));
}

/* 去掉注释，避免把注释里的 "import" 误判为真实语句。
   注意：保留字符串字面量，否则 import 的路径说明符也会被抹掉。 */
function stripComments(src) {
  // 简单状态机：跳过字符串/模板串/正则字面量，只在代码区移除注释。
  let out = "";
  let i = 0;
  const n = src.length;
  let state = "code"; // code | line | block | sq | dq | tpl | regex
  while (i < n) {
    const c = src[i];
    const nxt = src[i + 1];
    if (state === "code") {
      if (c === "/" && nxt === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && nxt === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        state = "sq";
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        state = "dq";
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        state = "tpl";
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && nxt === "/") {
        state = "code";
        i += 2;
      } else i++;
      continue;
    }
    // 单/双引号字符串：保留内容（import 说明符必须用引号，需保留以便匹配）
    if (state === "sq" || state === "dq") {
      out += c;
      if (c === "\\") {
        if (i + 1 < n) out += src[i + 1];
        i += 2;
        continue;
      }
      if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) state = "code";
      i++;
      continue;
    }
    // 模板字符串：清空内容（说明符不会用反引号），避免其中的 "import" 被误判
    if (state === "tpl") {
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        state = "code";
        out += c;
      } else out += " ";
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/* 递归解析一个 ES module 的静态依赖说明符（import ... from / export ... from /
   副作用 import），返回其依赖的 web/ 相对路径闭包。 */
function moduleDeps(entry, seen) {
  if (seen.has(entry)) return [];
  seen.add(entry);
  let src;
  try {
    src = read(entry);
  } catch {
    return [];
  }
  const code = stripComments(src);
  const specs = [];
  // import 语句：import "x"、import { a } from "x"、import * as n from "x"、多行形式
  for (const m of code.matchAll(/\bimport\s*(?:[^'"();]*?\bfrom\s*)?["']([^"']+)["']/g))
    specs.push(m[1]);
  // 再导出：export { a } from "x"、export * from "x"、export * as n from "x"
  for (const m of code.matchAll(
    /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
  ))
    specs.push(m[1]);

  const out = [];
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue; // 仅本地相对导入
    const resolved = path
      .normalize(path.join(path.dirname(entry), spec))
      .split(path.sep)
      .join("/");
    out.push(resolved);
    out.push(...moduleDeps(resolved, seen));
  }
  return out;
}

export function measure() {
  const html = read("index.html");
  const assets = referencedAssets(html);
  const jsEntries = assets.filter((f) => f.endsWith(".js"));
  const cssEntries = assets.filter((f) => f.endsWith(".css"));

  // JS：脚本入口 + 其 import 闭包
  const jsSet = new Set(jsEntries);
  const seen = new Set();
  for (const entry of jsEntries) {
    for (const dep of moduleDeps(entry, seen)) jsSet.add(dep);
  }
  const js = [...jsSet].filter((f) => fs.existsSync(path.join(WEB, f)));

  // CSS：样式入口（本仓库为单文件，保留扩展位）
  const css = cssEntries.filter((f) => fs.existsSync(path.join(WEB, f)));

  // 初始请求数 = 去重后的本地 script 入口 + stylesheet 入口 + import 闭包新增模块数。
  // 用归一化集合统一口径，避免重复标签/缺失文件造成的偏差。
  const entryRequests = [...new Set([...jsEntries, ...cssEntries])].filter((f) =>
    fs.existsSync(path.join(WEB, f)),
  ).length;
  const closureModules = js.filter((f) => !jsEntries.includes(f)).length;
  const subresourceRequests = entryRequests + closureModules;

  return {
    jsRaw: sum(js, bytes),
    jsGzip: sum(js, gzipBytes),
    cssRaw: sum(css, bytes),
    cssGzip: sum(css, gzipBytes),
    subresourceRequests,
  };
}

export function check(measured = measure()) {
  const results = [
    ["首屏 JS raw", measured.jsRaw / KIB, BUDGETS.jsRawKiB, "KiB"],
    ["首屏 JS gzip", measured.jsGzip / KIB, BUDGETS.jsGzipKiB, "KiB"],
    ["首屏 CSS raw", measured.cssRaw / KIB, BUDGETS.cssRawKiB, "KiB"],
    ["首屏 CSS gzip", measured.cssGzip / KIB, BUDGETS.cssGzipKiB, "KiB"],
    ["JS+CSS gzip 合计", (measured.jsGzip + measured.cssGzip) / KIB, BUDGETS.totalGzipKiB, "KiB"],
    ["初始子资源请求数", measured.subresourceRequests, BUDGETS.subresourceRequests, "个"],
  ];
  return results.map(([label, actual, budget, unit]) => ({
    label,
    actual,
    budget,
    unit,
    ok: actual <= budget,
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
    `\nTTI 目标：≤ ${BUDGETS.ttiTargetMs} ms（本地/局域网，中端笔电；由真实浏览器测量，本脚本不校验）。`,
  );
  console.log(
    `明细：JS raw ${kib(measured.jsRaw)} KiB / gzip ${kib(measured.jsGzip)} KiB；CSS raw ${kib(measured.cssRaw)} KiB / gzip ${kib(measured.cssGzip)} KiB。`,
  );

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n✗ ${failed.length} 项超出预算：${failed.map((r) => r.label).join("、")}`);
    process.exit(1);
  }
  console.log("\n✓ 全部在预算内");
}
