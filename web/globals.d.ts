/* audio.cpp-hub 前端：开发期类型声明（纯类型，无运行期文件）。
 *
 * web/ 下的脚本分两类：
 *   - 经典脚本（classic script）：按 web/index.html 的 <script src> 顺序执行，
 *     把公开接口挂到 `window.*`；
 *   - ES 模块（web/app.js + web/modules/*.js）：跨文件走 import/export。
 * TypeScript 的 checkJs 不会把「某个脚本里的 `window.X = ...` 赋值」推断成其它脚本
 * 可见的全局标识符，因此这里只给**经典脚本**补一份 window 环境声明；
 * 模块之间的接口由 import/export 自行校验，不在这里登记。
 * 唯一的例外是 web/audio-picker.js 里那次 `import("./modules/file-browser-lazy.js")`：
 * 经典脚本与模块之间的动态 import，tsc 能按相对路径解析到真模块，无需在此声明。
 *
 * 只声明各模块**被其它文件实际用到的公开成员**，内部实现一律留 any：
 * 既能捕获调用侧的拼写错误 / 参数个数错误，又不需要随实现同步维护一份类型副本。
 * 这些声明不参与运行（不是 .js，不被 <script> 加载）。
 */

/* ---- i18n.zh.js / i18n.en.js → window.I18N_ZH / window.I18N_EN ----
 * 两份词典是纯数据（点分命名空间键 → 文案），由 i18n.js 在初始化时读取。
 * 值一般是字符串；emotion.labels 这类列表型字典值为数组。 */
type I18nDict = Record<string, string | string[]>;
declare const I18N_ZH: I18nDict;
declare const I18N_EN: I18nDict;

/* ---- i18n.js → window.I18N ---- */
interface I18NApi {
  lang(): string;
  /** 当前语言的 BCP-47 标签（zh-CN / en），供 Intl 使用 */
  locale(): string;
  /** 列表型字典值（如 emotion.labels）原样返回数组，供 UI 列表渲染。
   *  新增数组型字典键时在此补一条重载，否则调用侧会按 string 处理而报错。 */
  t(key: "emotion.labels"): string[];
  /** 查字典并按 params 插值 {name} 占位符；查不到时返回 key 本身 */
  t(key: string, params?: Record<string, unknown>): string;
  /** 复数文案：按 Intl.PluralRules 选 key.<category>，缺失回退 key.other；
   *  count 会以 {n} 注入 params。例：plural("dl.fileCount", 3) */
  plural(key: string, count: number, params?: Record<string, unknown>): string;
  /** 本地化数字，opts 透传 Intl.NumberFormat */
  num(n: number, opts?: Intl.NumberFormatOptions): string;
  /** 本地化日期/时间，缺省 dateStyle=medium + timeStyle=short；非法值返回 "" */
  date(v: Date | number | string, opts?: Intl.DateTimeFormatOptions): string;
  /** 本地化字节大小（B/KB/MB/GB/TB），数字与单位均走 Intl */
  bytes(n: number): string;
  /** 本地化百分比，入参为 0..100 的数值 */
  percent(n: number): string;
  setLang(next: string): void;
  /** 批量替换 data-i18n / -placeholder / -title / -aria-label 标注 */
  applyI18n(root?: ParentNode): void;
  /** 注册语言切换回调（web/app.js 的 rerenderAll / AudioPicker / 懒加载的 file-browser-lazy / VoicesPanel） */
  onChange(cb: () => void): void;
  /** 解析后端 {"code","params"} 错误体并翻译，无匹配 code 时原样返回 */
  errText(text: string): string;
  /** 英文模式下优先取 obj[field + "En"]，缺失回退原字段 */
  pick(obj: Record<string, unknown> | null | undefined, field: string): string;
}
declare const I18N: I18NApi;
declare interface Window {
  I18N: I18NApi;
  I18N_ZH: I18nDict;
  I18N_EN: I18nDict;
}

/* ---- boot.js → window.HubTheme ----
 * boot.js 在 <head> 内同步执行（首次绘制前写入 <html data-theme> 防闪烁），
 * 并把主题模式解析逻辑挂到 window 供 web/modules/shell.js 与 settings.js 复用，
 * 避免两处重复实现。 */
