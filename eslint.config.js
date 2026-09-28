/* audio.cpp-hub 前端 ESLint 扁平配置（flat config）。
 *
 * 目标：web/ 下无构建、无框架的浏览器脚本。规则集刻意保持精简——
 * 只收「几乎不会误报 + 真的能挡住 bug」的规则，避免开发者为了消警告而写 eslint-disable。
 *
 * web/ 现在分两类，规则集相同、只差 sourceType 与 globals：
 *   - 经典脚本（i18n.zh/en.js / i18n.js / api-client.js / wav.js / file-browser.js /
 *     legacy-globals.js / motion.js / pwa.js / audio-picker.js / voice-select.js /
 *     voices-panel.js）：sourceType "script"，跨文件靠 window.* 通信，公开接口在
 *     下方 globals 里逐个声明；
 *   - ES 模块（web/app.js + web/modules/*.js）：sourceType "module"，
 *     跨文件靠 import/export，额外启用 import/export 一致性检查。
 *
 * e2e/ + test/ + scripts/ 是第三类：Node 侧代码（ESM 与 CommonJS 各一个 block），
 * 规则集与 web/ 的模块 block 相同，只把 globals 换成 globals.node。详见各 block 注释。
 *
 * 规则集抽成 SHARED_RULES 由各 block 各自展开：flat config 的 rules 不会跨
 * block 继承，而第一个 block 用 ignores 把模块排除掉了，所以必须显式共享。
 *
 * 运行期不受影响：ESLint 不改写文件，web/ 仍由 Go 的 http.FileServer 直接提供。
 */
import js from "@eslint/js";
import globals from "globals";

/* 两类脚本共用的规则集。差异只有两处，由各 block 单独覆盖：
   no-implicit-globals（经典脚本刻意用顶层 const/let 当全局 → 关；模块 → 报错）
   与 no-redeclare（经典脚本允许顶层实现与 globals 声明共存 → builtinGlobals:false）。 */
const SHARED_RULES = {
  ...js.configs.recommended.rules,

  /* --- 正确性 --- */
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-var": "error",
  "prefer-const": "error",
  /* 未使用的 catch 绑定是本仓库的既有写法（catch (e) { /* 忽略：... *\/ }），
     改成可选 catch 绑定是纯风格改动，不值得为它改 13 处代码，故不报。
     未使用的函数参数同理（大量事件回调签名要求形参存在）。 */
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
  "no-undef": "error",
  "no-redeclare": ["error", { builtinGlobals: false }],
  "no-const-assign": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-unreachable": "error",
  "no-self-assign": "error",
  "no-cond-assign": "error",
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-fallthrough": "error",
  "no-sparse-arrays": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-obj-calls": "error",
  "no-unsafe-negation": "error",
  "no-class-assign": "error",
  "no-dupe-class-members": "error",
  "no-new-symbol": "error",
  "no-this-before-super": "error",
  "getter-return": "error",
  "require-yield": "error",
  "no-async-promise-executor": "error",
  "no-misleading-character-class": "error",
  "no-control-regex": "error",
  "no-useless-escape": "off", // 正则里的 \" / \' 出现在模板字符串与选择器中很常见
  "no-prototype-builtins": "error",
  "no-unused-expressions": "error",
  "no-multi-spaces": "off", // 例外：行尾注释按列对齐，见下方「排版」段
  /* 具名函数不留空格（function name(），匿名函数表达式留空格（(function () {})）——
     现有代码两种写法都在用，故按形式区分。 */
  "space-before-function-paren": [
    "error",
    { named: "never", anonymous: "always", asyncArrow: "ignore" }
  ],
  "no-multiple-empty-lines": ["error", { max: 2, maxEOF: 0 }],

  /* --- 排版 ---
   * web/ 不在 Prettier 的检查范围内（原因见 .prettierignore / web/README.md），
   * 所以 web/ 的排版约束改由 ESLint 承担。以下规则实测在现有代码上零违规。
   */
  quotes: ["error", "double", { avoidEscape: true, allowTemplateLiterals: true }],
  semi: ["error", "always"],
  "comma-dangle": ["error", "never"],
  "object-curly-spacing": ["error", "always"],
  "key-spacing": "error",
  "space-infix-ops": "error",
  "keyword-spacing": "error",
  "space-before-blocks": "error",
  "eol-last": "error",
  "no-trailing-spaces": "error",

  /* --- 两处刻意的手写排版（关闭理由即风格本身） ---
   * 1) indent：IIFE 函数体不缩进（`() => {` 之后顶格，见 audio-picker.js / voices-panel.js）。
   *    开启会产生约 837 条违规。
   * 2) no-multi-spaces：行尾注释按列对齐（`this.value = null;          // 当前音频的服务器绝对路径`）。
   *    开启会产生 18 条违规。
   * 二者合计正是 Prettier 无法复现本仓库排版的原因。
   */
  indent: "off",

  /* --- 刻意允许 --- */
  "no-console": "off", // 排障时前端允许 console
  curly: ["error", "multi-line"],
  "no-lonely-if": "error",
  "no-multi-assign": "off",
  "operator-linebreak": "off"
};

/* Node 侧代码（e2e / test / scripts）的规则集 = web/ 的共享规则集 + 一处替换：
   no-implicit-globals 打开——这三个目录全是 ESM，模块不会产生隐式全局。 */
const NODE_RULES = {
  ...SHARED_RULES,
  "no-implicit-globals": "error",
  /* import / export 卫生：重复 import、拼错的路径会与 no-undef 一起报出来。
     no-duplicate-imports 在同一模块多次 import 同一文件时报错。 */
  "no-duplicate-imports": "error"
};

