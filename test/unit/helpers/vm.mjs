/* 单元测试辅助：把仓库里的 classic script 与顶层函数安全地加载进 node:vm，
   无需改动前端（保持浏览器 no-build 语义）。 */
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);
export const webDir = path.join(repoRoot, "web");

export function readWeb(name) {
  return fs.readFileSync(path.join(webDir, name), "utf8");
}

/** 在独立 realm 中执行一段 classic script，返回其 sandbox（可读 window 上的导出）。 */
export function runClassic(source, sandbox = {}, filename = "classic.js") {
  const context = vm.createContext(sandbox);
  new vm.Script(source, { filename }).runInContext(context);
  return sandbox;
}

/**
 * 从源码中抽取顶层/嵌套的 `function NAME(...) { ... }` 声明（含花括号配平），
 * 并以表达式形式在 sandbox 中求值，返回函数引用。用于测试 web/ 里不可导入的纯函数。
 * `export ` 前缀是可选的：web/modules/*.js 的顶层绑定都带 export。
 */
export function extractFunction(source, name) {
  const re = new RegExp(`(?:^|\\n)[ \\t]*(?:export\\s+)?(function\\s+${name}\\s*\\()`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  const start = m.index + m[0].indexOf("function");
  const open = source.indexOf("{", start);
  const end = matchBrace(source, open);
  return source.slice(start, end + 1);
}

/** 返回与 openIndex 处 `{` 配平的 `}` 下标，跳过字符串 / 模板 / 注释 / 正则字面量。 */
export function matchBrace(source, openIndex) {
  const REGEX_PREFIX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";"]);
  let depth = 0;
  let i = openIndex;
  let mode = null; // "'" | '"' | '`' | "line" | "block" | "regex"
  let prevSig = "";
  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (mode === "line") {
      if (ch === "\n") mode = null;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") {
        mode = null;
        i++;
      }
      continue;
    }
    if (mode === "regex") {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "[") {
        while (i + 1 < source.length && source[i + 1] !== "]") {
          if (source[i + 1] === "\\") i++;
          i++;
        }
        i++;
        continue;
      }
      if (ch === "/") {
        mode = null;
        prevSig = "x";
      }
      continue;
    }
    if (mode) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === mode) mode = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      mode = "line";
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      mode = "block";
      i++;
      continue;
    }
    if (ch === "/" && (prevSig === "" || REGEX_PREFIX.has(prevSig))) {
      mode = "regex";
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      mode = ch;
      prevSig = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
    if (!/\s/.test(ch)) prevSig = ch;
  }
  throw new Error("unbalanced braces");
}

/** 把抽取出的函数声明求值为函数引用，deps 里的名字会注入 vm 上下文。 */
export function makeFunction(fnSource, deps = {}) {
  const context = vm.createContext({ ...deps });
  return new vm.Script(`(${fnSource})`, { filename: "extracted-fn.js" }).runInContext(context);
}

/**
 * 加载 web/modules/*.js 里的 ES 模块：剥掉 import 语句与 export 关键字后当 classic
 * script 在 sandbox 里求值，等价于浏览器加载该模块后的顶层效果，并把它的导出收进
 * sandbox.__module 返回。
 *
 * 为什么需要：web/ 无构建，模块是浏览器原生 ES module，node 无法直接 import
 * （它们 import 的是浏览器全局与彼此，循环依赖靠活绑定闭环）。测试只关心纯逻辑，
 * 于是把这些引用做成 sandbox 里的桩。不修改任何前端源码。
 */
export function loadEsModule(name, sandbox = {}) {
  const source = readWeb(name);
  const exported = new Set();
  for (const m of source.matchAll(
    /^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm
  )) {
    exported.add(m[1]);
  }
  const body = source
    .replace(/^import\s[\s\S]*?from\s*["'][^"']*["'];?[ \t]*$/gm, "")
    .replace(/^export\s+(?=(?:async\s+)?(?:const|let|var|function|class)\b)/gm, "");
  const context = vm.createContext(sandbox);
  new vm.Script(`${body}\n;globalThis.__module = { ${[...exported].join(", ")} };`, {
    filename: name
  }).runInContext(context);
  return sandbox.__module;
}

/**
 * 按 web/index.html 的实际顺序加载 i18n 三件套：先两份词典（写入
 * window.I18N_ZH / window.I18N_EN），再运行时 i18n.js。顺序反了 i18n.js 会读到
 * 空字典（t() 全部回落成 key 本身），所以这里必须与页面保持一致。
 * 返回 window.I18N。
 */
export function loadI18n(sandbox) {
  runClassic(readWeb("i18n.zh.js"), sandbox, "i18n.zh.js");
  runClassic(readWeb("i18n.en.js"), sandbox, "i18n.en.js");
  runClassic(readWeb("i18n.js"), sandbox, "i18n.js");
  return sandbox.window.I18N;
}

/**
 * 极简 I18N 桩，用于 makeFunction 注入被抽出的纯函数。
 * 只实现这些函数实际调用的成员（当前是 bytes），并记录入参，
 * 以便断言「委托给 I18N」这一契约而不依赖 ICU 的具体排版。
 */
export function makeI18nStub(impl) {
  const calls = [];
  return {
    calls,
    bytes(n) {
      calls.push(n);
      return impl ? impl(n) : `BYTES(${n})`;
    }
  };
}

/** 轻量 localStorage / navigator / document stub，供 i18n.js、wav.js 加载。 */
export function makeBrowserSandbox(overrides = {}) {
  const store = new Map();
  const documentElement = { lang: "" };
  const listeners = [];
  const sandbox = {
    window: {},
    navigator: { language: "zh-CN" },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      _dump: () => Object.fromEntries(store)
    },
    document: {
      documentElement,
      addEventListener: (evt, cb) => listeners.push([evt, cb]),
      querySelectorAll: () => [],
      hidden: false
    },
    ...overrides
  };
  return sandbox;
}
