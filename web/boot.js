/* 启动引导：在样式表与主脚本加载前恢复主题与界面语言。
   独立为外部文件以满足 CSP `script-src 'self'`（不允许内联脚本）。

   主题模式三态："system"（跟随系统 prefers-color-scheme）/ "light" / "dark"。
   本文件在首次绘制前同步解析并写入 <html data-theme>，避免错误主题闪烁（FOUC）；
   同时把解析逻辑挂到 window.HubTheme，供 app.js / core/features 复用，避免两处重复实现。

   经典脚本（voices-panel.js）在解析期就需要 $；主逻辑 app.js 已改为 ES module（延迟执行），
   其 core/dom.js 的导出在此之前不可用，故在这里提前提供等价的全局 $。 */
(function () {
  window.$ = (id) => document.getElementById(id);

  var media = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

  /** 读取持久化的主题模式；非法或缺失时回退 system。 */
  function mode() {
    var stored = localStorage.getItem("hub-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  }

  /** 把模式解析为实际主题：system 跟随系统，其余原样返回。 */
  function resolve(m) {
    if (m === "light" || m === "dark") return m;
    return media && media.matches ? "dark" : "light";
  }

  /** 写入 data-theme（实际主题，供 CSS 使用）与 data-theme-mode（原始模式，供 UI 使用）。 */
  function apply(m) {
    document.documentElement.dataset.theme = resolve(m);
    document.documentElement.dataset.themeMode = m;
  }

  /** 持久化并应用模式；返回归一化后的模式。 */
  function setMode(m) {
    if (m !== "light" && m !== "dark" && m !== "system") m = "system";
    localStorage.setItem("hub-theme", m);
    apply(m);
    return m;
  }

  apply(mode());

  /* 系统配色变化时，仅在 system 模式下跟随（显式 light/dark 不被打扰） */
  if (media) {
    var onSystemChange = function () {
      if (mode() === "system") {
        apply("system");
        /* 通知波形等按 CSS 变量着色的绘制逻辑重绘 */
        window.dispatchEvent(new Event("themechange"));
      }
    };
    if (media.addEventListener) media.addEventListener("change", onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  window.HubTheme = { mode: mode, resolve: resolve, apply: apply, setMode: setMode };

  document.documentElement.lang =
    (localStorage.getItem("hub-lang") || (navigator.language || "zh"))
      .toLowerCase().startsWith("zh") ? "zh-CN" : "en";
})();