interface HubThemeApi {
  /** 读取持久化的主题模式："system" | "light" | "dark"（非法值回退 system） */
  mode(): "system" | "light" | "dark";
  /** 把模式解析为实际主题：system 跟随 prefers-color-scheme，其余原样返回 */
  resolve(m: string): "light" | "dark";
  /** 写入 data-theme（实际主题）与 data-theme-mode（原始模式），不落盘 */
  apply(m: string): void;
  /** 持久化并应用模式；返回归一化后的模式 */
  setMode(m: string): "system" | "light" | "dark";
}
declare interface Window {
  HubTheme: HubThemeApi;
}

/* ---- wav.js → window.WavUtil ---- */
interface WavUtilApi {
  decodeToAudioBuffer(data: ArrayBuffer): Promise<AudioBuffer>;
  /** 截取 [startSec, endSec]（秒）并编码为 PCM16 单声道 WAV；两者缺省即整段 */
  audioBufferToWav(buffer: AudioBuffer, startSec?: number, endSec?: number): Blob;
  formatDuration(sec: number): string;
  formatSize(bytes: number): string;
  warmAudioOutput(): void;
}
declare const WavUtil: WavUtilApi;
declare interface Window {
  WavUtil: WavUtilApi;
  /** Safari 老版本前缀兜底，lib.dom 未收录 */
  webkitAudioContext?: typeof AudioContext;
}

/* ---- audio-picker.js → window.AudioPicker ---- */
interface AudioPickerInstance {
  root: HTMLElement;
  /** 当前音频的服务器绝对路径；无值返回 null */
  getValue(): string | null;
  refreshLabels(): void;
  clear(): void;
}
interface AudioPickerCtor {
  new (mountEl: HTMLElement, title: string): AudioPickerInstance;
  /** 上传上限 50MB，与后端 audio.go 的 WAV 上限一致 */
  readonly MAX_BYTES: number;
}
declare const AudioPicker: AudioPickerCtor;
declare interface Window {
  AudioPicker: AudioPickerCtor;
  /** app.js 登记的已实例化 AudioPicker，重渲染时统一刷新标签 */
  __audioPickers?: AudioPickerInstance[];
}

/* ---- voice-select.js → window.VoiceSelect / window.refreshVoiceSelects ---- */
interface VoiceEntry {
  id: string;
  name: string;
  text?: string;
}
interface VoiceSelectInstance {
  root: HTMLElement;
  /** 当前选中的音色条目，无值返回 null */
  getSelected(): VoiceEntry | null;
  /** 当前选中音色的服务器音频路径；无值返回 null */
  getValue(): string | null;
  refresh(): Promise<void>;
  refreshLabels(): void;
  setVoice(vid: string): Promise<void>;
  /** 历史载入用；库外路径走「外部路径」兜底选项 */
  setByPath(path: string): Promise<void>;
  clear(): void;
}
interface VoiceSelectCtor {
  new (
    mountEl: HTMLElement,
    title?: string,
    opts?: { onChange?: (v: VoiceEntry | null) => void }
  ): VoiceSelectInstance;
}
declare const VoiceSelect: VoiceSelectCtor;
declare interface Window {
  VoiceSelect: VoiceSelectCtor;
  /** app.js 登记的已实例化 VoiceSelect */
  __voiceSelects?: VoiceSelectInstance[];
  /** 音色库增删改后刷新所有选择器选项（尽量保留选中） */
  refreshVoiceSelects(): void;
}

/* ---- 显式降级说明（见 web/README.md「已知降级」）----
 *
 * web/ 是无类型经典脚本，全局没有 `Element` 类型的局部变量可用（app.js 的 $() 已按 any 处理）。
 * 剩下这 22 处报错全部来自同一类：document.querySelector/querySelectorAll 用**通用选择器**
 * （".settings-nav-item"、"#tts-emotion-block .tab"），TypeScript 无法推断标签，只能给回
 * `Element`；而 Element 按规范不声明 dataset / title / onclick / value，EventTarget 不声明 closest。
 * 运行时这些节点确实都是 HTMLElement。
 *
 * 这里对 Element / EventTarget 做**最小增量**放宽（只加实际用到的成员，用真实类型而非 any），
 * 换取零代码改动的检查通过。代价是 `document.querySelector("div").value` 这类误用不再报错——
 * 属于有意接受的上限：真正有价值的检查（未定义标识符、参数个数、死代码、switch 贯穿、
 * 跨文件公开接口的拼写）不受影响。
 * lean-ctx: 上限=Element/EventTarget 的 4 个成员 + app.js 的 $()/el() 返回 any。
 * 升级条件：若将来引入 JSDoc 逐点收窄（app.js 3000+ 调用点），可移除本段。 */
