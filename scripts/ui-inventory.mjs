/* #73 UI 清单生成器（仅开发期）：解析 web/index.html + web/*.js + web/modules/*.js，产出
   - ui_inventory.json （机器可读，供漂移检查）
   - docs/ui.md       （人类可读：面板地图 / 控件表 / 快捷键 / 端点表）
   确定性输出：所有数组排序、固定 key 顺序、2 空格 JSON，
   并经 Prettier 归一，使生成物本身就能通过 `npm run format:check`
   （否则生成与格式检查会互相打架）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
const WEB_DIR = path.join(ROOT, "web");
const INDEX_HTML = path.join(WEB_DIR, "index.html");
const OUT_JSON = path.join(ROOT, "ui_inventory.json");
const OUT_MD = path.join(ROOT, "docs", "ui.md");

/* 分析范围从 index.html 的实际 <script src> 反推，不再维护手写清单：
   漏项会让清单悄悄漏掉某个前端模块（i18n 拆分后新增的 i18n.zh.js /
   i18n.en.js、api-client.js、motion.js、pwa.js 都不在旧清单里）。
   app.js 改成 ES 模块后业务逻辑住进 web/modules/*.js，index.html 只写了入口，
   因此再顺着入口的 import 图把模块一并纳入（否则事件绑定会整体漏登记）。 */
const MODULE_ENTRY = /<script\b[^>]*type="module"[^>]*src="\/([^"]+)"/;
const classicScripts = [
  ...fs
    .readFileSync(INDEX_HTML, "utf8")
    .matchAll(/<script\b(?![^>]*type="module")[^>]*src="\/([^"]+)"/g)
].map((m) => m[1]);

/** 从模块入口出发，按 import 的相对路径递归收集全部模块文件。 */
function collectModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    const abs = path.join(WEB_DIR, file);
    if (!fs.existsSync(abs)) continue;
    seen.add(file);
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(/\bfrom\s+"\.\/?([^"]+)"|\bimport\s+"\.\/?([^"]+)"/g)) {
      const spec = m[1] || m[2];
      if (spec) queue.push(path.join(path.dirname(file), spec));
    }
  }
  return [...seen];
}

const entry = fs.readFileSync(INDEX_HTML, "utf8").match(MODULE_ENTRY);
const SCRIPTS = [...new Set([...classicScripts, ...(entry ? collectModules(entry[1]) : [])])]
  .filter((name) => name !== "sw.js")
  .sort();

const CONTROL_TAGS = new Set(["button", "input", "select", "textarea", "a"]);
const I18N_ATTRS = [
  "data-i18n",
  "data-i18n-placeholder",
  "data-i18n-title",
  "data-i18n-aria-label"
];

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
  for (const m of html.matchAll(/<([a-z]+)\b[^>]*\bid="(panel-[^"]+)"/g))
    addPanel(m[2], "panel", m[1]);
  // 设置子面板
  for (const m of html.matchAll(/<([a-z]+)\b[^>]*\bid="(settings-pane-[^"]+)"/g))
    addPanel(m[2], "settings-pane", m[1]);
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
    for (const m of code.matchAll(
      /\$\("([^"]+)"\)\.(onclick|onchange|oninput|onkeydown|onkeyup|onsubmit|onmousedown)\s*=/g
    )) {
      add(m[1], m[2].slice(2), name);
    }
    for (const m of code.matchAll(/\$\("([^"]+)"\)\.addEventListener\("([a-z]+)"/g)) {
      add(m[1], m[2], name);
    }
    for (const m of code.matchAll(
      /document\.getElementById\("([^"]+)"\)\.(onclick|onchange|oninput|onkeydown)\s*=/g
    )) {
      add(m[1], m[2].slice(2), name);
    }
    // 经由中间变量的绑定：const themeBtn = $("theme-toggle"); themeBtn.onclick = ...
    const varMap = new Map();
    for (const m of code.matchAll(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\$\("([^"]+)"\)/g
    )) {
      varMap.set(m[1], m[2]);
    }
    for (const [varName, id] of varMap) {
      const v = varName.replace(/[$]/g, "\\$&");
      for (const m of code.matchAll(
        new RegExp(
          `\\b${v}\\.(onclick|onchange|oninput|onkeydown|onkeyup|onsubmit|onmousedown)\\s*=`,
          "g"
        )
      )) {
        add(id, m[1].slice(2), name);
      }
      for (const m of code.matchAll(new RegExp(`\\b${v}\\.addEventListener\\("([a-z]+)"`, "g"))) {
        add(id, m[1], name);
      }
    }
  }
  return handlers;
}

