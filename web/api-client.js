/* audio.cpp-hub 前端 API 客户端：集中 fetch / 错误信封 / AbortController / 轮询。
   ---------------------------------------------------------------------------
   定位（roadmap #62）：web/ 是无构建的原生经典脚本集（见 index.html 底部
   <script src=...> 顺序加载），本文件是唯一的 HTTP 出口约定层，调用方
   （app.js / 后续 audio-picker.js / voice-select.js / file-browser.js …）不应
   再直接写 fetch()。

   暴露为单个全局：window.AudioCppHub.api（下称 Api），包在 IIFE 内以免与
   其它经典脚本的顶层声明冲突（同 audio-picker.js / file-browser.js 做法）。
   本文件不依赖任何第三方库、不需要构建步骤；只用 fetch / AbortController /
   Promise / Set 这些浏览器原生能力。

   ===========================================================================
   契约（给贡献者，改动前请先读这段）
   ===========================================================================

   1) 基础 URL
      一律用**相对路径**（如 "/api/models"），客户端自行拼接；传绝对
      http(s) URL 时原样使用（本项目目前只有同源场景，相对即可）。
      路径里的动态段用 params 占位：api.get("/api/tasks/{id}", { params: { id } })
      → 内部 encodeURIComponent，避免手拼 URL 引入注入/编码错误。

   2) request() 是唯一的原语
      api.request(path, opts) → Promise<data>
        opts: { method, body, query, params, headers, signal, timeout, raw, cache }
          - body 传普通对象 → 自动 JSON.stringify 并补 Content-Type；
            传 FormData / Blob / string → 原样发送（不补 Content-Type）。
          - query 传对象 → 自动拼 "?k=v"（值做 encodeURIComponent）。
          - timeout 默认 DEFAULTS.timeout 毫秒（0 = 不限时，用于长任务）。
          - raw: true → 不解析 JSON，直接 resolve 原始 Response（音频/文件下载）。
      成功时 resolve 解析后的 JSON；空响应体 resolve null。
      失败时**一律 reject ApiError**（不使用 res.ok 手动判断，调用方无需
      复制粘贴 "if (!res.ok) throw ..." 模板）。

   3) 错误信封归一化（服务端两种错误体统一成同一个 ApiError）
      hub 风格：{"ok":false,"code":"X","params":{...},"error":"中文兜底"}
        → err.code = "X"，err.params = {...}，err.detail = "中文兜底"
      OpenAI 风格（/v1/*）：{"error":{"message":"...","type":"..."}}
        → err.type = "...", err.detail = "..."，err.code = type 或 CLIENT_HTTP_ERROR
      客户端侧失败统一为自造 code（见 CODE 常量）：CLIENT_TIMEOUT /
      CLIENT_ABORTED / CLIENT_NETWORK / CLIENT_BAD_JSON / CLIENT_BAD_SHAPE。
      err.message 已尽量本地化（有 I18N 时走 I18N.errText 翻译 error 码），
      可直接展示；err.envelope 保留服务端原始 JSON 供程序判断。

   4) ApiError 判定属性
      err.status  HTTP 状态码（网络层失败为 0）
      err.code    错误码（服务端 code 或 CLIENT_*）
      err.params  错误参数（仅 hub 风格）
      err.type    OpenAI error.type（仅 /v1/*）
      err.detail  服务端人类可读信息原文
      err.envelope 服务端原始响应体（对象或 null）
      err.url / err.method  便于排查
      err.isAbort          中途被 abort（超时或调用方取消）→ 轮询里静默
      err.isTimeout / err.isNetwork / err.isClient  便于分别处理

   5) 中断与超时
      - 每次请求内部自建 AbortController 并链接调用方 signal 与超时定时器，
        请求结束（成功/失败/取消）都会清掉定时器与监听器，不留悬挂句柄。
      - 组件在轮询中途销毁时调用 poller.stop()：清定时器 + abort 在途请求 +
        摘掉 visibility 监听；stop() 之后到达的响应不会再回调 handler。

   6) poll() 是轮询的唯一入口
      const h = Api.poll("/api/instances", onData, { interval: 2000, list: true });
      h.stop();            // 彻底停止（无悬挂定时器 / 无在途请求）
      h.refresh();         // 立即拉一次（返回本轮 Promise，可 await）
      行为保证：
        - 自调度 setTimeout（不是 setInterval）：上一轮结束才排下一轮，
          不会叠加请求；
        - 同刻只允许一个在途请求（单飞）；
        - visibility 感知：标签页隐藏时不发请求，重新可见立即补一次；
          refresh() 在隐藏时是空操作（不会绕过可见性去发请求）；
        - list: true 时带数组形状守卫（错误体 / 非数组不会进 handler）；
        - 任一失败（网络抖动 / 超时 / 5xx）只交给 opts.onError，不打断轮询；
        - 「拿到终态就自己停」：在 handler 里调 h.stop() 即可。
      未提供 onError 时仅 console.warn，不弹 toast —— 2s 级别的瞬时失败
      不应打扰用户，各调用方自行决定首次加载失败时的可见提示。

   7) list() —— 列表接口的类型守卫
      api.list("/api/downloads") 会在返回体不是数组时 reject
      （CLIENT_BAD_SHAPE），避免把错误 JSON 当成空数组（历史缺陷 FE-6）。

   8) 迁移约定
      - 已有 fetch 调用的迁移顺序：先 GET 列表/轮询，再 POST/PUT/DELETE。
      - 迁移后不要保留 "if (!res.ok) throw ..." 模板，交给 ApiError。
      - 组件类（picker / select / panel）也用 Api，不要新开 fetch。

   9) 不做的事（留给后续 issue）
      - 不做请求重试/退避（轮询本身就是重试；一次性请求失败由调用方决定）
      - 不做缓存 / 去重 / 请求合并（各页面自己有 models/instances 等状态）
      - 不做上传进度、SSE、multipart 代理等高级能力
   =========================================================================== */