declare interface Element {
  dataset?: DOMStringMap;
  title?: string;
  onclick?: ((this: GlobalThis, ev: MouseEvent) => unknown) | null;
  value?: string;
}
declare interface EventTarget {
  closest?: (selector: string) => Element | null;
}

/* ---- hub 错误信封：{"ok":false,"code","params","error"} ---- */
/** modules/async-ui.js 的 parseApiError() 给 Error 挂 code/params（供 I18N 按 err.<code> 映射），
 *  api() 抛出的 ApiError 则另带 status。见 api-client.js 的 ApiErrorOptions。 */
type HubHttpError = Error & {
  status?: number;
  /** 后端错误码，如 "INSTANCE_NOT_FOUND"；缺失时由 stateErrorMessage 回退 message */
  code?: string;
  /** 错误参数，供 I18N.t(key, params) 插值 */
  params?: Record<string, unknown>;
};

/* ---- api-client.js → window.AudioCppHub.api ----
 * 类型实现体在 web/api-client.js 顶部（@typedef RequestOptions/PollOptions/
 * ApiErrorOptions）。这里只声明 web/ 实际用到的成员，够用即可。
 * web/modules/api.js 通过 const Api = window.AudioCppHub.api 一次性绑定。 */
interface AudioCppHubRoot {
  api: {
    request(path: string, opts?: Record<string, unknown>): Promise<any>;
    get(path: string, opts?: Record<string, unknown>): Promise<any>;
    post(path: string, body?: unknown, opts?: Record<string, unknown>): Promise<any>;
    put(path: string, body?: unknown, opts?: Record<string, unknown>): Promise<any>;
    del(path: string, opts?: Record<string, unknown>): Promise<any>;
    list(path: string, opts?: Record<string, unknown>): Promise<any[]>;
    poll(
      path: string | (() => string),
      handler: (data: any) => void | Promise<void>,
      opts?: Record<string, unknown>
    ): { stop: () => void; refresh: () => Promise<void> };
    stopAllPollers(): void;
    /** 统一错误类型；构造签名见 api-client.js 的 ApiErrorOptions */
    ApiError: new (
      message: string,
      opts?: Record<string, unknown>
    ) => Error & {
      code: string;
      status: number;
      aborted: boolean;
      isAbort: boolean;
      isTimeout: boolean;
      isNetwork: boolean;
      isClient: boolean;
    };
    buildUrl(
      path: string,
      params?: Record<string, string>,
      query?: Record<string, string | number>
    ): string;
    CODE: Record<string, string>;
    DEFAULTS: Record<string, number>;
  };
}
declare interface Window {
  AudioCppHub: AudioCppHubRoot;
}

/* ---- modules/routing.js → window.hub* 路由 / 面板钩子 ----
 * web/modules/routing.js 是 hash 路由的唯一应用方（applyRoute）；下列钩子供晚于它
 * 加载的 voices-panel.js 等在按钮点击 / 关闭时与路由保持同步（#/voices 深链接、
 * 面板再次点击收起）。go / goPanel / parseRoute 等只在模块之间用 import 传递。 */
declare interface Window {
  /** 改 hash 触发 hashchange → applyRoute；同 hash 时直接重放（用于重试） */
  hubNavigate(hash: string): void;
  /** 页头按钮：同一面板再次点击则收起（回到默认模型路由） */
  hubTogglePanel(route: string): void;
  /** 重放一次 applyRoute（voices-panel.js 加载后补跑，使 #/voices 刷新可还原） */
  hubApplyRoute(): void;
  /** 由各 closeX() 调用：仅当当前路由仍指向该面板时才回退（避免误导航） */
  hubPanelClosed(view: string): void;
}

