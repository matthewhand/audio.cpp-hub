# web/ — 前端资产与开发期工具链

本目录是 **运行期零构建** 的前端资产：`index.html` 由 Go 的 `http.FileServer` 直接提供，
8 个 `.js` 以经典脚本（classic script）方式按 `index.html` 底部的 `<script src>` 顺序加载，
彼此通过 `window.*` 通信。**没有打包器、没有转译、没有模块解析步骤。**

## 运行期不依赖 Node

下载发行 zip、解压、`./audio.cpp-hub` 即可运行。不需要 `npm install`，没有 `dist/`，
仓库里的 `.js` 就是浏览器直接执行的 `.js`。

## 开发期工具链（仅本地 / CI）

`npm install` 后可用四个脚本（见根目录 `package.json`）：

| 脚本 | 作用 |
| --- | --- |
| `npm run check:types` | `tsc -p tsconfig.json`：`checkJs` + `noEmit`，对 `web/*.js` 做类型检查 |
| `npm run lint` | ESLint 10 扁平配置，针对无框架浏览器经典脚本 |
| `npm run format:check` | Prettier 校验（**范围见 `.prettierignore`，有意排除 `web/`**，见下） |
| `npm run format` | Prettier 重写（同样遵循 `.prettierignore`） |
| `npm run check` | 依次跑上面三项，CI 用的就是这个 |

`check:types` 用 `noEmit` 保证**不产出任何 JS**：`tsc` 在这里只是检查器，输出目录为空，
不可能被误当成构建产物进入发行包。

## 工具能查出什么

- **tsc**：未定义的标识符、参数个数不符、拼错的跨文件公开接口、死代码（未使用的局部变量）、
  `switch` 贯穿、`async` 误用。
- **ESLint**：`==`/`!=`（`== null` 除外）、`var`、可改的 `let`、未使用变量、
  不可达代码、重复键/参数、正则误用、恒真条件。
  另外因为 `web/` 不走 Prettier，`web/` 的**排版约束由 ESLint 承担**：
  引号（双引号）、分号、无尾逗号、对象花括号空格、键/运算符/关键字空格、
  文件末尾换行、行尾无空格、空行上限、具名函数不留空格而匿名函数留空格。
- **Prettier**：只覆盖 `.prettierignore` 范围外的文件——根目录 JSON 清单、
  CI workflow、工具链自身的 `.js`/`.d.ts`。

## 已知降级（显式声明，非静默关闭）

`web/globals.d.ts` 与 `.prettierignore` 里逐条写明了原因，这里汇总：

1. **`tsconfig.json` 未开启 `strict` / `strictNullChecks` / `noImplicitAny`。**
   `web/` 是无类型经典脚本，全局约 6100 行 DOM 操作代码。开启严格空值检查会产生上千条
   「`getElementById` 可能为 null」「`querySelector` 返回 `Element` 没有 `.value`」——这些既
   不可在不重写的前提下消除，也不指示任何缺陷。已保留的检查包括 `noUnusedLocals`、
   `noFallthroughCasesInSwitch`、`noImplicitOverride` 等有实际价值的项。

2. **`app.js` 的 `$()` / `el()` 用 JSDoc 标注返回 `any`。**
   它们是全文件最底层的 DOM 取值入口，约 3000 个调用点会立刻访问 `.value` / `.checked` /
   `.dataset` / `.onclick` 等「只有具体标签才声明」的成员。逐点加断言等于重写，因此显式放宽。

3. **`Element` / `EventTarget` 增补了 4 个成员**（`dataset`、`title`、`onclick`、`value`、
   `closest`）。`document.querySelectorAll(".tab")` 这类通用选择器无法推断标签，TypeScript 只能
   给回 `Element`，而 `Element` 按规范不声明这些成员——运行时它们确实都在。代价是
   `document.querySelector("div").value` 这类误用不再报错，属于有意接受的上限。

4. **`web/` 不在 Prettier 的检查范围内。**
   手写脚本的排版包含 Prettier 无法复现的两点：IIFE 函数体不缩进（`indent` 规则开启会产生
   **837 条**违规）、行尾注释按列对齐（`no-multi-spaces` 开启会产生 **18 条**违规）。
   统一排版需要重排约 2500 行 / 6100 行的纯空白改动（实测 `printWidth=120` +
   `arrowParens=avoid` 已是最小），无法人工审阅，收益仅为风格统一、无缺陷发现能力。
   改由 ESLint 的排版类规则承担约束（见上）。`docs/diagrams/**` 同样排除：那是绝对定位
   坐标 + 内联样式的手写 HTML，重排会破坏 `scripts/check-diagrams.py` 校验的可访问性契约。

降级**不会静默漂移**：新增的跨文件公开接口若在 `globals.d.ts` 里没声明，tsc 会立刻报
`Cannot find name`；新增的数组型字典键若没在 `I18NApi.t` 补重载，调用侧会报
`.forEach is not a function`。两者都是硬失败。

## 已知副作用：`go list ./...` 会走进 `node_modules`

Go 的 `./...` 包匹配会跳过 `.`/`_` 前缀与 `testdata` 目录，但**不跳过 `node_modules`**。
执行过 `npm install` 后，`go list ./...` / `go test ./...` 会多列出一个
`…/node_modules/flatted/golang/pkg/flatted`（某个依赖恰好附带 Go 源码）。

这是无害的：该包能正常编译，`go vet` / `go test` / `gofmt -l .` 结果均不受影响。
CI 也不受影响——`quality` job 从不执行 `npm ci`，`web-toolchain` job 不执行任何 Go 命令，
两者不会同时存在 `node_modules`。仅提示本地看到该多余条目时不必意外。

## 改动本目录后

```bash
npm install
npm run check          # 三项全过再提交
npm run format         # 仅当 format:check 失败时（注意范围不含 web/*.js）
```

`web/*.js` 的排版问题由 `npm run lint` 报告（`eslint web --fix` 可自动修大部分），
不在 `npm run format` 的范围内。

改动 `window.*` 的公开接口时，**同时**更新 `web/globals.d.ts`（供 tsc）与
`eslint.config.js` 的 `languageOptions.globals`（供 `no-undef`），并保证 `index.html`
底部的 `<script>` 顺序满足依赖关系。
