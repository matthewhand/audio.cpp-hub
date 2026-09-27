# web/ — 前端静态资源（无构建）

此目录是 audio.cpp-hub 的 Web UI：纯原生 HTML/CSS/JS，由 Go 的 `http.FileServer`
直接从工作目录的 `web/` 提供。**运行时不需要 Node.js、npm 或任何构建步骤**，
发布的单二进制也不包含前端构建产物。

根目录的 `package.json`、`eslint.config.js`、`tsconfig.json`、Prettier 配置及
`scripts/web-quality/` **仅供开发与 CI** 使用（lint / 格式化 / 类型检查），
不参与运行，也不需要随发行版分发。CI 见 `.github/workflows/ci.yml` 的
`frontend` 任务；Go 的 `quality` 任务与前端工具链互不影响。

## 开发命令（在仓库根目录执行，需 Node v22+）

```bash
npm install          # 仅安装 devDependencies（typescript / eslint / prettier）
npm run lint         # eslint（当前基线 0 error / 若干 warn）
npm run lint:fix
npm run format       # prettier --write
npm run format:check
npm run typecheck    # tsc 棘轮：不得超过 tsc-ratchet-baseline.txt 的错误数
```

`typecheck` 是**棘轮（ratchet）**而非全绿：`web/` 是允许 `checkJs` 的
JavaScript，当前仍有一批历史类型错误，其数量封顶在 `tsc-ratchet-baseline.txt`。
只允许错误数下降，不允许上升。修正一批错误后可跑
`node scripts/web-quality/tsc-ratchet.mjs --update` 收紧基线。

Prettier 通过根目录 `.prettierignore` 排除既有 `web/` 前端文件，仅检查本工具链
新增的文件，以保持 diff 可审阅。