export default [
  {
    // 工具链自身的配置文件由 node 加载，跳过
    ignores: ["node_modules/**", "web/globals.d.ts"]
  },

  /* ---- web/ 下的浏览器经典脚本 ---- */
  {
    files: ["web/**/*.js"],
    ignores: ["web/app.js", "web/modules/**/*.js"],
    languageOptions: {
      // 经典脚本：非 ES module，顶层 this === window
      sourceType: "script",
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        // 各 web/*.js 挂到 window.* 的公开接口（与 web/globals.d.ts 一一对应）
        I18N: "readonly",
        WavUtil: "readonly",
        FileBrowser: "readonly",
        AudioPicker: "readonly",
        VoiceSelect: "readonly",
        refreshVoiceSelects: "readonly",
        openVoicesPanel: "readonly",
        closeVoicesPanel: "readonly",
        // legacy-globals.js 挂到 window 的桥接口：voices-panel.js / audio-picker.js 直接引用
        $: "readonly",
        el: "readonly",
        showToast: "readonly",
        focusDialog: "readonly",
        restoreDialogFocus: "readonly",
        parseApiError: "readonly",
        renderStateError: "readonly",
        renderEmptyState: "readonly"
      }
    },
    rules: {
      ...SHARED_RULES,
      "no-implicit-globals": "off", // 顶层 const/let 在经典脚本里刻意作为跨文件全局
      "no-import-assign": "off" // 经典脚本没有 import
    }
  },

  /* ---- e2e/ + test/ + scripts/ 下的 Node 侧代码：Node ESM ----
   * 覆盖 e2e 下的 .mjs、test 下的 .mjs、scripts 下的 .mjs 与 .js（见下方 files）。
   *
   * 规则集与 web/ 的模块 block 完全一致，只把 globals 换成 Node：
   *   - 没有浏览器全局（window / document / localStorage 一律 no-undef），
   *     否则「在页面里能跑、在 Node 里是野变量」这类问题会被静默放过；
   *   - e2e/*.spec.mjs 显式 import { test, expect } from "@playwright/test"，
   *     不依赖 Playwright 注入的全局，所以不需要额外的 eslint 插件
   *     （本仓库不引入 eslint-plugin-playwright：它带来的 autofix 建议会诱导
   *     开发者删掉显式 import，而显式 import 正是这里想要的）。
   */
  {
    files: ["e2e/**/*.mjs", "test/**/*.mjs", "scripts/**/*.mjs", "scripts/**/*.js"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2022,
      globals: { ...globals.node }
    },
    rules: NODE_RULES
  },

  /* ---- scripts/*.cjs：CommonJS（gen-icons.cjs / record-demos.cjs）---- */
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      ecmaVersion: 2022,
      globals: { ...globals.node }
    },
    rules: {
      ...NODE_RULES,
      "no-implicit-globals": "off" // CommonJS 顶层 const/let 是模块作用域内的局部声明
    }
  },

  /* ---- scripts/axe-audit.js：Node 驱动 + 注入页面的回调 ----
   * 这个文件里同时存在两种代码：Node 侧的启动/编排，以及 page.evaluate /
   * page.waitForFunction 里「在浏览器上下文执行」的回调。后者合法地用到 window 与
   * document。对这两个名字做显式声明（与上面 web/ block 声明 I18N / WavUtil 同一手法），
   * 而不是把整个 browser globals 打开——后者会让 Node 侧的拼写错误也一起消失。
   */
  {
    files: ["scripts/axe-audit.js"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly" }
    }
  },

  /* ---- 唯一的单规则降级：scripts/ui-inventory.mjs 的 curly ----
   * 该文件由另一条工作流独占，本 PR 不能改它。里面有 3 处
   * 「if/for 的单条语句体被 Prettier 换到下一行」（第 111、114、329 行），
   * curly:"multi-line" 会把这 3 处报成缺花括号。降级范围精确到「这个文件的这一条
   * 纯风格规则」——文件仍然完整接受 no-undef / no-unused-vars / no-prototype-builtins
   * 等全部正确性规则的检查。
   * 债务清零后请把本 block 整体删掉：给第 111、114、329 行的语句体补上花括号即可。 */
  {
    files: ["scripts/ui-inventory.mjs"],
    rules: { curly: "off" }
  },

  /* ---- web/app.js + web/modules/*.js：ES 模块 ----
   *
   * 规则集与上面的经典脚本一致，只把 sourceType 换成 module 并去掉「隐式全局」豁免：
   * 模块里的顶层 const/let 不再是全局，跨文件必须走 import / export，
   * 这正是拆模块之后 no-undef 能真正兜住拼写错误的原因。
   */
  {
    files: ["web/app.js", "web/modules/**/*.js"],
    languageOptions: {
      sourceType: "module",
      ecmaVersion: 2022,
      // 只给仍以 window 形式存在的运行期资产：I18N / WavUtil / FileBrowser /
      // AudioPicker / VoiceSelect 是经典脚本挂的全局，其余一律来自 import。
      globals: {
        ...globals.browser,
        I18N: "readonly",
        WavUtil: "readonly",
        FileBrowser: "readonly",
        AudioPicker: "readonly",
        VoiceSelect: "readonly",
        openVoicesPanel: "readonly",
        closeVoicesPanel: "readonly",
        refreshVoiceSelects: "readonly"
      }
    },
    rules: {
      ...SHARED_RULES,
      "no-implicit-globals": "error", // 模块不会产生隐式全局
      /* import / export 卫生：重复 import、拼错的路径都会在这里与 no-undef 一起报出来。
         no-duplicate-imports 在同一模块多次 import 同一文件时报错——本仓库每个依赖只写一条。 */
      "no-duplicate-imports": "error"
    }
  }
];
