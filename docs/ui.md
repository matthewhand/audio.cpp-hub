# Web UI 清单

> 由 `npm run ui:inventory` 从 `web/index.html` 与 `web/*.js` 自动生成，请勿手改。
> 漂移检查：`npm run ui:inventory:check`（CI 会跑）。

来源：`web/index.html` + `web/boot.js`、`web/i18n.js`、`web/wav.js`、`web/file-browser.js`、`web/audio-picker.js`、`web/voice-select.js`、`web/app.js`、`web/voices-panel.js`

## 面板地图

| id | 类型 | 首个 i18n key | i18n key 数 |
| --- | --- | --- | --- |
| `busy-overlay` | modal | `busy.label` | 1 |
| `downloads-modal` | modal | `dl.managerTitle` | 2 |
| `history-panel` | modal | `history.title` | 5 |
| `instance-detail-modal` | modal | `instance.detailTitle` | 2 |
| `launch-modal` | modal | `launch.title` | 25 |
| `model-dl-modal` | modal | `dl.title` | 11 |
| `panel-asr` | panel | `common.advanced` | 4 |
| `panel-music` | panel | `music.styleLabel` | 13 |
| `panel-other` | panel | `other.extraLabel` | 2 |
| `panel-sep` | panel | `sep.hint` | 2 |
| `panel-tts` | panel | `tts.textLabel` | 17 |
| `settings-modal` | modal | `settings.title` | 40 |
| `settings-pane-executables` | settings-pane | `exec.listTitle` | 13 |
| `settings-pane-general` | settings-pane | `settings.general.language` | 6 |
| `settings-pane-https` | settings-pane | `https.enableLabel` | 16 |
| `voices-panel` | modal | `voices.title` | 6 |

## 控件

