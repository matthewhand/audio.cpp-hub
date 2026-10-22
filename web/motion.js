/*
 * 微交互触发（经典脚本而非 ES 模块，以满足 CSP script-src 'self'，
 * 加载顺序见 index.html）。
 *
 * 只做纯 UI 的动效：flash() 加一个「一次性动画类」，定时器到了再删掉。
 * 所有非必要动画在 `prefers-reduced-motion: reduce` 下直接跳过。CSS 部分见
 * style.css 末尾「动效系统补充」一节。
 *
 * 模式：
 *   - 复制确认：复制类按钮点击后短暂加 `.copied`（缩放 + 主色闪一下）。
 *   - 主题切换：html 短暂加 `.theme-switching`，让主要面板颜色平滑过渡。
 *   - 实例状态翻转：观察 #instance-pill 的 class，真正变化时加 `.state-flip`
 *     （STARTING/无就绪 → READY 时的轻微强调）。
 * 暴露 window.hubMotion.flash(el, cls, ms) 供后续复用。
 *
 * 注意这两个部件是互相作用的：watchPill 观察的 class 属性正是 flash() 自己
 * 反复改写的那个。因此 flash 的类改写必须同时满足：
 *   a) 对 pill 观察者不可见——只比较剥掉动画类后的「稳定 class 串」；
 *      否则每次 flash 自己加/删类都被认成状态变化，无限循环触发下一次。
 *   b) 同一节点同一类不能叠多个定时器——重新调用只重置那个定时器。
 * 这条自我触发链路曾在 CDP profile 上量到：空闲页面每 8s 里 flash 占约
 * 3.2s CPU，阻塞主线程 0.5-1.6s，表现为「生成中…」计时徽标卡顿。
 */
"use strict";

(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* flash() 自己加的动画类：到时会由定时器删掉，因此不算「状态变化」。 */
  const TRANSIENT_CLASSES = ["state-flip"];

  /* node ->（class -> 该 flash 的定时器 id）。同一节点同一类同时只允许一个
     flash；重入调用只重置这个定时器，不再叠加新的 setTimeout。 */
  const pending = new WeakMap();

  /* 剥掉 flash 的动画类并规整空白后的 class 串——即「稳定状态」。 */
  function stableClass(node) {
    const out = [];
    const parts = String(node.className || "").split(/\s+/);
    for (const c of parts) {
      if (!c || TRANSIENT_CLASSES.indexOf(c) !== -1) continue;
      if (out.indexOf(c) === -1) out.push(c);
    }
    return out.join(" ");
  }

  function flash(node, cls, ms) {
    if (!node || reduce.matches) return;
    let map = pending.get(node);
    if (!map) {
      map = new Map();
      pending.set(node, map);
    }
    const running = map.get(cls);
    if (running !== undefined) {
      // 已有一个未完成的 flash：只重置它的定时器。类已经在节点上，下面的 add
      // 是空操作，不产生 class 改写（也不会再逼出一次观察者回调）。
      window.clearTimeout(running);
    } else if (node.classList.contains(cls)) {
      // 只有类已经在节点上时才值得重启动画：删 → 强制回流 → 再加。
      node.classList.remove(cls);
      void node.offsetWidth;
    }
    node.classList.add(cls);
    map.set(
      cls,
      window.setTimeout(function () {
        map.delete(cls);
        node.classList.remove(cls);
      }, ms || 600)
    );
  }

  window.hubMotion = { flash: flash, prefersReduced: function () { return reduce.matches; } };

  // 复制确认：捕获阶段先于 app.js 的 onclick 执行
  document.addEventListener(
    "click",
    function (e) {
      const btn = e.target && e.target.closest && e.target.closest("#asr-copy, [data-copy-flash]");
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
    const pill = document.getElementById("instance-pill");
    if (!pill || typeof MutationObserver === "undefined") return;
    // 与「稳定 class 串」比较：flash 自己给同一个 class 属性加/删 state-flip，
    // 剥掉动画类后相等就直接返回，动画类的写不能再触发下一次 flash。
    let last = stableClass(pill);
    new MutationObserver(function () {
      const stable = stableClass(pill);
      if (stable === last) return;
      last = stable;
      flash(pill, "state-flip", 600);
    }).observe(pill, { attributes: true, attributeFilter: ["class"] });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchPill);
  } else {
    watchPill();
  }
})();
