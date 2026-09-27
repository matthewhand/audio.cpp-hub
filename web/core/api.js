/* typed API 客户端：统一 fetch + JSON 请求头 + 错误信封解析 + AbortController 取消。
   - 成功：返回解析后的 JSON（响应体为空返回 null）；GET 列表接口直接返回裸数组。
   - 失败：HTTP 非 2xx，或 200 但 body.ok === false → 抛 ApiError。
   - ApiError.message 已用 I18N.errText 翻译，沿用原有提示文案（含 code→err.CODE 字典翻译）。
   采用方式：所有应用模块的 fetch 调用都走这里，调用方只需 try/catch e.message。 */
import { I18N } from "./i18n.js";

/**
 * @typedef {Object} ApiErrorInit
 * @property {string|null} [code]   后端错误码（如 "VOICE_NAME_EXISTS"）
 * @property {Object} [params]      错误码占位参数
 * @property {number} [status]      HTTP 状态码
 */

/** 带 code / params / status 的 API 错误。 */
export class ApiError extends Error {
  constructor(message, { code = null, params = {}, status = 0 } = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.params = params;
    this.status = status;
  }
}

/**
 * 发起一次 JSON API 请求。
 * @param {string} path
 * @param {{method?:string, body?:any, signal?:AbortSignal, headers?:Object}} [opts]
 * @returns {Promise<any>} 解析后的 JSON（无响应体为 null）
 */
export async function apiRequest(path, opts = {}) {
  const { method = "GET", body, signal, headers } = opts;
  const init = { method, headers: { ...(headers || {}) }, signal };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = null;
    }
  }
  // 错误判定：HTTP 非 2xx，或响应体是明确的错误信封（ok:false 且带 code/error）。
  // 只认 code/error 可避免把恰好含 ok:false 的正常结果（如引擎结果 JSON）误判为错误。
  const envelopeError =
    data && typeof data === "object" && data.ok === false && (data.code || data.error);
  if (!res.ok || envelopeError) {
    throw new ApiError(I18N.errText(text), {
      code: data && data.code,
      params: data && data.params,
      status: res.status,
    });
  }
  return data;
}

/** GET，返回解析后的 JSON。 */
export const apiGet = (path, opts) => apiRequest(path, { ...opts, method: "GET" });
/** POST JSON body。 */
export const apiPost = (path, body, opts) => apiRequest(path, { ...opts, method: "POST", body });
/** PUT JSON body。 */
export const apiPut = (path, body, opts) => apiRequest(path, { ...opts, method: "PUT", body });
/** DELETE。 */
export const apiDelete = (path, opts) => apiRequest(path, { ...opts, method: "DELETE" });

/* 供仍为经典脚本的组件（voices-panel.js / voice-select.js / audio-picker.js / file-browser.js）
   通过 window 桥接复用同一 client（它们无法静态 import ES module）。 */
window.HubApi = { ApiError, apiRequest, apiGet, apiPost, apiPut, apiDelete };

/**
 * @typedef {Object} Model 模型清单条目（models.json）
 * @property {string} id
 * @property {string} category  tts|asr|sep|music|other
 * @property {string} family
 * @property {string} displayName
 * @property {string} [displayNameEn]
 * @property {Object} [paramSchema]
 * @property {Object} [inputs]
 * @property {Object} [language]
 * @property {string} [hfUrl]
 * @property {string} [ggufUrl]
 *
 * @typedef {Object} Executable 已登记的 audiocpp_server 可执行文件
 * @property {string} id
 * @property {string} name
 * @property {string} path
 * @property {string} [note]
 * @property {Object} [env]
 * @property {boolean} exists
 *
 * @typedef {Object} Profile 启动配置
 * @property {string} id
 * @property {string} modelId
 * @property {string} name
 * @property {string} weightsPath
 * @property {string} backend
 * @property {string} [instanceName]
 * @property {string} [executableId]
 * @property {number} [device]
 * @property {number} [port]
 * @property {number} [threads]
 * @property {Object} [sessionOptions]
 *
 * @typedef {Object} Instance 运行中的模型实例
 * @property {string} id
 * @property {string} modelId
 * @property {string} instanceName
 * @property {string} status  STARTING|READY|ERROR|STOPPED
 * @property {string} backend
 * @property {number} [device]
 * @property {number} port
 * @property {number} [threads]
 * @property {string} weightsPath
 * @property {string} [executableName]
 * @property {number} [taskCount]
 * @property {string} [errorMessage]
 * @property {number} [createdAt]
 * @property {Object} [sessionOptions]
 *
 * @typedef {Object} Task 推理任务
 * @property {string} id
 * @property {string} instanceId
 * @property {string} modelId
 * @property {string} category  tts|asr|sep|music|other
 * @property {string} status    QUEUED|RUNNING|DONE|FAILED|CANCELLED
 * @property {number} position
 * @property {string} [instanceName]
 * @property {string} [text]
 * @property {string} [error]
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 *
 * @typedef {Object} HistoryRecord TTS 操作历史记录
 * @property {string} taskId
 * @property {number} time
 * @property {boolean} ok
 * @property {string} [text]
 * @property {Object} [voice]
 * @property {Object} [refs]
 * @property {Object} [options]
 * @property {string} [language]
 * @property {Object} [result]
 * @property {string} [error]
 * @property {string} [instanceName]
 * @property {string} [groupId]
 *
 * @typedef {Object} DownloadTask 权重下载任务
 * @property {string} id
 * @property {string} [modelId]
 * @property {string} targetDir
 * @property {string} status  PENDING|RUNNING|PAUSED|DONE|FAILED
 * @property {number} percent
 * @property {number} downloadedBytes
 * @property {number} totalBytes
 * @property {number} speedBps
 * @property {number} completedFiles
 * @property {number} fileCount
 * @property {string} [error]
 *
 * @typedef {Object} DeviceEntry 探测到的设备
 * @property {string} backend
 * @property {number} index
 * @property {string} name
 * @property {string} [type]
 */