/* ---- voices-panel.js → window.openVoicesPanel / window.closeVoicesPanel ---- */
declare function openVoicesPanel(): void;
declare function closeVoicesPanel(): void;
declare interface Window {
  openVoicesPanel(): void;
  closeVoicesPanel(): void;
}

/* ---- motion.js → window.hubMotion ----
 * 纯 UI 动效触发器（复制确认 / 主题切换 / 实例状态翻转），不做任何业务判断。 */
interface HubMotionApi {
  /** 给节点加一次性动效类，ms 毫秒后移除；已开启 reduce 时直接跳过 */
  flash(node: Element | null | undefined, cls: string, ms?: number): void;
  /** 当前是否处于 prefers-reduced-motion: reduce */
  prefersReduced(): boolean;
}
declare interface Window {
  hubMotion: HubMotionApi;
}

/* ---- sw.js → Service Worker realm ----
 * sw.js 运行在 ServiceWorkerGlobalScope（独立 realm），既不是 window 也不是 Worker。
 * 本项目 tsconfig 的 lib 只含 ES2022/DOM；加 lib.webworker 会与 lib.dom 在同一
 * program 内重复声明 self/fetch/caches 等符号，所以按本文件开头的原则「只声明
 * 各模块被实际用到的成员」手写一份最小类型，由 sw.js 就地 cast 后使用。 */
interface HubExtendableEvent {
  waitUntil(promise: Promise<unknown>): void;
}
interface HubFetchEvent extends HubExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface HubMessageEvent {
  readonly data: { type?: string } | null;
}
interface HubServiceWorkerScope {
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "install" | "activate", listener: (e: HubExtendableEvent) => void): void;
  addEventListener(type: "message", listener: (e: HubMessageEvent) => void): void;
  addEventListener(type: "fetch", listener: (e: HubFetchEvent) => void): void;
}

/* ---- legacy-globals.js → window.$ / el 与 #88 三态原语的转发器 ----
 *
 * app.js 改成 ES 模块后，经典脚本里原本靠「同域顶层 const/function 自动成为全局」拿到的
 * $ / showToast / focusDialog / restoreDialogFocus 不再自动可见。web/legacy-globals.js
 * 是显式的桥：$/el 是真实实现（web/modules/dom.js 只绑定并再导出），另三个是转发器，
 * 真实实现在 web/modules/async-ui.js（showToast）与 web/modules/ui.js
 * （focusDialog / restoreDialogFocus），由 web/app.js 求值时回填到 window.AudioCppHubApp。
 *
 * 仍然直接用到它们的地方：audio-picker.js（window.showToast）、
 * voices-panel.js（$ / el / showToast / window.focusDialog / window.restoreDialogFocus，
 * 以及 #88 的 parseApiError / renderStateError / renderEmptyState）。 */
declare function $(id: string): any;
declare function el(html: string): any;
declare function showToast(level: string, message: string): void;
declare function focusDialog(overlay: any): void;
declare function restoreDialogFocus(): void;
declare function parseApiError(text: string): HubHttpError;
declare function renderStateError(
  container: any,
  error: unknown,
  retry?: () => void,
  raw?: boolean
): void;
declare function renderEmptyState(container: any, message: string, cta?: unknown): void;
declare interface Window {
  $(id: string): any;
  el(html: string): any;
  showToast(level: string, message: string): void;
  focusDialog(overlay: any): void;
  restoreDialogFocus(): void;
  parseApiError(text: string): HubHttpError;
  renderStateError(container: any, error: unknown, retry?: () => void, raw?: boolean): void;
  renderEmptyState(container: any, message: string, cta?: unknown): void;
  /** legacy-globals.js 先建空壳，web/app.js 在模块求值时回填真实实现 */
  AudioCppHubApp: {
    showToast?: (level: string, message: string) => void;
    focusDialog?: (overlay: any) => void;
    restoreDialogFocus?: () => void;
    parseApiError?: (text: string) => HubHttpError;
    renderStateError?: (container: any, error: unknown, retry?: () => void, raw?: boolean) => void;
    renderEmptyState?: (container: any, message: string, cta?: unknown) => void;
  };
}
