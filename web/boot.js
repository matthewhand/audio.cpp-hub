/* 启动引导：在样式表与主脚本加载前恢复主题与界面语言。
   独立为外部文件以满足 CSP `script-src 'self'`（不允许内联脚本）。 */
document.documentElement.dataset.theme = localStorage.getItem("hub-theme") || "light";
document.documentElement.lang =
  (localStorage.getItem("hub-lang") || (navigator.language || "zh"))
    .toLowerCase().startsWith("zh") ? "zh-CN" : "en";
