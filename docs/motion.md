# 动效系统（issue #76）

audio.cpp-hub 前端为无构建的原生 HTML/CSS/JS，动效全部由 CSS 令牌 + 少量
类切换实现。核心原则：

- **只动 `transform` / `opacity`**（合成层，不触发重排/重绘）；例外是进度条
  宽度与 `details` 高度，由 CSS 过渡承担。
- **动效预算**：时长不超过 `--dur-3`（320ms）；同一时刻只做一件事，避免
  叠加弹跳/旋转；列表进入动画只在「首次出现」时播放（`markRowEnter`）。
- **可关闭**：`prefers-reduced-motion: reduce` 下关闭所有非必要动效，仅保留
  加载 / 工作中等必要反馈（见文末）。

## 令牌

定义在 `web/style.css` 顶部：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--dur-1` | 120ms | 即时反馈：按压、hover、图标 |
| `--dur-2` | 200ms | 常规过渡：对话框、toast、列表行、展开 |
| `--dur-3` | 320ms | 较长位移：抽屉、进度条、状态强调 |
| `--ease-out` | `cubic-bezier(0.22,1,0.36,1)` | 进入 / 展开（默认） |
| `--ease-in-out` | `cubic-bezier(0.4,0,0.2,1)` | 循环 / 流光 |

## 模式清单

| 模式 | 实现 | 何时使用 |
| --- | --- | --- |
| 对话框淡入 + 缩放 | `.modal-overlay` / `.modal`（`opacity` + `translateY(12px) scale(.98)`） | 启动模型、设置、下载等 modal 开合 |
| 全屏面板进入 | `#history-panel/#voices-panel .history-panel-card`（`opacity` + 位移） | 历史 / 音色库全屏面板 |
| 抽屉滑入 | 窄屏 `#left`（`translateX(-105%→0)`）+ `.drawer-overlay` 淡入 | 移动端左侧菜单 |
| toast 滑入/滑出 | `.toast` 的 `toast-in` / `.toast.leaving` 的 `toast-out` | 操作结果、错误提示 |
| 高度展开 | 原生 `<details>` + `interpolate-size:allow-keywords` 动画 `block-size`；不支持时瞬时展开 | 高级参数、说话人折叠区 |
| 详情面板进入 | `.history-detail` 的 `expand-soft`（淡入 + 轻微下移） | 用户点开历史「详情」时 |
| 列表行进入 | `.row-enter` + `row-in`（`opacity` + `translateY(5px)`） | 下载/任务/历史行首次出现 |
| 按钮按压 | `button:active { transform: scale(.97) }`，`.btn` 叠加 `translateY` | 所有按钮 |
| 复制确认 | `button.copied` + `copy-pop`（由 `motion.js` 触发，边框转 `--ok`） | ASR 复制等复制按钮 |
| 实例状态强调 | `.state-flip`（`motion.js` 观察 `#instance-pill` class 变化） | 无就绪 → 就绪等状态翻转 |
| 任务状态反馈 | `.badge.generating` 的脉冲圆点 + `.busy-elapsed` 计时 + `.task-row .history-meta` 主色文字；状态由轮询 / SSE 替换行内容 | 排队 → 运行 → 完成/失败 |
| 主题切换过渡 | `html.theme-switching` 下主要面板补 `background/border/color` 过渡 | 切换深浅色 |
| 加载旋转 | `.spinner` 的 `spin`（`.badge.working::before` 同款，保留给 styleguide 的组件示例） | 任务等待、实例工作中 |
| 启动脉冲 | `.badge.starting` 的 `pulse` | 实例 STARTING |
| 不确定进度 | `.dl-progress-fill.indeterminate` 的 `shimmer` 流光 | 大小未知的下载 |
| 进度增长 | `.dl-progress-fill` 的 `width` 过渡 + `.row-enter` 的 `bar-grow` | 已知百分比的下载 |
| 骨架屏 | `.skeleton` 的 `skeleton-sweep`（通用工具类） | 内容加载占位 |
| 波形播放头 | `audio-picker.js` 在 `timeupdate`/`rAF` 中重绘 canvas | 音频裁剪、试听 |
| 可见焦点 | `:focus-visible` 外描边（不覆盖既有自定义样式） | 键盘导航 |

## 微交互触发（`motion.js`）

`web/motion.js` 只负责「何时加类」，不改变业务逻辑，并暴露
`window.hubMotion.flash(el, cls, ms)`：

- **复制确认**：捕获阶段委托 `#asr-copy, [data-copy-flash]` 点击。
- **主题切换**：监听 `themechange` 给 `<html>` 加 `.theme-switching`。
- **实例状态**：`MutationObserver` 观察 `#instance-pill` 的 `class` 变化。
  （实例列表每 2s 重建，不适合逐行观察，故只强调状态条。）

## 已知取舍：列表行的状态过渡

侧栏任务/历史行、实例卡片、下载行由 2s 轮询按「签名」复用或重建 DOM。为
避免整列表反复闪动，进入动画只对「首次出现」的行播放（`markRowEnter` 记录
`enteredRows`）。因此**行内的状态文字/徽标切换无法用 CSS transition 平滑过渡**
（节点常被替换），状态变化改由颜色（`.badge.ready/.starting/.error`）、
`.badge.generating` 的脉冲圆点、`.state-flip`（实例状态条）等「无过渡但清晰」的方式表达。
这是刻意的动效预算取舍，不是缺陷。

## 无障碍 / 减少动态效果

`web/style.css` 末尾的 `@media (prefers-reduced-motion: reduce)`：

- 全局把 `animation-duration` / `transition-duration` 压到 `0.01ms`，迭代次数 1。
- **例外保留**（必要反馈，略放慢而非静止）：`.spinner`、`.badge.working::before`、
  `.badge.starting`。
- 「生成中…」的脉冲圆点（`.badge.generating::before` 的 `badge-dot`）是装饰，
  与其它纯装饰一样 `animation: none` 降级为常亮点——徽标文字与计时本身已是状态反馈。
- 纯装饰（流光 `.skeleton`、`expand-soft`、`state-flip`、`copy-pop`、PWA 提示条）
  一律 `animation: none`。
- `motion.js` 在减少动态效果时不加运动类（只保留颜色/文本变化）。

> 新增动效时：先复用上表模式；确需新增则在 `style.css` 末尾「动效系统补充」
> 一节追加，并同步补 reduced-motion 关闭规则与本文档。
