/* audio.cpp-hub 前端 ESLint 扁平配置（flat config）。
 *
 * 目标：web/ 下无构建、无框架的经典浏览器脚本。规则集刻意保持精简——
 * 只收「几乎不会误报 + 真的能挡住 bug」的规则，避免开发者为了消警告而写 eslint-disable。
 *
 * 运行期不受影响：ESLint 不改写文件，web/ 仍由 Go 的 http.FileServer 直接提供。
 */
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    // 工具链自身的配置文件由 node 加载，跳过
    ignores: ["node_modules/**", "web/globals.d.ts"]
  },

  /* ---- web/ 下的浏览器经典脚本 ---- */
  {
    files: ["web/**/*.js"],
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
        // app.js 的顶层声明，被 voices-panel.js 等同目录脚本直接引用
        $: "readonly",
        showToast: "readonly"
      }
    },
    rules: {
      ...js.configs.recommended.rules,

      /* --- 正确性 --- */
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-implicit-globals": "off", // 顶层 const/let 在经典脚本里刻意作为跨文件全局
      /* 未使用的 catch 绑定是本仓库的既有写法（catch (e) { /* 忽略：... *\/ }），
         改成可选 catch 绑定是纯风格改动，不值得为它改 13 处代码，故不报。
         未使用的函数参数同理（大量事件回调签名要求形参存在）。 */
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
      "no-undef": "error",
      /* 经典脚本刻意在文件顶层实现「全局」（app.js 的 $ / showToast 等），
         builtinGlobals:false 允许这种实现与 globals 声明共存。 */
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
      "no-import-assign": "off", // 无 import
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
    }
  }
];
