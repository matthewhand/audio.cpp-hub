# PWA（issue #68）

无构建步骤：新增文件均由 Go 的 `staticHandler` 直接从 `web/` 提供，页面用
`<link>` / `<script src>` 加载，满足 CSP `script-src 'self'`（无内联脚本/样式）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `web/manifest.webmanifest` | Web App Manifest（standalone、主题色、图标） |
| `web/icons/*.png` | 由 `scripts/gen-icons.cjs` 从根目录 `icon.ico` 生成 |
| `web/sw.js` | Service Worker（缓存策略见下） |
| `web/pwa.js` | 注册 SW、更新提示、`theme-color` 跟随主题 |
| `web/offline.html` | 导航离线时的回退页 |
| `web/motion.js` | 微交互（与 PWA 同批加载，见 `docs/motion.md`） |

`index.html` 新增：`<link rel="manifest">`、`<meta name="theme-color">`、
图标 `<link>`，以及 `<script src="/motion.js">`、`<script src="/pwa.js">`。

## 缓存策略（`web/sw.js`）

- **静态资源**（`.css/.js/.mjs/.json/.webmanifest/图片/字体`）：**cache-first**
  + 后台再验证（stale-while-revalidate）。命中即回缓存，同时异步拉取更新。
- **导航请求**（`req.mode === "navigate"`）：**network-first**；失败回退缓存的
  `index.html`，再回退 `offline.html`。
- **`/api/*` 与 `/v1/*`：network-only，绝不缓存**。`fetch` 处理器在扩展名判断
  之前先拦截这两个前缀并直接 `return`（不调用 `respondWith`），确保模型输出、
  TTS/ASR 结果、代理响应、音频接口都不进入 Cache Storage。
- 其它同源 GET：network-first，失败回退运行时缓存。
- 非 GET、跨域请求：不介入。

预缓存清单为应用外壳（`/`、`index.html`、各 JS/CSS、manifest、图标、离线页），
用 `Promise.allSettled` 逐项缓存，个别资源缺失不会导致整次安装失败；预缓存请求
带 `cache: "reload"` 绕过 HTTP 缓存。

## 版本方案

`sw.js` 内 `CACHE_VERSION = "v1"`：

- 发布时递增该值 → `sw.js` 字节变化 → 浏览器安装新 SW。
- `activate` 阶段删除所有 `acpp-*` 前缀但非当前版本的缓存，再 `clients.claim()`。
- 因文件名不带 hash，缓存版本号是「何时替换静态资源」的唯一开关，**务必随发布递增**。

## 更新提示

- 新 SW 安装完成进入 `waiting`（`install` 中**不**自动 `skipWaiting`）；仅当
  已有 controller（即非首次安装）时，`pwa.js` 才在页面底部弹出可关闭的
  `#pwa-update` 提示条。
- 点击「刷新」→ `postMessage({type:"SKIP_WAITING"})` → `sw.js` 调 `skipWaiting()`
  → 页面在 `controllerchange` 后 `location.reload()`。
- 点击「稍后」用 `sessionStorage` 记住，本会话不再提示。
- 首次安装无 controller，不弹提示，SW 直接激活。

## 离线回退

导航失败时回退 `index.html` / `offline.html`。`offline.html` 为静态页，仅用
`style.css`，无脚本，提供「重试 / Retry」链接。API 一律不缓存，因此离线时
模型列表/历史等会如实报错，不会展示过期数据。

## 图标生成

```
node scripts/gen-icons.cjs
```

- 依赖 **ffmpeg**（开发环境已具备），从根目录 `icon.ico`（内含 64×64 PNG）放大生成：
  `icon-192/512.png`（透明背景）、`icon-maskable-192/512.png`（图形缩至安全区
  62% + 反差底色）、`apple-touch-icon-180.png`。
- maskable 底色按源图不透明像素平均亮度自动选深浅，保证安全区对比。
- 源图仅 64×64，512 会偏软；如需锐利图标请换更高分辨率源图后重跑脚本。
- 无 ffmpeg 时可用 Playwright 将源图渲染进 canvas 后 `toDataURL` 导出（替代方案，
  本脚本不自动回退）。

## Go 端 Content-Type 现状（未修改 Go）

`staticHandler` 使用 `http.ServeContent`，Content-Type 由 `mime.TypeByExtension`
再嗅探决定：

- **`.js`**：Go 内置 mime 表映射为 `text/javascript; charset=utf-8`，Linux/macOS
  正确。Windows 上 Go 会先查注册表，历史上 `.js` 注册为 `text/plain`，可能被
  覆写为 `text/plain`；本应用加载的是经典脚本（非 module），浏览器仍会执行
  （有控制台告警），但属潜在风险。
- **`.webmanifest`**：**不在 Go 内置 mime 表中**。Linux 若 `/etc/mime.types` 含
  `application/manifest+json webmanifest`（本仓库开发机即如此）会正确返回；
  **Windows 注册表通常无此扩展名**，`mime.TypeByExtension` 返回空后退化为
  `http.DetectContentType` 嗅探，得到 `text/plain; charset=utf-8`。宽松浏览器
  （Chrome）可能仅告警，严格的浏览器（Firefox 等）会因 MIME 不符而**忽略 manifest**，
  PWA 安装/主题色等特性失效。这是当前明确的 Go 侧缺口。

后续建议（需改 Go，本次未动）：在 `staticHandler` 调 `ServeContent` 前显式补
（`ServeContent` 只在 Content-Type 为空时才自行推断，故预置即可覆盖）：

```go
switch path.Ext(p) {
case ".webmanifest":
    w.Header().Set("Content-Type", "application/manifest+json")
case ".js", ".mjs":
    w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
}
```

或在可执行文件旁提供 `mime.types` / 依赖系统注册表。另：`sw.js` 位于根路径，
默认作用域 `/`，无需 `Service-Worker-Allowed`。
