/* audio.cpp-hub 前端：开发期类型声明（纯类型，无运行期文件）。
 *
 * web/ 下的脚本是经典脚本（classic script），按 web/index.html 底部的 <script src>
 * 顺序加载，并把公开接口挂到 `window.*`。TypeScript 的 checkJs 不会把「某个脚本里的
 * `window.X = ...` 赋值」推断成其它脚本可见的全局标识符，因此这里补一份环境声明。
 *
 * 只声明各模块**被其它文件实际用到的公开成员**，内部实现一律留 any：
 * 既能捕获调用侧的拼写错误 / 参数个数错误，又不需要随实现同步维护一份类型副本。
 * 这些声明不参与运行（不是 .js，不被 <script> 加载）。
 */

/* ---- i18n.js → window.I18N ---- */
interface I18NApi {
  lang(): string;
  /** 列表型字典值（如 emotion.labels）原样返回数组，供 UI 列表渲染。
   *  新增数组型字典键时在此补一条重载，否则调用侧会按 string 处理而报错。 */
  t(key: "emotion.labels"): string[];
  /** 查字典并按 params 插值 {name} 占位符；查不到时返回 key 本身 */
  t(key: string, params?: Record<string, unknown>): string;
  setLang(next: string): void;
  /** 批量替换 data-i18n / -placeholder / -title 标注 */
  applyI18n(root?: ParentNode): void;
  /** 注册语言切换回调（app.js / AudioPicker / FileBrowser） */
  onChange(cb: () => void): void;
  /** 解析后端 {"code","params"} 错误体并翻译，无匹配 code 时原样返回 */
  errText(text: string): string;
  /** 英文模式下优先取 obj[field + "En"]，缺失回退原字段 */
  pick(obj: Record<string, unknown> | null | undefined, field: string): string;
}
declare const I18N: I18NApi;
declare interface Window {
  I18N: I18NApi;
}

/* ---- boot.js → window.HubTheme ----
 * boot.js 在 <head> 内同步执行（首次绘制前写入 <html data-theme> 防闪烁），
 * 并把主题模式解析逻辑挂到 window 供 app.js 复用，避免两处重复实现。 */
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

/* ---- file-browser.js → window.FileBrowser ---- */
interface FileBrowserOptions {
  /** file=选文件，dir=选目录 */
  mode: "file" | "dir";
  title: string;
  /** 仅 file 模式；自动附带「所有文件」选项 */
  extensions?: string[];
  startPath?: string;
  defaultAll?: boolean;
}
interface FileBrowserApi {
  /** 打开服务器端文件系统浏览弹窗；用户取消返回 null */
  open(options: FileBrowserOptions): Promise<string | null>;
  isOpen(): boolean;
  cancel(): void;
  relocalize(): void;
}
declare const FileBrowser: FileBrowserApi;
declare interface Window {
  FileBrowser: FileBrowserApi;
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

/* ---- api() 抛出的带状态码错误 ---- */
/** app.js 的 api() 给 Error 挂 status，调用侧按 404 等状态码分支处理 */
type HubHttpError = Error & { status?: number };

/* ---- api-client.js → window.AudioCppHub.api ----
 * 类型实现体在 web/api-client.js 顶部（@typedef RequestOptions/PollOptions/
 * ApiErrorOptions）。这里只声明 app.js 实际用到的成员，够用即可。
 * app.js 通过 const Api = window.AudioCppHub.api 一次性取用。 */
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

/* ---- voices-panel.js → window.openVoicesPanel / window.closeVoicesPanel ---- */
declare function openVoicesPanel(): void;
declare function closeVoicesPanel(): void;
declare interface Window {
  openVoicesPanel(): void;
  closeVoicesPanel(): void;
}