const BRACKET_PAIRS = { "(": ")", "[": "]", "{": "}" };

/** 找到 openIndex 处 `(` / `[` / `{` 的配对闭合符下标（跳过字符串/模板与嵌套）。
    配对不齐时返回 -1，调用方据此放弃该调用点（宁可少登记也不登记半截调用）。 */
function matchBracket(src, openIndex) {
  const stack = [];
  let mode = null;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (mode) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      mode = ch;
      continue;
    }
    if (BRACKET_PAIRS[ch]) {
      stack.push(BRACKET_PAIRS[ch]);
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      if (stack.pop() !== ch) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/* 正则字面量只可能紧跟这些 token 出现（否则同一个 `/` 是除号） */
const REGEX_PRECEDER = /[([{=,:;!&|?+\-*/%<>~^]/;
const REGEX_KEYWORD =
  /^(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/* 掩码档位：KEEP 两份都留原文；LITERAL 原文留在 text、code 留空格；DROP 两份都留空格 */
const KEEP = 0;
const LITERAL = 1;
const DROP = 2;

/** 扫出两份等长视图（下标与原文一一对应）：
      text —— 注释 / 正则内容已掩码，字符串与模板**保留**：用来抽路径与实参；
      code —— 注释、正则、字符串、模板的字面内容全部掩码，只剩真代码：
              用来定位调用点。
    必须分成两份：路径字面量本身就是字符串，全掩码就抽不出路径了；而只用一份
    的话，字符串里写的 `fetch("/api/x")`（i18n 字典里就有一例）会被当成真调用，
    凭空造端点。

    这里必须是状态机而不是正则：web/modules/dom.js 里有 /^https?:\/\// 这类正则
    字面量，天真的 `//` 扫描会把它的结尾当成行注释、吞掉后面整行。 */
function maskSource(src) {
  const n = src.length;
  let text = "";
  let code = "";
  let prevCh = "";
  let prevWord = "";
  const put = (s, mode) => {
    if (mode === KEEP) {
      text += s;
      code += s;
      return;
    }
    if (mode === LITERAL) {
      text += s;
      for (const c of s) code += c === "\n" ? "\n" : " ";
      return;
    }
    for (const c of s) {
      const b = c === "\n" ? "\n" : " ";
      text += b;
      code += b;
    }
  };
  const setPrev = (c) => {
    prevCh = c;
    prevWord = "";
  };
  const regexStart = () =>
    prevCh === "" || REGEX_PRECEDER.test(prevCh) || REGEX_KEYWORD.test(prevWord);
  /* 普通引号字符串的结束下标（字符串不跨行，未闭合就停在行尾，绝不吞掉后续代码） */
  const stringEnd = (from, quote) => {
    let j = from + 1;
    while (j < n) {
      if (src[j] === "\\") {
        j += 2;
        continue;
      }
      if (src[j] === quote) return j + 1;
      if (src[j] === "\n") return j;
      j++;
    }
    return n;
  };
  const regexEnd = (from) => {
    let j = from + 1;
    let inClass = false;
    while (j < n) {
      const t = src[j];
      if (t === "\\") {
        j += 2;
        continue;
      }
      if (t === "\n") return -1;
      if (t === "[") inClass = true;
      else if (t === "]") inClass = false;
      else if (t === "/" && !inClass) {
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        return j;
      }
      j++;
    }
    return -1;
  };
  /* 模板字面量（from = 开引号之后）：${} 插值里是真代码，必须递归掩码，
     否则嵌套模板 `a${x ? `b${y}` : ""}c` 会让状态机错位、把后面的真调用吞掉。 */
  const template = (from) => {
    let i = from;
    while (i < n) {
      const c = src[i];
      if (c === "\\") {
        put(src.slice(i, i + 2), LITERAL);
        i += 2;
        continue;
      }
      if (c === "`") {
        put(c, KEEP);
        setPrev("`");
        return i + 1;
      }
      if (c === "$" && src[i + 1] === "{") {
        put("${", KEEP);
        i = scan(i + 2, true);
        continue;
      }
      put(c, LITERAL);
      i++;
    }
    return i;
  };
  /* 扫一段真代码；stopAtBrace 时扫到与 "${" 配对的 "}" 为止（含嵌套 {}） */
  const scan = (from, stopAtBrace) => {
    let i = from;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      const c2 = src[i + 1];
      if (c === "/" && c2 === "/") {
        const e = src.indexOf("\n", i);
        const end = e < 0 ? n : e;
        put(src.slice(i, end), DROP);
        i = end;
        setPrev("");
        continue;
      }
      if (c === "/" && c2 === "*") {
        const e = src.indexOf("*/", i + 2);
        const end = e < 0 ? n : e + 2;
        put(src.slice(i, end), DROP);
        i = end;
        setPrev("");
        continue;
      }
      if (c === '"' || c === "'") {
        const e = stringEnd(i, c);
        put(src.slice(i, e), LITERAL);
        i = e;
        setPrev(c);
        continue;
      }
      if (c === "`") {
        put(c, KEEP);
        i = template(i + 1);
        continue;
      }
      if (c === "/" && regexStart()) {
        const e = regexEnd(i);
        if (e > 0) {
          put(src.slice(i, e), DROP);
          i = e;
          setPrev("/");
          continue;
        }
        // 不是正则（是除号）：按普通字符继续
      }
      if (stopAtBrace) {
        if (c === "}") {
          if (depth === 0) {
            put(c, KEEP);
            setPrev("}");
            return i + 1;
          }
          depth--;
        } else if (c === "{") {
          depth++;
        }
      }
      put(c, KEEP);
      i++;
      if (!/\s/.test(c)) {
        prevCh = c;
        prevWord = /[A-Za-z_$]/.test(c) ? prevWord + c : "";
      }
    }
    return i;
  };
  scan(0, false);
  return { text, code };
}

/** 按顶层逗号切分一段文本（跳过嵌套括号与字符串），末尾允许一个空实参。 */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let mode = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (mode) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === mode) mode = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      mode = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** 拆分 `Api.post(path, body, opts)` / `fetch(url, init)` 的顶层实参文本。 */
function callArgs(callText) {
  const open = callText.indexOf("(");
  const close = matchBracket(callText, open);
  if (close < 0) return [];
  return splitTopLevel(callText.slice(open + 1, close));
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
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === mode) mode = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      mode = c;
      continue;
    }
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

/** 从 fetch / Api.request 调用文本提取 HTTP 方法（支持 `method: a ? "PUT" : "POST"`）。 */
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

/** 路径归一化：`${x}`（literalPath 已替换）、`{name}` 占位、`:name` 段一律收敛成
    `{param}`，这样 `Api.get("/api/tasks/{id}")` 与迁移前的
    `fetch("/api/tasks/" + id)` 会登记成同一个端点。? 之后的查询串不参与归一化。 */
function normalizePath(path) {
  const q = path.indexOf("?");
  const head = q < 0 ? path : path.slice(0, q);
  const tail = q < 0 ? "" : path.slice(q);
  return (
    head.replace(/\{[A-Za-z_][\w]*\}/g, "{param}").replace(/\/:[A-Za-z_][\w]*/g, "/{param}") + tail
  );
}

/** query 选项值：字面量取原样（`${}` 插值 → {param}），表达式取 {param}。 */
function optionValue(raw) {
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(raw);
  if (quoted) return quoted[2].replace(/\$\{[^}]*\}/g, "{param}");
  if (/^-?\d+(?:\.\d+)?$/.test(raw) || raw === "true" || raw === "false") return raw;
  return "{param}";
}

/** 从选项实参里取 `query: {...}` → `a=1&b={param}`（键升序，无则空串）。
    只看选项对象的**直接**键，所以 `body: { query: ... }` 不会被误认成 query 选项。 */
function queryString(optionsText) {
  const trimmed = (optionsText || "").trim();
  if (!trimmed.startsWith("{")) return "";
  const close = matchBracket(trimmed, 0);
  if (close < 0) return "";
  const pairs = [];
  for (const entry of splitTopLevel(trimmed.slice(1, close))) {
    const c = topLevelIndex(entry, ":", 0);
    if (c < 0 || entry.slice(0, c).trim() !== "query") continue;
    const inner = entry.slice(c + 1).trim();
    if (!inner.startsWith("{")) continue;
    const innerClose = matchBracket(inner, 0);
    if (innerClose < 0) continue;
    for (const kv of splitTopLevel(inner.slice(1, innerClose))) {
      const p = topLevelIndex(kv, ":", 0);
      if (p < 0) continue;
      const key = kv
        .slice(0, p)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key) pairs.push([key, optionValue(kv.slice(p + 1).trim())]);
    }
  }
  if (!pairs.length) return "";
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/* Api 客户端（web/api-client.js → window.AudioCppHub.api）的辅助方法 → HTTP 动词。
   list / poll 内部都走 get，故按 GET 记；request 是原语，动词要看 method 选项。 */
const API_VERBS = { get: "GET", post: "POST", put: "PUT", del: "DELETE", list: "GET", poll: "GET" };
const API_HELPERS = [...Object.keys(API_VERBS), "request"];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 找出本文件里指向 API 客户端的接收者名：
      - 约定名 `Api`
      - `const Api = window.AudioCppHub.api` 之类的本地别名
      - `import { Api } from "./api.js"`（模块经 web/modules/api.js 绑定后的写法）
    再由调用处补上 `AudioCppHub.api.<helper>` 全限定形式。 */
function apiReceivers(code) {
  const names = new Set(["Api"]);
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:window\s*\.\s*)?AudioCppHub\s*\.\s*api\b/g
  )) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'][^"']*\/api\.js["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** 从 JS 源收集 API 端点（method + 归一化 path + 来源）。
    同时认两种调用风格，抽到的调用点按实参左括号下标去重（同一处只登记一次）：
      - 迁移前遗留：fetch("/api/x", { method: "POST", ... })
      - 迁移后：Api.post("/api/x", body, opts)，Api 为 window.AudioCppHub.api 的别名 */
function parseEndpoints(scripts) {
  const map = new Map();
  const add = (method, p, source) => {
    if (!p || !p.startsWith("/")) return;
    if (!map.has(`${method} ${p}`))
      map.set(`${method} ${p}`, { method, path: p, sources: new Set() });
    map.get(`${method} ${p}`).sources.add(source);
  };
  for (const { name, code } of scripts) {
    const masked = maskSource(code);
    /* 调用点 → 文本片段 + 动词（null = 自行按 method 选项推断）；
       调用点下标取自 masked.code（只含真代码），片段取自 masked.text（保留字面量） */
    const sites = new Map();
    const record = (open, helper) => {
      if (sites.has(open)) return;
      const close = matchBracket(masked.text, open);
      if (close < 0) return;
      sites.set(open, { callText: masked.text.slice(open, close + 1), helper });
    };
    /* 风格一：裸 fetch（#108 之后会归零，但清单必须同时认这两种） */
    for (const m of masked.code.matchAll(/\bfetch\s*\(/g)) record(m.index + m[0].length - 1, null);
    /* 风格二：Api.<helper>(...)（含 AudioCppHub.api 全限定与本地别名）。
       别名发现要读 text：import 的 "./api.js" 说明符在 code 视图里已被掩码。 */
    const targets = [...apiReceivers(masked.text).map(escapeRe), "AudioCppHub\\s*\\.\\s*api"].join(
      "|"
    );
    const callRe = new RegExp(`\\b(?:${targets})\\s*\\.\\s*(${API_HELPERS.join("|")})\\s*\\(`, "g");
    for (const m of masked.code.matchAll(callRe)) record(m.index + m[0].length - 1, m[1]);

    for (const { callText, helper } of sites.values()) {
      const args = callArgs(callText);
      if (!args.length) continue;
      const paths = pathsFromArg(args[0]).filter(Boolean);
      if (!paths.length) continue;
      const methods = helper && helper !== "request" ? [API_VERBS[helper]] : methodsFrom(callText);
      /* query 选项是末位实参（Api.get(path, opts) / Api.post(path, body, opts)） */
      const query = queryString(args[args.length - 1]);
      for (let i = 0; i < paths.length; i++) {
        const p = normalizePath(paths[i]);
        const suffix = query ? (p.indexOf("?") >= 0 ? `&${query}` : `?${query}`) : "";
        if (methods.length === paths.length) add(methods[i], p + suffix, name);
        else for (const method of methods) add(method, p + suffix, name);
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
  return [...dedup.values()].sort(
    (a, b) => a.key.localeCompare(b.key) || a.source.localeCompare(b.source)
  );
}

export function buildInventory() {
  const html = read(INDEX_HTML);
  const scripts = SCRIPTS.map((name) => ({
    name: `web/${name}`,
    code: read(path.join(WEB_DIR, name))
  }));
  const { panels, controls, dataHooks } = parseHtml(html);
  const handlerMap = parseHandlers(scripts);

  const controlsOut = controls.map((c) => {
    const ev = handlerMap.get(c.id);
    const handlers = ev
      ? [...ev.entries()]
          .map(([event, sources]) => ({ event, sources: [...sources].sort() }))
          .sort((a, b) => a.event.localeCompare(b.event))
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
  L.push(
    "> 由 `npm run ui:inventory` 从 `web/index.html` 与 `web/*.js`、`web/modules/*.js` 自动生成，请勿手改。"
  );
  L.push("> 漂移检查：`npm run ui:inventory:check`（CI 会跑）。");
  L.push("");
  L.push(
    `来源：\`${inv.generatedFrom.indexHtml}\` + ${inv.generatedFrom.scripts.map((s) => `\`${s}\``).join("、")}`
  );
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
  L.push('说明：上表由源码中的 `e.key === "..."` 判定推导；Escape 用于关闭最上层弹窗 / 菜单，');
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

export async function generate() {
  const inv = buildInventory();
  return {
    /* 走与 `prettier --check .` 同一份配置（.prettierrc），否则生成器与格式检查
       会因 printWidth 等选项不一致而互相打架。 */
    json: await prettier.format(JSON.stringify(inv), {
      ...(await prettier.resolveConfig(OUT_JSON)),
      parser: "json"
    }),
    markdown: renderMarkdown(inv),
    inventory: inv
  };
}

export async function writeInventory() {
  const { json, markdown } = await generate();
  fs.writeFileSync(OUT_JSON, json);
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, markdown);
  return { OUT_JSON, OUT_MD };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { OUT_JSON: j, OUT_MD: m } = await writeInventory();
  const inv = buildInventory();
  console.log(
    `ui inventory written: ${path.relative(ROOT, j)} (${inv.panels.length} panels, ${inv.controls.length} controls, ${inv.endpoints.length} endpoints)`
  );
  console.log(`docs written: ${path.relative(ROOT, m)}`);
}
