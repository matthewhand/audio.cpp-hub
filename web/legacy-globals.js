/* 经典脚本 ↔ ES 模块之间的桥。**必须以普通 <script> 加载，且在同目录其它经典脚本之前。**
 *
 * 背景：web/app.js 及其 web/modules/*.js 已改成 ES 模块（index.html 里是
 * `<script type="module">`），而模块脚本默认 defer——它在整份文档解析完之后才执行，
 * 晚于所有普通脚本。于是仍在模块之前执行的经典组件脚本（audio-picker.js 的 toast、
 * voices-panel.js 的按钮绑定）就再也拿不到 app.js 顶层曾经提供的
 * window.$ / window.showToast / window.focusDialog / window.restoreDialogFocus。
 *
 * 本文件把「经典脚本要用到」的那几个名字补回 window：
 *   - $ / el：定义在这里（实现只有这一份），web/modules/dom.js 只是绑定并再导出；
 *   - showToast / focusDialog / restoreDialogFocus / parseApiError /
 *     renderStateError / renderEmptyState：这里只装转发器，真实实现在
 *     web/modules/async-ui.js 与 web/modules/ui.js，由 web/app.js 在模块求值时回填到
 *     window.AudioCppHubApp。转发器在目标尚未就位时静默返回，语义与原来
 *     audio-picker.js 里的 `typeof window.showToast === "function"` 保护一致。
 *
 * 需求来源：audio-picker.js（showToast）、voices-panel.js（$ / el / showToast /
 * focusDialog / restoreDialogFocus，以及 #88 之后的 parseApiError / renderStateError /
 * renderEmptyState 三态原语）。这些调用都在事件回调里，届时模块早已求值完毕。
 */
(function () {
  window.$ = (id) => document.getElementById(id);
  window.el = (html) => {
    const tpl = document.createElement("template");
    tpl.innerHTML = html.trim();
    return tpl.content.firstChild;
  };

  const host = (window.AudioCppHubApp = window.AudioCppHubApp || {});
  window.showToast = function (level, message) {
    if (host.showToast) return host.showToast(level, message);
  };
  window.focusDialog = function (overlay) {
    if (host.focusDialog) return host.focusDialog(overlay);
  };
  window.restoreDialogFocus = function () {
    if (host.restoreDialogFocus) return host.restoreDialogFocus();
  };

  /* #88 的统一异步状态原语：voices-panel.js 仍在用 window.<fn> 形式调用它们 */
  window.parseApiError = function (text) {
    if (host.parseApiError) return host.parseApiError(text);
    return new Error(window.I18N ? window.I18N.errText(text) : text);
  };
  window.renderStateError = function (container, error, retry, raw) {
    if (host.renderStateError) return host.renderStateError(container, error, retry, raw);
  };
  window.renderEmptyState = function (container, message, cta) {
    if (host.renderEmptyState) return host.renderEmptyState(container, message, cta);
  };
})();
