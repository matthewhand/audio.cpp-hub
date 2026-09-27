/* audio.cpp-hub 前端国际化：轻量框架 + data-i18n 属性替换。
   - 词典拆分到 i18n.zh.js / i18n.en.js（window.I18N_ZH / window.I18N_EN），本文件只负责运行时
   - 语言优先级：localStorage("hub-lang") → navigator.language（zh* 为中文，其余英文）
   - 动态文案用 I18N.t(key, params)，{name} 占位符插值；复数用 I18N.plural(key, n, params)
   - 静态 HTML 用 data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria-label 标注，
     applyI18n() 批量替换；切换语言时同时更新 <html lang>
   - 后端错误：I18N.errText(resText) 解析 {"code","params"} 并按当前语言翻译，无 code 原文兜底
   - 数字/日期/字节/百分比统一走 Intl：I18N.num / date / bytes / percent（随语言本地化）
   - 语言切换：I18N.onChange(cb) 注册重渲染回调（app.js / AudioPicker / FileBrowser / VoicesPanel） */
window.I18N = (() => {

  const dicts = {
    zh: window.I18N_ZH || {},
    en: window.I18N_EN || {}
  };

  const BCP47 = { zh: "zh-CN", en: "en" };
  const BYTE_UNITS = [["byte", "B"], ["kilobyte", "KB"], ["megabyte", "MB"], ["gigabyte", "GB"], ["terabyte", "TB"]];
  let numFmtCache = {};

  function detect() {
    const saved = localStorage.getItem("hub-lang");
    if (saved === "zh" || saved === "en") return saved;
    const nav = (navigator.language || "zh").toLowerCase();
    return nav.startsWith("zh") ? "zh" : "en";
  }

  let current = detect();
  const listeners = [];

  function lang() {
    return current;
  }

  /* 当前语言的 BCP-47 标签，供 Intl 使用 */
  function locale() {
    return BCP47[current];
  }

  function interpolate(val, params) {
    if (Array.isArray(val) || !params) return val;
    return val.replace(/\{(\w+)\}/g, (m, name) =>
      params[name] !== undefined ? String(params[name]) : m);
  }

  /** 查字典：当前语言 → zh 兜底 → key 本身。数组值（如 emotion.labels）原样返回。 */
  function t(key, params) {
    let val = dicts[current][key];
    if (val === undefined) val = dicts.zh[key];
    if (val === undefined) return key;
    return interpolate(val, params);
  }

  /**
   * 复数/数量文案：按 Intl.PluralRules 选 key.<category>，缺失回退 key.other。
   * 例：I18N.plural("dl.fileCount", n) 取 dl.fileCount.one / dl.fileCount.other。
   */
  function plural(key, count, params) {
    const cat = new Intl.PluralRules(locale()).select(count);
    const merged = Object.assign({ n: count }, params || {});
    let val = dicts[current][key + "." + cat];
    if (val === undefined) val = dicts[current][key + ".other"];
    if (val === undefined) val = dicts.zh[key + "." + cat];
    if (val === undefined) val = dicts.zh[key + ".other"];
    if (val === undefined) return t(key, merged);
    return interpolate(val, merged);
  }

  /** 本地化数字（千分位等）。opts 透传 Intl.NumberFormat。 */
  function num(n, opts) {
    const key = JSON.stringify(opts || null);
    if (!numFmtCache[key]) numFmtCache[key] = new Intl.NumberFormat(locale(), opts);
    return numFmtCache[key].format(Number(n) || 0);
  }

  /** 本地化日期/时间。默认 dateStyle=medium, timeStyle=short。 */
  function date(v, opts) {
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d.getTime())) return "";
    const o = opts || { dateStyle: "medium", timeStyle: "short" };
    return new Intl.DateTimeFormat(locale(), o).format(d);
  }

  /** 本地化字节大小（B/KB/MB/GB/TB），数字与单位均走 Intl。 */
  function bytes(n) {
    n = Number(n) || 0;
    let i = 0;
    while (n >= 1024 && i < BYTE_UNITS.length - 1) { n /= 1024; i++; }
    const unit = BYTE_UNITS[i][0];
    const o = { style: "unit", unit, maximumFractionDigits: i === 0 ? 0 : 1 };
    try {
      return new Intl.NumberFormat(locale(), o).format(n);
    } catch (e) {
      return num(n, { maximumFractionDigits: i === 0 ? 0 : 1 }) + " " + BYTE_UNITS[i][1];
    }
  }

  /** 本地化百分比；入参为 0..100 的数值（如进度百分比）。 */
  function percent(n) {
    return new Intl.NumberFormat(locale(), { style: "percent", maximumFractionDigits: 0 }).format((Number(n) || 0) / 100);
  }

  /** 把静态 DOM 中的 data-i18n* 属性替换为当前语言文案。 */
  function applyI18n(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(n => { n.textContent = t(n.dataset.i18n); });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(n => { n.placeholder = t(n.dataset.i18nPlaceholder); });
    scope.querySelectorAll("[data-i18n-title]").forEach(n => { n.title = t(n.dataset.i18nTitle); });
    scope.querySelectorAll("[data-i18n-aria-label]").forEach(n => { n.setAttribute("aria-label", t(n.dataset.i18nAriaLabel)); });
  }

  function onChange(cb) {
    listeners.push(cb);
  }

  function setLang(next) {
    if (next !== "zh" && next !== "en") return;
    current = next;
    localStorage.setItem("hub-lang", next);
    document.documentElement.lang = BCP47[next];
    applyI18n();
    for (const cb of listeners) cb(next);
  }

  /**
   * 解析后端响应文本：{"ok":false,"code":"X","params":{...},"error":"中文兜底"} → 翻译；
   * 无 code（旧格式或普通文本）→ 尽量取 error 字段，否则原文返回。
   */
  function errText(text) {
    if (!text) return "";
    try {
      const j = JSON.parse(text);
      if (j && typeof j === "object") {
        if (j.code && dicts[current]["err." + j.code] !== undefined) {
          return t("err." + j.code, j.params || {});
        }
        if (j.error) return String(j.error);
      }
    } catch (e) { /* 非 JSON：原样返回 */ }
    return text;
  }

  /** 多语言字段选用：英文模式下优先 obj[field + "En"]，缺失回退原字段。 */
  function pick(obj, field) {
    if (!obj) return "";
    if (current === "en" && obj[field + "En"] !== undefined) return obj[field + "En"];
    return obj[field];
  }

  document.documentElement.lang = BCP47[current];

  return { lang, locale, t, plural, num, date, bytes, percent, setLang, applyI18n, onChange, errText, pick };
})();