| id | 标签 | 类型 | i18n key | 事件 |
| --- | --- | --- | --- | --- |
| `asr-copy` | button | — | `asr.copy` | `click` |
| `asr-submit` | button | — | `asr.submit` | `click` |
| `downloads-btn` | button | — | `dl.managerTitle` | `click` |
| `downloads-modal-close` | button | — | `history.closeTitle` | `click` |
| `exec-add-btn` | button | — | `exec.add` | `click` |
| `exec-browse-btn` | button | — | `launch.browse` | `click` |
| `exec-cancel-edit-btn` | button | — | `exec.cancel` | `click` |
| `exec-env` | textarea | — | `exec.envPlaceholder` | — |
| `exec-goto-btn` | button | — | `launch.execGoto` | `click` |
| `exec-name` | input | text | `exec.namePlaceholder` | — |
| `exec-new-btn` | button | — | `exec.new` | `click` |
| `exec-note` | input | text | — | — |
| `exec-path` | input | text | `exec.pathPlaceholder` | — |
| `history-btn` | button | — | `history.title` | `click` |
| `history-clear` | button | — | `history.clear` | `click` |
| `history-close` | button | — | `history.closeTitle`<br>`history.closeTitle` | `click` |
| `history-group-new` | button | — | `history.groupNew` | `click` |
| `history-privacy` | button | — | — | `click` |
| `history-refresh` | button | — | `history.refresh` | `click` |
| `https-download-ca` | button | — | `https.downloadCa` | `click` |
| `https-download-keystore` | button | — | `https.downloadKeystore` | `click` |
| `https-enabled` | input | checkbox | — | `change` |
| `https-generate-btn` | button | — | `https.generate` | `click` |
| `https-hostnames` | textarea | — | — | — |
| `https-ips` | textarea | — | — | — |
| `https-keysize` | select | — | — | — |
| `https-password` | input | text | `https.passwordPlaceholder` | — |
| `https-validity` | input | number | — | — |
| `instance-detail` | button | — | `instance.detail` | `click` |
| `instance-detail-close` | button | — | `history.closeTitle` | `click` |
| `instance-select` | select | — | — | `change` |
| `instance-stop` | button | — | `instance.stopCurrent` | `click` |
| `lang-toggle` | button | — | `header.langTitle` | `click` |
| `launch-adv-options` | textarea | — | — | — |
| `launch-backend` | select | — | — | — |
| `launch-btn` | button | — | `launch.submit` | `click` |
| `launch-device` | select | — | — | `change` |
| `launch-exec` | select | — | — | `change`, `mousedown` |
| `launch-modal-close` | button | — | `history.closeTitle` | `click` |
| `launch-name` | input | text | `launch.namePlaceholder` | — |
| `launch-open-btn` | button | — | `instance.create` | `click` |
| `launch-port` | input | number | `launch.portPlaceholder` | — |
| `launch-profile` | select | — | — | `change` |
| `launch-threads` | input | number | `launch.threadsPlaceholder` | `input` |
| `launch-weights` | input | text | `launch.weightsPlaceholder` | `input` |
| `mdl-endpoint` | select | — | — | — |
| `mdl-overwrite` | input | checkbox | — | — |
| `mdl-start` | button | — | `dl.start` | `click` |
| `mdl-token` | input | text | `dl.tokenPlaceholder` | — |
| `menu-toggle` | button | — | `header.menuTitle` | `click` |
| `model-dl-modal-close` | button | — | `history.closeTitle` | `click` |
| `music-abc` | textarea | — | `music.abcPlaceholder` | — |
| `music-cot` | select | — | — | — |
| `music-lyrics` | textarea | — | `music.lyricsPlaceholder` | — |
| `music-seed` | input | text | `music.seedPlaceholder` | — |
| `music-style` | textarea | — | `music.stylePlaceholder` | — |
| `music-submit` | button | — | `music.submit` | `click` |
| `other-extra` | textarea | — | — | — |
| `other-submit` | button | — | `other.submit` | `click` |
| `profile-del-btn` | button | — | `launch.profileDelete` | `click` |
| `profile-save-btn` | button | — | `launch.profileSave` | `click` |
| `sep-submit` | button | — | `sep.submit` | `click` |
| `settings-btn` | button | — | `header.settingsTitle` | `click` |
| `settings-modal-close` | button | — | `history.closeTitle` | `click` |
| `theme-toggle` | button | — | `header.themeTitle` | `click` |
| `tts-download` | a | — | `tts.download` | — |
| `tts-emotion-alpha` | input | range | `emotion.alphaLabel` | `input` |
| `tts-emotion-text` | input | text | `emotion.textPlaceholder` | — |
| `tts-speaker-add` | button | — | `tts.speakerAdd` | `click` |
| `tts-submit` | button | — | `tts.submit` | `click` |
| `tts-text` | textarea | — | `tts.textPlaceholder` | — |
| `ui-language` | select | — | — | `change` |
| `ui-theme` | select | — | — | `change` |
| `voice-add-btn` | button | — | `voices.add` | `click` |
| `voice-add-name` | input | text | `voices.namePlaceholder` | — |
| `voice-add-text` | textarea | — | `voices.textPlaceholder` | — |
| `voices-btn` | button | — | `voices.title` | `click` |
| `voices-close` | button | — | `history.closeTitle`<br>`history.closeTitle` | `click` |
| `weights-browse-btn` | button | — | `launch.browseDir` | `click` |
| `weights-gguf-btn` | button | — | `launch.browseGguf` | `click` |

## 键盘快捷键

| 按键 | 判定 | 来源 |
| --- | --- | --- |
| ` ` | 等值 | `web/audio-picker.js` |
| `Enter` | 等值 | `web/audio-picker.js` |
| `Enter` | 等值 | `web/file-browser.js` |
| `Escape` | 等值 | `web/app.js` |
| `Escape` | 非 (guard) | `web/app.js` |
| `Escape` | 等值 | `web/file-browser.js` |
| `Tab` | 非 (guard) | `web/app.js` |