(() => {

/* 默认值：单次请求 20s；轮询 2s 一次、单次 10s（超时短于间隔，避免堆积） */
const DEFAULTS = {
  timeout: 20000,
  pollInterval: 2000,
  pollTimeout: 10000
};

/* 客户端自造错误码（服务端未提供 code 时使用） */
const CODE = {
  TIMEOUT: "CLIENT_TIMEOUT",
  ABORTED: "CLIENT_ABORTED",
  NETWORK: "CLIENT_NETWORK",
  BAD_JSON: "CLIENT_BAD_JSON",
  BAD_SHAPE: "CLIENT_BAD_SHAPE",
  HTTP: "CLIENT_HTTP_ERROR"
};

/* ---------------------------------------------------------------------------
   共享类型（开发期 only，运行期被注释掉）
   --------------------------------------------------------------------------- */

/**
 * request() 的调用参数。
 * @typedef {object} RequestOptions
 * @property {string}  [method]  HTTP 方法，缺省 GET
 * @property {*}       [body]    plain object 走 JSON；FormData/Blob/ArrayBuffer/TypedArray/string 原样发送
 * @property {Record<string,string|number>} [query]   追加到 URL 的查询参数
 * @property {Record<string,string>} [params]  替换 path 中的 {name} 占位
 * @property {Record<string,string>} [headers] 请求头
 * @property {AbortSignal} [signal] 外部取消信号
 * @property {number}   [timeout] 毫秒；缺省 DEFAULTS.timeout
 * @property {boolean}  [raw]     true 时 resolve 原始 Response，不解析 JSON
 * @property {boolean}  [cache]   透传给 fetch 的 cache 选项
 */

/**
 * poll() 的调用参数。
 * @typedef {object} PollOptions
 * @property {number}  [interval]   轮询间隔（毫秒），缺省 DEFAULTS.pollInterval
 * @property {number}  [timeout]    单次请求超时，缺省 DEFAULTS.pollTimeout
 * @property {boolean} [visibility] 页面隐藏时暂停，缺省 true
 * @property {boolean} [immediate]  启动时立即触发一次，缺省 false
 * @property {boolean} [list]       true 时对返回体做数组形状守卫
 * @property {RequestOptions} [request] 透传给 request() 的固定参数
 * @property {(err: ApiError) => void} [onError] 请求失败回调
 */

/**
 * ApiError 构造函数参数。
 * @typedef {object} ApiErrorOptions
 * @property {number}  [status]
 * @property {string}  [code]
 * @property {Record<string, *>} [params]
 * @property {string}  [type]      OpenAI 风格错误的 type
 * @property {string}  [detail]
 * @property {*}       [envelope]  服务端原始错误体
 * @property {string}  [url]
 * @property {string}  [method]
 * @property {boolean} [aborted]
 */

/* ---------------------------------------------------------------------------
   ApiError：所有失败路径的统一类型
   --------------------------------------------------------------------------- */
class ApiError extends Error {
  /** @param {string} message @param {ApiErrorOptions} [opts] */
  constructor(message, opts = {}) {
    super(message || "");
    this.name = "ApiError";
    this.status = opts.status || 0;
    this.code = opts.code || CODE.HTTP;
    this.params = opts.params || {};
    this.type = opts.type || "";
    this.detail = opts.detail || "";
    this.envelope = opts.envelope || null;
    this.url = opts.url || "";
    this.method = opts.method || "";
    this.aborted = !!opts.aborted;
  }
  /* 被 abort（调用方取消或超时）——轮询回调里应当静默跳过 */
  get isAbort() { return this.aborted; }
  get isTimeout() { return this.code === CODE.TIMEOUT; }
  get isNetwork() { return this.code === CODE.NETWORK; }
  /* 客户端自造错误（超时/网络/解析/形状），与服务端业务 code 区分 */
  get isClient() { return this.code.startsWith("CLIENT_"); }
  /** @override */
  toString() {
    return "ApiError{" + this.code + " " + this.status + " " + this.message + "}";
  }
}

/* 尽可能本地化错误文案：hub 风格走 I18N.errText（按 error 码查字典），
   OpenAI 风格直接用 message。无 I18N（如单测）时回退服务端原文。 */
function localize(text, parsed) {
  const fallback = parsed && typeof parsed === "object" ? detailOf(parsed) : "";
  try {
    if (window.I18N && typeof window.I18N.errText === "function" && text) {
      const s = window.I18N.errText(text);
      if (s) return s;
    }
  } catch (e) { /* 字典缺码等异常不阻断错误处理 */ }
  return fallback || text || "";
}

/* 从两种错误体里取出人类可读信息 */
function detailOf(j) {
  if (!j || typeof j !== "object") return "";
  if (j.error && typeof j.error === "object") return String(j.error.message || "");
  if (typeof j.error === "string") return j.error;
  if (typeof j.message === "string") return j.message;
  return "";
}

/* 把非 OK 响应（文本体已读完）转成 ApiError */
function errorFromResponse(res, text, url, method) {
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 错误体 */ }
  const openai = parsed && parsed.error && typeof parsed.error === "object";
  return new ApiError(localize(text, parsed) || ("HTTP " + res.status), {
    status: res.status,
    code: openai ? (parsed.error.type || CODE.HTTP) : ((parsed && parsed.code) || CODE.HTTP),
    params: (parsed && parsed.params) || {},
    type: openai ? String(parsed.error.type || "") : "",
    detail: detailOf(parsed),
    envelope: parsed,
    url,
    method
  });
}

/* ---------------------------------------------------------------------------
   请求原语
   --------------------------------------------------------------------------- */
function buildUrl(path, params, query) {
  let p = String(path == null ? "" : path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      p = p.split("{" + k + "}").join(encodeURIComponent(String(v)));
    }
  }
  if (query) {
    const parts = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
    if (parts.length) p += (p.indexOf("?") >= 0 ? "&" : "?") + parts.join("&");
  }
  return p;
}

