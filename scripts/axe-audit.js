#!/usr/bin/env node
/* 无障碍审计辅助（仅开发用，不随页面发布；页面 CSP 为 script-src 'self'，本文件不进 index.html）。
   ------------------------------------------------------------------
   用法（浏览器 DevTools Console，需允许粘贴）：
     1) 打开 hub 页面；
     2) 把本文件内容整段粘贴到 Console 回车；
     3) 等 axe 载入后会自动审计，也可手动调用 window.runAxeAudit()。
   若 CSP 的 connect-src 'self' / script-src 'self' 拦截了 CDN，可任选其一：
     - 把 axe-core 的 axe.min.js 放到 web/ 下临时用 <script src="/axe.min.js"> 引入后再跑本脚本；
     - 或用本地已安装的 axe-core：window.axe = require('axe-core'); 然后直接调用 runAxeAudit()。
   ------------------------------------------------------------------
   手动审计（无浏览器时）结论记录在 PR 描述里：所有弹窗 role=dialog/aria-modal、Tab 焦点陷阱、
   Esc 关闭、焦点还原、背景 inert；页头 h1 + main/aside/nav/footer 地标 + 跳到主要内容；任务/提示
   走 aria-live；错误码中英全覆盖（scripts/check-i18n-parity.js 校验 parity）。 */
(function () {
  var AXE_URL = "https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js";

  function summarize(results) {
    var violations = results.violations || [];
    if (!violations.length) {
      console.log("%c[axe] 无 WCAG A/AA 违规 🎉", "color:#059669;font-weight:bold");
      return;
    }
    console.log("%c[axe] 违规 " + violations.length + " 项", "color:#dc2626;font-weight:bold");
    violations.forEach(function (v) {
      console.group(v.impact + " · " + v.id + " — " + v.help);
      console.log(v.helpUrl);
      v.nodes.forEach(function (n) {
        console.log(n.target.join(" "), n.failureSummary);
      });
      console.groupEnd();
    });
  }

  function run() {
    if (!window.axe) {
      console.warn("[axe] axe-core 未加载");
      return;
    }
    window.axe
      .run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] })
      .then(summarize)
      .catch(function (e) {
        console.error("[axe] 审计失败", e);
      });
  }
  window.runAxeAudit = run;

  if (window.axe) {
    run();
    return;
  }
  var s = document.createElement("script");
  s.src = AXE_URL;
  s.onload = run;
  s.onerror = function () {
    console.warn("[axe] 加载失败，请按文件头注释使用本地副本");
  };
  document.head.appendChild(s);
})();
