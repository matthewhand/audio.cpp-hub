/*
 * PWA 注册与更新提示（非内联，满足 CSP script-src 'self'）。
 *
 * - 注册 /sw.js；首次安装无 controller，不会弹更新提示。
 * - 检测到新版本处于 waiting 时，弹出可关闭的小提示条；点击「刷新」发送
 *   SKIP_WAITING 并在 controllerchange 后 reload。
 * - 文案自包含中英双语（避免依赖 i18n.js 的加载顺序）；通过 CSS 类渲染，
 *   不注入任何内联样式。
 */
"use strict";

(function () {
  if (!("serviceWorker" in navigator)) return;
  if (location.protocol !== "http:" && location.protocol !== "https:") return;

  const isZh = (localStorage.getItem("hub-lang") || document.documentElement.lang || "zh")
    .toLowerCase().indexOf("zh") === 0;
  const TEXT = isZh
    ? { title: "有新版本可用", reload: "刷新", later: "稍后", aria: "应用更新提示" }
    : { title: "A new version is available", reload: "Reload", later: "Later", aria: "App update prompt" };

  const DISMISS_KEY = "hub-pwa-update-dismissed";
  let waitingWorker = null;
  let reloading = false;
  /* 载入时是否已受控：首次安装的 clients.claim() 不是版本更新，reload 会吞掉此刻的交互 */
  const wasControlled = Boolean(navigator.serviceWorker.controller);

  function showUpdate(worker) {
    waitingWorker = worker;
    if (sessionStorage.getItem(DISMISS_KEY) === "1") return;
    if (document.getElementById("pwa-update")) return;

    const bar = document.createElement("div");
    bar.id = "pwa-update";
    bar.className = "pwa-update";
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-label", TEXT.aria);

    const text = document.createElement("span");
    text.className = "pwa-update-text";
    text.textContent = TEXT.title;

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "btn pwa-update-reload";
    reload.textContent = TEXT.reload;
    reload.addEventListener("click", function () {
      reload.disabled = true;
      if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
    });

    const later = document.createElement("button");
    later.type = "button";
    later.className = "btn-ghost pwa-update-later";
    later.textContent = TEXT.later;
    later.addEventListener("click", function () {
      sessionStorage.setItem(DISMISS_KEY, "1");
      bar.remove();
    });

    bar.appendChild(text);
    bar.appendChild(reload);
    bar.appendChild(later);
    document.body.appendChild(bar);
  }

  // theme-color 跟随当前主题（浅色默认 / 深色）
  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    meta.setAttribute(
      "content",
      document.documentElement.dataset.theme === "dark" ? "#0c0c0e" : "#f6f6f7"
    );
  }
  syncThemeColor();
  window.addEventListener("themechange", syncThemeColor);

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!wasControlled || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", function () {
    navigator.serviceWorker
      .register("/sw.js")
      .then(function (reg) {
        if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
        reg.addEventListener("updatefound", function () {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener("statechange", function () {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              showUpdate(installing);
            }
          });
        });
      })
      .catch(function () {
        /* 注册失败（如非安全上下文）静默忽略，不影响主应用 */
      });
  });
})();