/* 内部 AbortController：合并调用方 signal 与超时定时器，并返回清理函数 */
function withSignal(external, timeoutMs) {
  const ctl = new AbortController();
  const cleanups = [];
  let timedOut = false;
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    const tid = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    cleanups.push(() => clearTimeout(tid));
  }
  if (external) {
    if (external.aborted) ctl.abort();
    else {
      const onAbort = () => ctl.abort();
      external.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => external.removeEventListener("abort", onAbort));
    }
  }
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    externalAborted: () => !!(external && external.aborted),
    done: () => { for (const fn of cleanups) fn(); }
  };
}

/* 把 fetch 抛出的原生异常（AbortError / TypeError 等）归一化成 ApiError */
function errorFromThrown(e, url, method, timedOut, externalAborted) {
  const aborted = timedOut() || externalAborted() || (e && e.name === "AbortError");
  if (aborted) {
    return new ApiError(timedOut() ? "request timeout" : "request aborted", {
      code: timedOut() ? CODE.TIMEOUT : CODE.ABORTED,
      aborted: true,
      url,
      method
    });
  }
  return new ApiError(String((e && e.message) || e || "network error"), {
    code: CODE.NETWORK,
    url,
    method
  });
}

/**
 * 唯一 HTTP 原语。
 * @param {string} path 相对路径（可含 {param} 占位）或绝对 URL
 * @param {RequestOptions} [opts]  { method, body, query, params, headers, signal, timeout, raw, cache }
 * @returns {Promise<any>} 解析后的 JSON（空体为 null）；raw:true 时为 Response
 */
