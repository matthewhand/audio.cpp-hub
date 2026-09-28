#!/usr/bin/env node
/* 回归防护：校验 PWA Service Worker（web/sw.js）的 PRECACHE_URLS 覆盖全部首屏资源。
 *
 * 背景：web/index.html 以 <script type="module" src="/app.js"> 加载入口，app.js 静态
 *   import web/core/*.js 与 web/features/*.js。这些被 import 的模块必须同样进入
 *   PRECACHE_URLS，否则离线首次加载会因缺少模块而白屏（历史缺陷，本脚本防止回归）。
 *
 * 校验范围：
 *   1. index.html 中 <script src> 与 <link rel="stylesheet" href> 的本地引用；
 *   2. 从上述 .js 入口出发的 ES module 静态 import 传递闭包；
 *   3. 固定外壳必需项（/、/index.html、/offline.html、/manifest.webmanifest、/style.css）。
 *
 * 用法：node scripts/check-sw-precache.mjs
 *   自测：SW_WEB_DIR=/path/to/web node scripts/check-sw-precache.mjs
 *
 * 本脚本只读校验、绝不修改任何 web/ 文件；有缺失时退出码为 1。无第三方依赖，Node >= 22。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* web/ 目录默认取仓库根下 web/，可用 SW_WEB_DIR 覆盖（供自测指向临时副本）。 */
const WEB = process.env.SW_WEB_DIR
  ? path.resolve(process.env.SW_WEB_DIR)
  : path.resolve(HERE, "..", "web");
const SW_FILE = path.join(WEB, "sw.js");
const HTML_FILE = path.join(WEB, "index.html");

/* 静态 import 说明符：兼容 `import "./x.js"`、`import { a, b } from "./x.js"`
 * 以及跨行 `import {\n ... \n} from "./x.js"`；忽略动态 import()（import 后紧跟 "("）。 */
const IMPORT_RE = /\bimport\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/g;

/* 固定外壳项：即使解析逻辑失效也必须在预缓存中。 */
const REQUIRED_SHELL = ["/", "/index.html", "/offline.html", "/manifest.webmanifest", "/style.css"];

function readFile(file) {
  return fs.readFileSync(file, "utf8");
}

/* 统一为以 "/" 开头的 web 根相对 URL key。 */
function toKey(rel) {
  return "/" + String(rel).replace(/^\.\//, "").replace(/^\/+/, "");
}

/* 去查询串/锚点；非本地（http(s)://、//、data: 等）引用返回 null。 */
function normalizeRef(raw) {
  let ref = String(raw).trim().split(/[?#]/)[0];
  if (!ref) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return null;
  ref = ref.replace(/^\/+/, "");
  return ref || null;
}

/* 解析 sw.js 的 PRECACHE_URLS 数组：字符串字面量 + 常量标识符（如 OFFLINE_URL）。 */
function parsePrecache(swSrc) {
  const block = swSrc.match(/const\s+PRECACHE_URLS\s*=\s*\[([\s\S]*?)\]\s*;/);
  if (!block) {
    console.error("✗ 无法在 web/sw.js 中定位 PRECACHE_URLS 数组字面量");
    process.exit(2);
  }
  const body = block[1];
  const urls = new Set();
  for (const m of body.matchAll(/"([^"]*)"/g)) urls.add(toKey(m[1]));
  for (const m of body.matchAll(/(?:^|[,[])\s*([A-Za-z_$][\w$]*)\s*(?=[,\]])/g)) {
    const def = swSrc.match(new RegExp(`const\\s+${m[1]}\\s*=\\s*"([^"]*)"`));
    if (def) urls.add(toKey(def[1]));
  }
  return urls;
}

/* 解析 index.html 的本地资源引用（<script src> + <link rel="stylesheet" href>），
 * 返回 web 相对路径数组（无前导 "/"，无查询串）。 */
function parseIndexRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    const rel = normalizeRef(m[1]);
    if (rel) refs.add(rel);
  }
  for (const tag of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["'][^"']*\bstylesheet\b/i.test(tag[0])) continue;
    const href = tag[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    const rel = normalizeRef(href[1]);
    if (rel) refs.add(rel);
  }
  return [...refs];
}

/* 从 .js 入口沿静态 import 求传递闭包，返回 Map<模块相对路径, Set<导入者相对路径>>。 */
function walkModules(entries) {
  const importers = new Map();
  const visited = new Set();
  const queue = entries.filter((f) => f.endsWith(".js"));
  while (queue.length) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    let src;
    try {
      src = readFile(path.join(WEB, rel));
    } catch {
      continue; // 入口文件本身缺失不属本脚本职责
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue; // 仅相对导入，忽略裸包名
      const resolved = path.posix
        .normalize(path.posix.join(path.posix.dirname(rel), spec))
        .replace(/^\.\//, "");
      if (resolved.startsWith("..") || path.posix.isAbsolute(resolved)) continue;
      if (!importers.has(resolved)) importers.set(resolved, new Set());
      importers.get(resolved).add(rel);
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }
  return importers;
}

function main() {
  const precache = parsePrecache(readFile(SW_FILE));
  const indexRefs = parseIndexRefs(readFile(HTML_FILE));
  const importers = walkModules(indexRefs);

  const violations = [];
  const seen = new Set();
  const add = (key, reason) => {
    if (precache.has(key) || seen.has(key)) return;
    seen.add(key);
    violations.push({ key, reason });
  };

  for (const key of REQUIRED_SHELL) add(key, "固定外壳必需项");
  for (const rel of indexRefs) add(toKey(rel), "被 index.html 引用");
  for (const [rel, who] of importers) {
    const from = [...who].sort().map(toKey).join("、");
    add(toKey(rel), `被 ${from} 导入`);
  }

  if (violations.length) {
    console.error(
      "✗ Service Worker 预缓存检查失败 | " +
        `web/sw.js 的 PRECACHE_URLS 缺少 ${violations.length} 项：`,
    );
    for (const v of violations) console.error(`  - ${v.key}（${v.reason}）`);
    console.error(
      "  请把上述路径补进 web/sw.js 的 PRECACHE_URLS，否则离线首次加载会缺少这些资源。",
    );
    process.exit(1);
  }

  console.log(
    `✓ Service Worker 预缓存检查通过：PRECACHE_URLS 共 ${precache.size} 项，` +
      `index.html 本地引用 ${indexRefs.length} 项，` +
      `ES module 静态 import 闭包 ${importers.size} 个模块，必需项均已覆盖。`,
  );
}

main();
