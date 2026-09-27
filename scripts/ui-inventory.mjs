/* #73 UI 清单生成器（仅开发期）：解析 web/index.html + web/*.js，产出
   - ui_inventory.json （机器可读，供漂移检查）
   - docs/ui.md       （人类可读：面板地图 / 控件表 / 快捷键 / 端点表）
   确定性输出：所有数组排序、固定 key 顺序、2 空格 JSON。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const WEB_DIR = path.join(ROOT, "web");
const INDEX_HTML = path.join(WEB_DIR, "index.html");
const OUT_JSON = path.join(ROOT, "ui_inventory.json");
const OUT_MD = path.join(ROOT, "docs", "ui.md");

const SCRIPTS = [
  "boot.js",
  "i18n.js",
  "wav.js",
  "file-browser.js",
  "audio-picker.js",
  "voice-select.js",
  "app.js",
  "voices-panel.js"
];

const CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "a"]);
const I18N_ATTRS = ["data-i18n", "data-i18n-placeholder", "data-i18n-title", "data-i18n-aria-label"];

function read(file) {
  return fs.readFileSync(file, "utf8");
}

/** 取以 id 唯一标识、可嵌套同名标签的元素整块（按同名标签配对）。 */
function extractElement(html, id, tag) {
  const tagRe = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  const startRe = new RegExp(`<${tag}\\b[^>]*\\bid="${id}"`);
  const sm = startRe.exec(html);
  if (!sm) return null;
  let depth = 0;
  tagRe.lastIndex = sm.index;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    if (m[0].startsWith("</")) depth--;
    else depth++;
    if (depth === 0) return html.slice(sm.index, m.index + m[0].length);
  }
  return html.slice(sm.index);
}

function attr(tagText, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tagText);
  return m ? m[1] : null;
}

function parseHtml(html) {
  const panels = [];
  const seen = new Set();

  const addPanel = (id, kind, tag) => {
    if (seen.has(id)) return;
    seen.add(id);
    const block = extractElement(html, id, tag) || "";
    const keys = new Set();
    for (const a of I18N_ATTRS) {
      const re = new RegExp(`${a}="([^"]+)"`, "g");
      for (let m = re.exec(block); m; m = re.exec(block)) keys.add(m[1]);
    }
    panels.push({
      id,
      kind,
      label: [...keys][0] || null,
      i18n: [...keys].sort()
    });
  };

  // 工作区面板
  for (const m of html.matchAll(/<([a-z]+)\b[^>]*\bid="(panel-[^"]+)"/g)) addPanel(m[2], "panel", m[1]);
  // 设置子面板
  for (const m of html.matchAll(/<([a-z]+)\b[^>]*\bid="(settings-pane-[^"]+)"/g)) addPanel(m[2], "settings-pane", m[1]);
  // 全屏 / 模态覆盖层
  for (const m of html.matchAll(/<([a-z]+)\b([^>]*\bclass="[^"]*modal-overlay[^"]*"[^>]*)>/g)) {
    const id = attr(m[2], "id");
    if (id) addPanel(id, "modal", m[1]);
  }
  panels.sort((a, b) => a.id.localeCompare(b.id));

  // 控件
  const controls = [];
  for (const m of html.matchAll(/<([a-z]+)\b([^>]*)>/g)) {
    const tag = m[1];
    const tagText = m[0];
    const id = attr(tagText, "id");
    if (!id || !CONTROL_TAGS.has(tag)) continue;
    const keys = I18N_ATTRS.map((a) => attr(tagText, a)).filter(Boolean);
    controls.push({ id, tag, type: tag === "input" ? attr(tagText, "type") : null, i18n: keys });
  }
  controls.sort((a, b) => a.id.localeCompare(b.id));

  // data-* hooks（HTML 静态属性）
  const hookCounts = new Map();
  for (const m of html.matchAll(/\b(data-[a-z0-9-]+)=/g)) {
    hookCounts.set(m[1], (hookCounts.get(m[1]) || 0) + 1);
  }
  const dataHooks = [...hookCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { panels, controls, dataHooks };
}

/** 从 JS 源收集 id → 事件 → 来源文件。 */
function parseHandlers(scripts) {
  const handlers = new Map();
  const add = (id, event, source) => {
    if (!handlers.has(id)) handlers.set(id, new Map());
    const ev = handlers.get(id);
    if (!ev.has(event)) ev.set(event, new Set());
    ev.get(event).add(source);
  };
  for (const { name, code } of scripts) {
    for (const m of code.matchAll(/\$\("([^"]+)"\)\.(onclick|onchange|oninput|onkeydown|onkeyup|onsubmit|onmousedown)\s*=/g)) {
      add(m[1], m[2].slice(2), name);
    }
    for (const m of code.matchAll(/\$\("([^"]+)"\)\.addEventListener\("([a-z]+)"/g)) {
      add(m[1], m[2], name);
    }
    for (const m of code.matchAll(/document\.getElementById\("([^"]+)"\)\.(onclick|onchange|oninput|onkeydown)\s*=/g)) {
      add(m[1], m[2].slice(2), name);
    }
    // 经由中间变量的绑定：const themeBtn = $("theme-toggle"); themeBtn.onclick = ...
    const varMap = new Map();
    for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\("([^"]+)"\)/g)) {
      varMap.set(m[1], m[2]);
    }
    for (const [varName, id] of varMap) {
      const v = varName.replace(/[$]/g, "\\$&");
      for (const m of code.matchAll(new RegExp(`\\b${v}\\.(onclick|onchange|oninput|onkeydown|onkeyup|onsubmit|onmousedown)\\s*=`, "g"))) {
        add(id, m[1].slice(2), name);
      }
      for (const m of code.matchAll(new RegExp(`\\b${v}\\.addEventListener\\("([a-z]+)"`, "g"))) {
        add(id, m[1], name);
      }
    }
  }
  return handlers;
}

