/* web/modules/settings-lazy.js — 设置弹窗的懒加载外观 + 首屏常驻部分
 *
 * 与 modules/stats-lazy.js / modules/file-browser-lazy.js 同一形状，切分线不是
 * 「整个模块」而是「点击才用得上 vs 首屏就要用」：
 *
 *   首屏（留在本外观层）  - 可执行文件登记的**数据与状态机**：loadExecutables
 *                         （app.js 启动时拉一次，模型卡片的已配置态依赖它）、
 *                         启动弹窗的可执行文件下拉 updateLaunchExec、设备探测缓存
 *                         deviceCache、增删改表单的字段读写（launch.js 在启动弹窗里
 *                         复用同一张表单，见其 exec-add-btn 绑定）
 *   懒加载 chunk         - 设置弹窗本身的三个分节：通用（界面语言 / 主题）、
 *                         HTTPS 证书（唯一的 blob 下载路径）、可执行文件列表渲染，
 *                         即 modules/settings.js
 *
 * 换句话说：证书面板与弹窗框架只有打开设置才用得上，而可执行文件登记是全局数据
 * ——启动弹窗与模型卡片都要它，不能懒加载。实测表见 scripts/perf-budget.mjs 顶注。 */

import { focusDialog, isOpen, renderListError, restoreDialogFocus } from "./async-ui.js";
import { $, Api, t } from "./dom.js";
import { renderModelList } from "./models.js";
import { executables, models, setExecutables } from "./state.js";

let mod = null;      // 已解析的 settings.js 模块命名空间，null 直到首次打开
let inflight = null; // 进行中的动态 import，让并发打开共享同一次网络往返

/* ---------- 首屏常驻：可执行文件登记 ---------- */
/* 每个可执行文件的探测结果缓存（id → devices 数组）；可执行文件增删改时整体清空。
   缓存随可执行文件登记一起失效，因此归本模块；写入方（--list-devices 探测）在 launch.js。 */
export const deviceCache = {};

/* 正在编辑的可执行文件 id，null 表示新增模式；表单默认收起，点“新增”/“编辑”才展开。
   写方跨模块（launch.js 的提交按钮、chunk 的 startEditExec），因此配 setter
   （与 state.js 的可写绑定同一手法）。 */
export let editingExecId = null;
export function setEditingExecId(id) {
  editingExecId = id;
}

export async function loadExecutables() {
  // 可执行文件可能已增删改：设备探测缓存整体失效
  for (const k of Object.keys(deviceCache)) delete deviceCache[k];
  try {
    setExecutables(await Api.list("/api/executables"));
  } catch (e) {
    setExecutables([]);
    if (mod) renderListError($("exec-list"), t("common.loadFailed") + t("common.colon") + e.message, loadExecutables);
    updateLaunchExec();
    return;
  }
  if (mod) mod.renderExecList();
  updateLaunchExec();
  // 可执行文件有效性也影响模型卡片的已配置/黯淡状态
  if (models.length) renderModelList();
}

/* 启动弹窗的可执行文件下拉：无可用程序时显示占位项并禁用启动按钮 */
export function updateLaunchExec() {
  const sel = $("launch-exec");
  sel.innerHTML = "";
  const empty = executables.length === 0;
  if (empty) {
    // 无可用程序时显示占位项，点击下拉即跳转到设置页添加（见 wireSettingsButtons）
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = t("launch.execNone");
    sel.appendChild(opt);
  }
  for (const ex of executables) {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.name + (ex.exists ? "" : t("exec.missingSuffix"));
    sel.appendChild(opt);
  }
  sel.classList.toggle("exec-empty", empty);
  $("launch-btn").disabled = empty;
  $("exec-empty-hint").classList.toggle("hidden", !empty);
}

/* 解析环境变量输入：每行 KEY=VALUE，空行忽略；格式错误抛带行号的异常 */
export function parseEnvText() {
  const env = {};
  const lines = $("exec-env").value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(line.substring(0, eq).trim())) {
      throw new Error(t("exec.envInvalid", { line: i + 1 }));
    }
    env[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  }
  return env;
}