说明：上表由源码中的 `e.key === "..."` 判定推导；Escape 用于关闭最上层弹窗 / 菜单，
Enter / Space 用于文件浏览与文件选择。快捷键未集中注册，散落在各模块事件处理器中。

## API 端点（前端引用）

| 方法 | 路径 | 来源 |
| --- | --- | --- |
| POST | `/api/audio/info` | `web/audio-picker.js` |
| POST | `/api/audio/upload` | `web/audio-picker.js` |
| POST | `/api/cert/generate` | `web/app.js` |
| GET | `/api/cert/status` | `web/app.js` |
| GET | `/api/downloads` | `web/app.js` |
| POST | `/api/downloads` | `web/app.js` |
| DELETE | `/api/downloads/{param}?purge=true` | `web/app.js` |
| POST | `/api/downloads/{param}/{param}` | `web/app.js` |
| GET | `/api/events` | `web/app.js` |
| GET | `/api/executables` | `web/app.js` |
| POST | `/api/executables` | `web/app.js` |
| DELETE | `/api/executables/{param}` | `web/app.js` |
| PUT | `/api/executables/{param}` | `web/app.js` |
| GET | `/api/executables/{param}/devices` | `web/app.js` |
| GET | `/api/fs/list?path={param}` | `web/file-browser.js` |
| POST | `/api/fs/mkdir` | `web/file-browser.js` |
| GET | `/api/fs/roots` | `web/file-browser.js` |
| DELETE | `/api/history/{param}` | `web/app.js` |
| GET | `/api/history/{param}` | `web/app.js` |
| DELETE | `/api/history/{param}/{param}` | `web/app.js` |
| GET | `/api/history/{param}/{param}` | `web/app.js` |
| PUT | `/api/history/{param}/{param}/group` | `web/app.js` |
| GET | `/api/history/{param}/groups` | `web/app.js` |
| POST | `/api/history/{param}/groups` | `web/app.js` |
| DELETE | `/api/history/{param}/groups/{param}` | `web/app.js` |
| PUT | `/api/history/{param}/groups/{param}` | `web/app.js` |
| POST | `/api/https/config` | `web/app.js` |
| GET | `/api/instances` | `web/app.js` |
| POST | `/api/instances` | `web/app.js` |
| DELETE | `/api/instances/{param}` | `web/app.js` |
| GET | `/api/models` | `web/app.js` |
| GET | `/api/models/{param}/packages` | `web/app.js` |
| GET | `/api/profiles` | `web/app.js` |
| POST | `/api/profiles` | `web/app.js` |
| DELETE | `/api/profiles/{param}` | `web/app.js` |
| PUT | `/api/profiles/{param}` | `web/app.js` |
| POST | `/api/tasks` | `web/app.js` |
| GET | `/api/tasks?modelId={param}` | `web/app.js` |
| DELETE | `/api/tasks/{param}` | `web/app.js` |
| GET | `/api/tasks/{param}` | `web/app.js` |
| GET | `/api/tasks/{param}/result` | `web/app.js` |
| GET | `/api/voices` | `web/audio-picker.js`, `web/voice-select.js`, `web/voices-panel.js` |
| POST | `/api/voices` | `web/voices-panel.js` |
| DELETE | `/api/voices/{param}` | `web/voices-panel.js` |
| PUT | `/api/voices/{param}` | `web/voices-panel.js` |
| GET | `/api/voices/{param}/audio` | `web/audio-picker.js` |

路径中的 `{param}` 表示由运行时拼接/模板插值（如实例 id、任务 id）。

## data-* 钩子

| 属性 | 静态出现次数 |
| --- | --- |
| `data-i18n` | 115 |
| `data-i18n-aria-label` | 8 |
| `data-i18n-placeholder` | 17 |
| `data-i18n-title` | 9 |
| `data-mode` | 4 |
| `data-section` | 3 |
| `data-theme` | 1 |