/** 找到 index 处 `(` 的配对 `)`，跳过字符串/模板。 */
function matchParen(src, openIndex) {
  let depth = 0;
  let mode = null;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (mode) {
      if (ch === "\\") { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { mode = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return i; }
  }
  return src.length - 1;
}

/** 取 fetch(...) 的第一个实参文本（到 depth 0 的逗号为止，跳过字符串）。 */
function firstArgument(callText) {
  const open = callText.indexOf("(");
  let depth = 0;
  let mode = null;
  for (let i = open; i < callText.length; i++) {
    const ch = callText[i];
    if (mode) {
      if (ch === "\\") { i++; continue; }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { mode = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") { depth--; if (depth === 0) return callText.slice(open + 1, i); }
    else if (ch === "," && depth === 1) return callText.slice(open + 1, i);
  }
  return callText.slice(open + 1);
}

/** 把一个实参里的字符串字面量拼成归一化路径，变量/插值处用 {param} 占位。 */
function literalPath(arg) {
  const re = /`([^`]*)`|"([^"]*)"|'([^']*)'/g;
  const lits = [];
  for (let m = re.exec(arg); m; m = re.exec(arg)) {
    const raw = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    const text = m[1] !== undefined ? raw.replace(/\$\{[^}]*\}/g, "{param}") : raw;
    lits.push({ index: m.index, end: re.lastIndex, text });
  }
  if (!lits.length) return null;
  let p = "";
  let prevEnd = null;
  for (const lit of lits) {
    if (prevEnd !== null) {
      const between = arg.slice(prevEnd, lit.index).replace(/\+/g, "");
      if (/[A-Za-z0-9_$]/.test(between)) p += "{param}";
    }
    p += lit.text;
    prevEnd = lit.end;
  }
  const tail = arg.slice(prevEnd).replace(/\+/g, "");
  if (/[A-Za-z0-9_$]/.test(tail)) p += "{param}";
  return p;
}

/** 在顶层（跳过字符串/嵌套）查找字符 ch 的下标。 */
function topLevelIndex(arg, ch, from = 0) {
  let depth = 0;
  let mode = null;
  for (let i = from; i < arg.length; i++) {
    const c = arg[i];
    if (mode) {
      if (c === "\\") { i++; continue; }
      if (c === mode) mode = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { mode = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** 把 `cond ? "a" : "b"` 展开成各分支的归一化路径（无三元则单元素）。 */
function pathsFromArg(arg) {
  const q = topLevelIndex(arg, "?", 0);
  if (q < 0) return [literalPath(arg)];
  const c = topLevelIndex(arg, ":", q + 1);
  if (c < 0) return [literalPath(arg)];
  return [...pathsFromArg(arg.slice(q + 1, c)), ...pathsFromArg(arg.slice(c + 1))];
}

/** 从 fetch 调用文本提取 HTTP 方法（支持 `method: a ? "PUT" : "POST"`）。 */
function methodsFrom(callText) {
  const mi = callText.indexOf("method:");
  if (mi < 0) return ["GET"];
  const start = mi + "method:".length;
  let end = callText.length;
  for (const stop of [",", "}"]) {
    const i = callText.indexOf(stop, start);
    if (i >= 0 && i < end) end = i;
  }
  const seg = callText.slice(start, end);
  const ms = [...seg.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]);
  return ms.length ? ms : ["GET"];
}

/** 从 JS 源收集 API 端点（method + 归一化 path + 来源）。 */
function parseEndpoints(scripts) {
  const map = new Map();
  const add = (method, p, source) => {
    if (!p || !p.startsWith("/")) return;
    if (!map.has(`${method} ${p}`)) map.set(`${method} ${p}`, { method, path: p, sources: new Set() });
    map.get(`${method} ${p}`).sources.add(source);
  };
  for (const { name, code } of scripts) {
    for (const m of code.matchAll(/fetch\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchParen(code, open);
      const callText = code.slice(open, close + 1);
      const paths = pathsFromArg(firstArgument(callText)).filter(Boolean);
      if (!paths.length) continue;
      const methods = methodsFrom(callText);
      if (methods.length === paths.length) {
        for (let i = 0; i < paths.length; i++) add(methods[i], paths[i], name);
      } else {
        for (const p of paths) for (const method of methods) add(method, p, name);
      }
    }
  }
  return [...map.values()]
    .map((e) => ({ method: e.method, path: e.path, sources: [...e.sources].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** 从 JS 源收集键盘快捷键。 */
function parseShortcuts(scripts) {
  const out = [];
  for (const { name, code } of scripts) {
    for (const m of code.matchAll(/\.key\s*(===|!==)\s*"([^"]+)"/g)) {
      out.push({ key: m[2], negated: m[1] === "!==", source: name });
    }
  }
  const dedup = new Map();
  for (const s of out) {
    const key = `${s.key}|${s.negated}|${s.source}`;
    if (!dedup.has(key)) dedup.set(key, s);
  }
  return [...dedup.values()].sort((a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source));
}

export function buildInventory() {
  const html = read(INDEX_HTML);
  const scripts = SCRIPTS.map((name) => ({ name: `web/${name}`, code: read(path.join(WEB_DIR, name)) }));
  const { panels, controls, dataHooks } = parseHtml(html);
  const handlerMap = parseHandlers(scripts);

  const controlsOut = controls.map((c) => {
    const ev = handlerMap.get(c.id);
    const handlers = ev
      ? [...ev.entries()].map(([event, sources]) => ({ event, sources: [...sources].sort() })).sort((a, b) => a.event.localeCompare(b.event))
      : [];
    return { ...c, handlers };
  });

  return {
    generatedFrom: { indexHtml: "web/index.html", scripts: SCRIPTS.map((s) => `web/${s}`) },
    panels,
    controls: controlsOut,
    dataHooks,
    shortcuts: parseShortcuts(scripts),
    endpoints: parseEndpoints(scripts)
  };
}

export function renderMarkdown(inv) {
  const L = [];
  L.push("# Web UI 清单");
  L.push("");
  L.push("> 由 `npm run ui:inventory` 从 `web/index.html` 与 `web/*.js` 自动生成，请勿手改。");
  L.push("> 漂移检查：`npm run ui:inventory:check`（CI 会跑）。");
  L.push("");
  L.push(`来源：\`${inv.generatedFrom.indexHtml}\` + ${inv.generatedFrom.scripts.map((s) => `\`${s}\``).join("、")}`);
  L.push("");

  L.push("## 面板地图");
  L.push("");
  L.push("| id | 类型 | 首个 i18n key | i18n key 数 |");
  L.push("| --- | --- | --- | --- |");
  for (const p of inv.panels) {
    L.push(`| \`${p.id}\` | ${p.kind} | ${p.label ? `\`${p.label}\`` : "—"} | ${p.i18n.length} |`);
  }
  L.push("");

  L.push("## 控件");
  L.push("");
  L.push("| id | 标签 | 类型 | i18n key | 事件 |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const c of inv.controls) {
    const i18n = c.i18n.map((k) => `\`${k}\``).join("<br>") || "—";
    const handlers = c.handlers.map((h) => `\`${h.event}\``).join(", ") || "—";
    L.push(`| \`${c.id}\` | ${c.tag} | ${c.type || "—"} | ${i18n} | ${handlers} |`);
  }
  L.push("");

  L.push("## 键盘快捷键");
  L.push("");
  L.push("| 按键 | 判定 | 来源 |");
  L.push("| --- | --- | --- |");
  for (const s of inv.shortcuts) {
    L.push(`| \`${s.key}\` | ${s.negated ? "非 (guard)" : "等值"} | \`${s.source}\` |`);
  }
  L.push("");
  L.push("说明：上表由源码中的 `e.key === \"...\"` 判定推导；Escape 用于关闭最上层弹窗 / 菜单，");
  L.push("Enter / Space 用于文件浏览与文件选择。快捷键未集中注册，散落在各模块事件处理器中。");
  L.push("");

  L.push("## API 端点（前端引用）");
  L.push("");
  L.push("| 方法 | 路径 | 来源 |");
  L.push("| --- | --- | --- |");
  for (const e of inv.endpoints) {
    L.push(`| ${e.method} | \`${e.path}\` | ${e.sources.map((s) => `\`${s}\``).join(", ")} |`);
  }
  L.push("");
  L.push("路径中的 `{param}` 表示由运行时拼接/模板插值（如实例 id、任务 id）。");
  L.push("");

  L.push("## data-* 钩子");
  L.push("");
  L.push("| 属性 | 静态出现次数 |");
  L.push("| --- | --- |");
  for (const h of inv.dataHooks) {
    L.push(`| \`${h.name}\` | ${h.count} |`);
  }
  L.push("");
  return L.join("\n");
}

export function generate() {
  const inv = buildInventory();
  return { json: JSON.stringify(inv, null, 2) + "\n", markdown: renderMarkdown(inv), inventory: inv };
}

export function writeInventory() {
  const { json, markdown } = generate();
  fs.writeFileSync(OUT_JSON, json);
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, markdown);
  return { OUT_JSON, OUT_MD };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { OUT_JSON: j, OUT_MD: m } = writeInventory();
  const inv = buildInventory();
  console.log(`ui inventory written: ${path.relative(ROOT, j)} (${inv.panels.length} panels, ${inv.controls.length} controls, ${inv.endpoints.length} endpoints)`);
  console.log(`docs written: ${path.relative(ROOT, m)}`);
}
