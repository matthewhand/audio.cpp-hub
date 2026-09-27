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

const CACHE_VERSION = "v1";
const STATIC_CACHE = `acpp-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `acpp-runtime-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

/* 应用外壳：安装时预缓存。逐项 allSettled，个别资源缺失不会让整次安装失败。 */
const PRECACHE_URLS = [
  "/",
  "/index.html",
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/boot.js",
  "/i18n.js",
  "/wav.js",
  "/file-browser.js",
  "/audio-picker.js",
  "/voice-select.js",
  "/app.js",
  "/voices-panel.js",
  "/motion.js",
  "/pwa.js",
  "/style.css",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon-180.png"
];

/* 可 cache-first 的静态资源扩展名（API 已在前面拦截，不可能命中这里）。 */
const CACHEABLE_EXT = /\.(?:css|js|mjs|json|webmanifest|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|otf|mp4|webm)$/i;

self.addEventListener("install", (event) => {
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

self.addEventListener("activate", (event) => {
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
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
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
  if (url.origin !== self.location.origin) return;

  // ---- API / OpenAI 兼容代理：network-only，绝不缓存 ----
  const p = url.pathname;
  if (p === "/api" || p.startsWith("/api/") || p === "/v1" || p.startsWith("/v1/")) {
    return; // 不调用 respondWith → 浏览器按默认网络行为处理，SW 不缓存
  }

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
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (isNavigate) {
      return (
        (await caches.match("/index.html")) ||
        (await caches.match(OFFLINE_URL)) ||
        Response.error()
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
        if (res && res.ok) caches.open(STATIC_CACHE).then((c) => c.put(req, res)).catch(() => {});
      })
      .catch(() => {});
    return cached;
  }
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      const copy = res.clone();
      caches.open(STATIC_CACHE).then((c) => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    return (await caches.match(OFFLINE_URL)) || Response.error();
  }
}
