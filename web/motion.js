/*
 * 微交互增强（非内联，满足 CSP script-src 'self'）。
 *
 * 只做纯 UI 的动效触发，不改变任何业务逻辑；所有非必要动画在
 * `prefers-reduced-motion: reduce` 下直接跳过。CSS 部分见 style.css
 * 末尾「动效系统补充」一节。
 *
 * 模式：
 *   - 复制确认：复制类按钮点击后短暂加 `.copied`（缩放 + 主色闪一下）。
 *   - 主题切换：html 短暂加 `.theme-switching`，让主要面板颜色平滑过渡。
 *   - 实例状态变化：监听 #instance-pill 的 class 变化加 `.state-flip`
 *     （STARTING/无就绪 → READY 时的轻微强调）。
 * 暴露 window.hubMotion.flash(el, cls, ms) 供后续复用。
 */
"use strict";

(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  function flash(node, cls, ms) {
    if (!node || reduce.matches) return;
    node.classList.remove(cls);
    void node.offsetWidth; // 强制回流以重启动画
    node.classList.add(cls);
    window.setTimeout(function () {
      node.classList.remove(cls);
    }, ms || 600);
  }

  window.hubMotion = { flash: flash, prefersReduced: function () { return reduce.matches; } };

  // 复制确认：捕获阶段先于 app.js 的 onclick 执行
  document.addEventListener(
    "click",
    function (e) {
      var btn = e.target && e.target.closest && e.target.closest("#asr-copy, [data-copy-flash]");
      if (btn) flash(btn, "copied", 700);
    },
    true
  );

  // 主题切换：短暂开启动画过渡
  window.addEventListener("themechange", function () {
    flash(document.documentElement, "theme-switching", 320);
  });

  // 实例就绪状态变化：观察单元素 pill 的 class 变化（实例列表本身每 2s 重建，不适合观察）
  function watchPill() {
    var pill = document.getElementById("instance-pill");
    if (!pill || typeof MutationObserver === "undefined") return;
    var last = pill.className;
    new MutationObserver(function () {
      if (pill.className === last) return;
      last = pill.className;
      flash(pill, "state-flip", 600);
    }).observe(pill, { attributes: true, attributeFilter: ["class"] });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchPill);
  } else {
    watchPill();
  }
})();