function request(path, /** @type {RequestOptions} */ opts = {}) {
  const method = (opts.method || "GET").toUpperCase();
  const url = buildUrl(path, opts.params, opts.query);
  const timeout = opts.timeout === undefined ? DEFAULTS.timeout : opts.timeout;
  const headers = Object.assign({}, opts.headers || {});
  let body;
  if (opts.body !== undefined && opts.body !== null) {
    // 只有「普通对象」才 JSON 序列化；FormData / Blob / ArrayBuffer / TypedArray / 字符串原样发送
    const isPlainJson = typeof opts.body === "object"
      && !(typeof FormData !== "undefined" && opts.body instanceof FormData)
      && !(typeof Blob !== "undefined" && opts.body instanceof Blob)
      && !(opts.body instanceof ArrayBuffer)
      && !ArrayBuffer.isView(opts.body);
    if (isPlainJson) {
      body = JSON.stringify(opts.body);
      if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    } else {
      body = opts.body;
    }
  }
  const sig = withSignal(opts.signal, timeout);
  const init = { method, headers, body, signal: sig.signal };
  if (opts.cache) init.cache = opts.cache;
  return fetch(url, init)
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw errorFromResponse(res, text, url, method);
      }
      if (opts.raw) return res;
      const text = await res.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new ApiError("bad json: " + e.message, {
          status: res.status, code: CODE.BAD_JSON, url, method
        });
      }
    })
    .catch((e) => {
      if (e instanceof ApiError) throw e;
      throw errorFromThrown(e, url, method, sig.timedOut, sig.externalAborted);
    })
    .finally(() => sig.done());
}

const get = (path, opts) => request(path, Object.assign({}, opts, { method: "GET" }));
const post = (path, body, opts) => request(path, Object.assign({}, opts, { method: "POST", body }));
const put = (path, body, opts) => request(path, Object.assign({}, opts, { method: "PUT", body }));
const del = (path, opts) => request(path, Object.assign({}, opts, { method: "DELETE" }));

/** 列表接口守卫：返回体不是数组 → CLIENT_BAD_SHAPE（而不是静默当空数组） */
async function list(path, opts) {
  const data = await get(path, opts);
  if (!Array.isArray(data)) {
    throw new ApiError("expected array, got " + (data === null ? "null" : typeof data), {
      code: CODE.BAD_SHAPE,
      url: buildUrl(path, opts && opts.params, opts && opts.query)
    });
  }
  return data;
}

