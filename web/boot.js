/* 启动引导：在样式表与主脚本加载前恢复主题与界面语言。
   独立为外部文件以满足 CSP `script-src 'self'`（不允许内联脚本）。 */
/* 经典脚本（voices-panel.js）在解析期就需要 $；主逻辑 app.js 已改为 ES module（延迟执行），
   其 core/dom.js 的导出在此之前不可用，故在这里提前提供等价的全局 $。 */
window.$ = (id) => document.getElementById(id);
document.documentElement.dataset.theme = localStorage.getItem("hub-theme") || "light";
document.documentElement.lang =
  (localStorage.getItem("hub-lang") || (navigator.language || "zh"))
    .toLowerCase().startsWith("zh") ? "zh-CN" : "en";
