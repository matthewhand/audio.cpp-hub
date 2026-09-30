# docs/media — 演示素材

本目录存放由脚本从**真实运行的 hub** 录制的演示短片与海报帧，用于 README /
发布说明。目录内**不提交伪造素材**：脚本只连接真实实例录制，未运行前这里只有
本 README。

## 生成

```bash
# 1. 启动 audio.cpp-hub（默认 18080），确保浏览器能访问
# 2. 录制（需要 Playwright + Chromium；ffmpeg 用于 WebM → GIF/MP4）
HUB_URL=http://127.0.0.1:18080 node scripts/record-demos.cjs

# 可选
node scripts/record-demos.cjs --list                 # 列出场景
node scripts/record-demos.cjs --scenario=tts         # 只录一个场景
node scripts/record-demos.cjs --poster-only          # 只截海报帧（不产生视频）
node scripts/record-demos.cjs --reduced-motion       # 以 reduced-motion 渲染并录像
```

场景：`tts`、`instance-start`、`history`、`downloads`、`theme-switch`。

依赖安装（若缺失）：

```bash
npm i -D playwright && npx playwright install chromium
```

脚本会先在本地 `node_modules`、再在 `~/.npm/_npx/*/node_modules` 缓存中查找
Playwright。hub 不可达 / Playwright 缺失 / Chromium 启动失败时脚本报错退出，
**不生成任何文件**。

## 产出

| 文件 | 说明 |
| --- | --- |
| `<name>.webm` | Playwright 原始录像 |
| `<name>.gif` / `<name>.mp4` | ffmpeg 转码（GIF 12fps 960 宽；MP4 H.264，无音轨） |
| `<name>.poster.png` | 海报帧（用于 `<video poster>` 或静态回退） |
| `<name>.reduced.poster.png` | `--reduced-motion` 下的海报/录像后缀 |

## reduced-motion

传入 `--reduced-motion` 时浏览器上下文以 `reducedMotion:"reduce"` 启动，CSS 会
关闭非必要动画（见 `docs/motion.md`）。生成的低动版本与海报帧可用于：
`<video poster>` 静态回退、或在文档中为「减少动态效果」读者提供无动画图。

## 提交策略

**本目录的 WebM + 海报帧已随仓库提交**（README 用 `<video preload="none">` 引用，
首屏不整段加载）。原因是它们是**唯一**演示 `启动实例` / `主题切换` 两个场景的素材，
且总体约 4 MB，远小于旧 GIF。

- **WebM + poster**：已提交，供 README / 发布说明引用。
- **GIF / MP4**：体积大（同一场景 3–4 MB），默认**不提交**，按需本地生成或分渠道分发。
  重新录制时用 `--gif` / `--mp4` 产出即可。
- **`tts` 场景**：`tts.webm` 约 4.4 MB 偏大，GIF 更大（约 9 MB），因此本目录的
  `tts.*` 一律不提交（`.gitignore` 已排除）；README 的 TTS 演示仍以
  `docs/assets/hub-tts.gif` 为准。重录：`node scripts/record-demos.cjs --scenario=tts`。
- 切勿提交占位/伪造内容：脚本只连接真实实例录制。