/* ---------------------------------------------------------------------------
   轮询：自调度 setTimeout + 单飞 + 可见性感知 + 可彻底 stop
   --------------------------------------------------------------------------- */
const livePollers = new Set();

/**
 * 启动一个轮询。
 * @param {string|(() => string)} path 请求路径（可传函数，返回路径字符串以便动态构造）
 * @param {(data: any) => void | Promise<void>} handler 收到解析后的数据
 * @param {PollOptions} [opts] { interval, timeout, visibility, immediate, list, request, onError }
 *        list: true 走 list() 形状守卫（返回体非数组 → CLIENT_BAD_SHAPE 交 onError）
 * @returns {{stop: () => void, refresh: () => Promise<void>}} refresh() 返回本轮的 Promise（可 await）
 */
function poll(path, handler, /** @type {PollOptions} */ opts = {}) {
  const interval = opts.interval || DEFAULTS.pollInterval;
  const timeout = opts.timeout || DEFAULTS.pollTimeout;
  const visibility = opts.visibility !== false;
  const requestOpts = Object.assign({}, opts.request, { timeout, list: opts.list === true });
  let handle = null;
  let timer = null;
  let ctl = null;        // 当前在途请求的 AbortController（stop 时中断）
  let stopped = false;
  let inflight = false;

  const pathOf = () => (typeof path === "function" ? path() : path);
  const onVisibility = () => { if (!document.hidden) tick(); };

  function schedule() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (stopped) return;
    timer = setTimeout(() => { timer = null; tick(); }, interval);
  }

  async function tick() {
    if (stopped || inflight) return;                       // 已停 / 单飞
    if (visibility && document.hidden) return;             // 隐藏时不发请求（下次可见时补上）
    inflight = true;
    ctl = new AbortController();
    let url = "";
    try {
      url = buildUrl(pathOf(), requestOpts.params, requestOpts.query);
      const reqOpts = Object.assign({}, requestOpts, { signal: ctl.signal });
      const data = requestOpts.list ? await list(pathOf(), reqOpts) : await request(pathOf(), reqOpts);
      if (stopped) return;                                 // stop 之后不再回调
      await handler(data);
    } catch (e) {
      if (stopped) return;
      if (e && e.isAbort) { /* 超时或被 stop 中断：静默，等下一轮 */ }
      else if (opts.onError) opts.onError(e);
      else console.warn("[api] poll failed:", url, e);
    } finally {
      inflight = false;
      ctl = null;
      schedule();
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (ctl) { try { ctl.abort(); } catch (e) { /* 已结束 */ } ctl = null; }
    if (visibility) document.removeEventListener("visibilitychange", onVisibility);
    livePollers.delete(handle);
  }

  handle = { stop, refresh: () => tick() };
  if (visibility) document.addEventListener("visibilitychange", onVisibility);
  livePollers.add(handle);
  if (opts.immediate === false) schedule();
  else tick();
  return handle;
}

/** 停止本模块创建的全部轮询（组件整体卸载 / 手工收尾 / 测试清理用）。
    真正的页面卸载不需要它：定时器与在途请求会随文档一起销毁；
    这里刻意**不**监听 pagehide，因为 bfcache 前进后退会把文档冻结后原样恢复，
    冻结前停掉的轮询无法自动复活（句柄会变成僵尸）。 */
function stopAllPollers() {
  for (const h of Array.from(livePollers)) h.stop();
}

/** @type {AudioCppHubRoot} */
const root = window.AudioCppHub || /** @type {any} */ ({});
root.api = {
  CODE,
  DEFAULTS,
  ApiError,
  request,
  get,
  post,
  put,
  del,
  list,
  poll,
  stopAllPollers,
  buildUrl
};
window.AudioCppHub = root;

})();