export function envToText(env) {
  if (!env) return "";
  return Object.entries(env).map(([k, v]) => k + "=" + v).join("\n");
}

export function parseSessionOptionsText() {
  const options = {};
  const lines = $("launch-adv-options").value.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error(t("launch.advInvalid", { line: i + 1 }));
    options[line.substring(0, eq).trim()] = line.substring(eq + 1).trim();
  }
  return options;
}

/* 可执行文件增删改表单：默认收起，点“新增”/“编辑”才展开 */
export function showExecForm() {
  $("exec-form-section").classList.remove("hidden");
}

export function hideExecForm() {
  $("exec-form-section").classList.add("hidden");
  $("exec-msg").textContent = "";
}

export function resetExecForm() {
  setEditingExecId(null);
  $("exec-name").value = "";
  $("exec-path").value = "";
  $("exec-note").value = "";
  $("exec-env").value = "";
  const title = $("exec-form-title");
  title.dataset.i18n = "exec.addTitle";
  title.textContent = t("exec.addTitle");
  const btn = $("exec-add-btn");
  btn.dataset.i18n = "exec.add";
  btn.textContent = t("exec.add");
  hideExecForm();
}

/* ---------- 懒加载 chunk 的接线 ---------- */
/* 加载真模块（幂等、并发去重；失败不缓存，允许下次重试）。 */
function ensure() {
  if (mod) return Promise.resolve(mod);
  if (!inflight) {
    inflight = import("./settings.js").then(
      m => (mod = m),
      e => {
        inflight = null;
        throw e;
      }
    );
  }
  return inflight;
}

/* 打开 / 关闭之间的竞态：chunk 还在路上时用户按了 Esc（外壳已显示但内容未到）。
   记下来让打开路径在 chunk 落地后不再打开面板，否则「按了 Esc 弹窗又弹出来」。 */
let pendingClose = false;

/* 打开设置弹窗：外壳（静态 DOM）同步显示并接管焦点，chunk 到位后再初始化分节
   （与 downloads-lazy / stats-lazy 同一手法：外壳先出，点击反馈即时）。 */
export async function openSettingsModal(section) {
  pendingClose = false;
  const modal = $("settings-modal");
  modal.classList.remove("hidden");
  focusDialog(modal);
  try {
    const m = await ensure();
    if (pendingClose) return; // Esc 先到了：外壳已收回去，别再初始化
    m.openSettingsModal(section);
  } catch (e) {
    console.error("settings: failed to load panel module", e);
    modal.classList.add("hidden");
  }
}

/* 同步关闭：chunk 还在路上时（外壳已显示、内容未到）只把外壳收回去并回退路由。 */
export function closeSettingsModal() {
  if (mod) {
    mod.closeSettingsModal();
    return;
  }
  if (!isOpen("settings-modal")) return;
  pendingClose = true;
  $("settings-modal").classList.add("hidden");
  restoreDialogFocus();
  if (window.hubPanelClosed) window.hubPanelClosed("settings");
}

/* 语言切换重画（app.js rerenderAll）：未加载即空转，交给 chunk 重新本地化。 */
export function relocalizeSettings() {
  if (mod) mod.relocalize();
}

/* 进设置弹窗的两个入口按钮必须在 chunk 到位前就能用，因此在外观层接线：
   页头 ⚙（设置）以及启动弹窗「无可用程序」提示里的跳转按钮。
   go / goPanel / setPendingSettingsSection 由 routing.js 传入以避开与它的模块环。 */
export function wireSettingsButtons(go, goPanel, setPendingSettingsSection) {
  const settingsBtn = $("settings-btn");
  if (settingsBtn) settingsBtn.onclick = () => { setPendingSettingsSection("general"); goPanel("settings"); };
  const gotoBtn = $("exec-goto-btn");
  if (gotoBtn) gotoBtn.onclick = () => { setPendingSettingsSection("executables"); go("#/settings"); };
}
