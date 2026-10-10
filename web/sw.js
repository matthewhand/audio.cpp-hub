/*
 * audio.cpp-hub Service Worker
 *
 * 缓存策略（对应 issue #68）：
 *   - 静态资源（CSS/JS/图标/manifest/离线页）：cache-first + 后台再验证（SWR）。
 *   - 导航请求（HTML）：network-first，失败回退缓存的 index.html，再回退 offline.html。
 *   - /api/* 与 /v1/*：network-only，绝不缓存（模型输出 / 接口响应可能很大或含隐私）。
 *   - 其它同源 GET：network-first，失败回退运行时缓存。
 *
 * 版本方案：
 *   CACHE_VERSION 变更即视为一次发布：sw.js 字节变化触发浏览器安装新 SW，
 *   新 SW 在 activate 时删除所有非当前版本的 acpp-* 缓存。发布时请递增。
 *
 * 更新流程：
 *   新 SW 安装完成进入 waiting（不自动 skipWaiting），由页面 pwa.js 弹出
 *   「新版本可用」提示；用户点击刷新后 postMessage({type:"SKIP_WAITING"})，
 *   本 SW 调用 skipWaiting()，client 在 controllerchange 后 reload。
 */

"use strict";

/* Service Worker 跑在与 window 不同的 realm。这里统一通过 sw 访问该 realm，
 * 类型由 web/globals.d.ts 的 HubServiceWorkerScope 提供（见该文件说明）。 */
const sw = /** @type {HubServiceWorkerScope} */ (/** @type {unknown} */ (self));

const CACHE_VERSION = "v1";
const STATIC_CACHE = `acpp-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `acpp-runtime-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

/* 应用外壳：安装时预缓存。逐项 allSettled，个别资源缺失不会让整次安装失败。
   列表必须与 web/index.html 的实际 script/link 引用、以及 index.html <head> 里的
   modulepreload 清单保持一致——漏一项不会让 install 失败，但离线首屏会在该脚本处断掉。
   改动前端入口时请同步这里；scripts/perf-budget.mjs 会校验三方一致。 */
const PRECACHE_URLS = [
  "/",
  "/index.html",
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/boot.js",
  "/i18n.zh.js",
  "/i18n.en.js",
  "/i18n.js",
  "/api-client.js",
  "/wav.js",
  "/legacy-globals.js",
  "/audio-picker.js",
  "/voice-select.js",
  "/motion.js",
  "/pwa.js",
  "/app.js",
  "/modules/dom.js",
  "/modules/async-ui.js",
  "/modules/state.js",
  "/modules/elapsed.js",
  "/modules/routing.js",
  "/modules/command-palette-lazy.js",
  "/modules/shell.js",
  "/modules/models.js",
  "/modules/settings-lazy.js",
  "/modules/file-browser-lazy.js",
  "/modules/launch.js",
  "/modules/instances.js",
  "/modules/task-events.js",
  "/modules/live-ticker.js",
  "/modules/last-take.js",
  "/modules/hub-chip.js",
  "/modules/junk.js",
  "/modules/activity.js",
  "/modules/char-count.js",
  "/modules/downloads-lazy.js",
  "/modules/tasks.js",
  "/modules/sidebar.js",
  "/modules/stats-lazy.js",
  "/modules/voices-panel-lazy.js",
  // 下面是懒加载 chunk（不在首屏，也不进 index.html 的 modulepreload）：各自只被对应
  // 外观层的 import("./x.js") 拉取，但离线冷启动点开时仍要能用，因此只进预缓存。
  "/modules/stats.js",          // 看板（#/stats）
  "/modules/file-browser.js",   // 服务器端文件选择器
  "/modules/voices-panel.js",   // 音色库管理面板
  "/modules/downloads.js",      // 下载管理弹窗 + 按模型下载弹窗
  "/modules/settings.js",       // 设置弹窗（通用 / HTTPS / 可执行文件列表）
  "/modules/command-palette.js", // 命令面板（Ctrl/Cmd-K）
  "/modules/panels.js",
  "/style.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png"
];

/* 可 cache-first 的静态资源扩展名（API 已在前面拦截，不可能命中这里）。 */
const CACHEABLE_EXT = /\.(?:css|js|mjs|json|webmanifest|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm)$/i;

/* 请求/响应的 Cache-Control 是否显式声明了不可缓存。 */
function noStore(headers) {
  try {
    const cc = (headers && headers.get && headers.get("cache-control")) || "";
    return /(^|,)\s*(no-store|no-cache)\s*(,|$)/.test(cc);
  } catch {
    return true; // 读不到头时按不可缓存处理，宁可不缓存也不缓存错
  }
}

/* 响应能否落盘：非 2xx、opaque、显式 no-store 一律不缓存。 */
function storable(res) {
  return Boolean(res && res.ok && res.type !== "opaque" && !noStore(res.headers));
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          // cache: "reload" 绕过 HTTP 缓存，保证外壳拿到最新字节
          cache.add(new Request(url, { cache: "reload" }))
        )
      )
    )
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("acpp-") && k !== STATIC_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") sw.skipWaiting();
});

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  // 只处理 GET；POST/PUT/DELETE 等写操作一律交给网络
  if (req.method !== "GET") return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  // 跨域请求不介入
  if (url.origin !== sw.location.origin) return;

  // ---- API / OpenAI 兼容代理：network-only，绝不缓存 ----
  const p = url.pathname;
  if (p === "/api" || p.startsWith("/api/") || p === "/v1" || p.startsWith("/v1/")) {
    return; // 不调用 respondWith → 浏览器按默认网络行为处理，SW 不缓存
  }

  // 服务端显式声明不可缓存的请求直接放行：即便将来新增了带 .json 等扩展名的
  // 接口，也不会被下面的 CACHEABLE_EXT 误判成静态资源而缓存下来。
  if (noStore(req.headers)) return;

  // ---- 导航：network-first ----
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, true));
    return;
  }

  // ---- 静态资源：cache-first + 后台再验证 ----
  if (CACHEABLE_EXT.test(p)) {
    event.respondWith(cacheFirst(req));
    return;
  }

  event.respondWith(networkFirst(req, false));
});

async function networkFirst(req, isNavigate) {
  try {
    const res = await fetch(req);
    if (storable(res)) {
      const copy = res.clone();
      caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (isNavigate) {
      return (
        (await caches.match("/index.html")) || (await caches.match(OFFLINE_URL)) || Response.error()
      );
    }
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) {
    // 后台再验证：命中后异步拉取更新，失败静默忽略
    fetch(req)
      .then((res) => {
        if (storable(res)) caches.open(STATIC_CACHE).then((c) => cachePut(c, req, res));
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (storable(res)) {
      const copy = res.clone();
      caches.open(STATIC_CACHE).then((c) => cachePut(c, req, copy));
    }
    return res;
  } catch {
    return (await caches.match(OFFLINE_URL)) || Response.error();
  }
}

/* cache.put 会因为 Request/Response 不匹配等原因 reject，统一点火并吞掉：
   缓存写失败绝不能影响页面拿到网络响应。 */
function cachePut(cache, req, res) {
  return cache.put(req, res).catch(() => {});
}
