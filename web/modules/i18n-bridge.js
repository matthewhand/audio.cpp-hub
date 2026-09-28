/* web/modules/i18n-bridge.js — i18n 桥
 *
 * I18N 由 web/i18n.js 以经典脚本方式挂在 window 上（必须在模块之前加载），
 * 这里只做一次绑定，把它的 t() 收敛成模块内统一入口，避免各模块各写一份 I18N.t。
 * 不复制任何字典逻辑：语言切换 / errText / pick 等仍走 I18N 本身。 */

export const t = (k, p) => I18N.t(k, p);
