/* web/modules/api.js — HTTP 出口
 *
 * 唯一的 HTTP 出口是 web/api-client.js（经典脚本，挂在 window.AudioCppHub.api）：
 * 集中 fetch、错误信封（ApiError 带 code/params）、AbortController 超时与中断、
 * 可见性感知轮询（Api.poll）。这里只做一次绑定再导出，不重复实现、不再包装。
 * 新增请求一律经由本模块的 Api，不要直接 fetch。 */

export const Api = window.AudioCppHub.api;
