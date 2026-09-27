/* i18n 薄封装：i18n.js 仍以经典脚本形式提供全局 window.I18N（AudioPicker / FileBrowser 等
   经典脚本依赖它），这里把同一实例转成 ES 模块具名导出，供模块化的应用代码 import。
   加载顺序保证：i18n.js 经典脚本先于本模块（type=module 延迟执行）求值。 */
export const I18N = window.I18N;
export const t = (k, p) => I18N.t(k, p);
