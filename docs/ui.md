# Web UI 清单

> 由 `npm run ui:inventory` 从 `web/index.html` 与 `web/*.js`、`web/modules/*.js` 自动生成，请勿手改。
> 漂移检查：`npm run ui:inventory:check`（CI 会跑）。

来源：`web/index.html` + `web/api-client.js`、`web/app.js`、`web/audio-picker.js`、`web/boot.js`、`web/i18n.en.js`、`web/i18n.js`、`web/i18n.zh.js`、`web/legacy-globals.js`、`web/modules/async-ui.js`、`web/modules/command-palette.js`、`web/modules/dom.js`、`web/modules/downloads.js`、`web/modules/file-browser-lazy.js`、`web/modules/file-browser.js`、`web/modules/instances.js`、`web/modules/launch.js`、`web/modules/models.js`、`web/modules/panels.js`、`web/modules/routing.js`、`web/modules/settings.js`、`web/modules/shell.js`、`web/modules/sidebar.js`、`web/modules/state.js`、`web/modules/stats-lazy.js`、`web/modules/stats.js`、`web/modules/tasks.js`、`web/motion.js`、`web/pwa.js`、`web/voice-select.js`、`web/voices-panel.js`、`web/wav.js`

## 面板地图

| id | 类型 | 首个 i18n key | i18n key 数 |
| --- | --- | --- | --- |
| `busy-overlay` | modal | `busy.label` | 1 |
| `command-palette` | modal | `palette.title` | 3 |
| `downloads-modal` | modal | `dl.managerTitle` | 2 |
| `history-panel` | modal | `history.title` | 7 |
| `instance-detail-modal` | modal | `instance.detailTitle` | 2 |
| `launch-modal` | modal | `launch.title` | 28 |
| `model-dl-modal` | modal | `dl.title` | 11 |
| `panel-asr` | panel | `asr.title` | 5 |
| `panel-music` | panel | `music.title` | 14 |
| `panel-other` | panel | `other.title` | 4 |
| `panel-sep` | panel | `sep.title` | 3 |
| `panel-tts` | panel | `tts.title` | 19 |
| `settings-modal` | modal | `settings.title` | 43 |
| `settings-pane-executables` | settings-pane | `exec.listTitle` | 13 |
| `settings-pane-general` | settings-pane | `settings.general.language` | 7 |
| `settings-pane-https` | settings-pane | `https.enableLabel` | 18 |
| `stats-panel` | modal | `stats.title` | 3 |
| `voices-panel` | modal | `voices.title` | 8 |

## 控件

| id | 标签 | 类型 | i18n key | 事件 |
| --- | --- | --- | --- | --- |
| `asr-copy` | button | — | `asr.copy` | `click` |
| `asr-submit` | button | — | `asr.submit` | `click` |
| `command-palette-input` | input | text | `palette.placeholder`<br>`palette.title` | `input`, `keydown` |
| `downloads-btn` | button | — | `dl.managerTitle`<br>`dl.managerTitle` | `click` |
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
| `history-btn` | button | — | `history.title`<br>`history.title` | `click` |
| `history-clear` | button | — | `history.clear` | `click` |
| `history-close` | button | — | `history.closeTitle`<br>`history.closeTitle` | `click` |
| `history-group-new` | button | — | `history.groupNew` | `click` |
| `history-privacy` | button | — | `history.privacyBtn` | `click` |
| `history-refresh` | button | — | `history.refresh` | `click` |
| `https-download-ca` | button | — | `https.downloadCa` | `click` |
| `https-download-keystore` | button | — | `https.downloadKeystore` | `click` |
| `https-enabled` | input | checkbox | `https.enableLabel` | `change` |
| `https-generate-btn` | button | — | `https.generate` | `click` |
| `https-hostnames` | textarea | — | `https.hostnamesPlaceholder` | — |
| `https-ips` | textarea | — | `https.ipsPlaceholder` | — |
| `https-keysize` | select | — | — | — |
| `https-password` | input | text | `https.passwordPlaceholder` | — |
| `https-validity` | input | number | — | — |
| `instance-detail` | button | — | `instance.detail` | `click` |
| `instance-detail-close` | button | — | `history.closeTitle` | `click` |
| `instance-select` | select | — | `instance.barLabel` | `change` |
| `instance-stop` | button | — | `instance.stopCurrent` | `click` |
| `lang-toggle` | button | — | `header.langTitle`<br>`header.langTitle` | `click` |
| `launch-adv-options` | textarea | — | `launch.advOptionsPlaceholder` | — |
| `launch-backend` | select | — | — | — |
| `launch-btn` | button | — | `launch.submit` | `click` |
| `launch-device` | select | — | — | `change` |
| `launch-exec` | select | — | — | `change`, `mousedown` |
| `launch-idle-unload` | input | number | `launch.idleUnloadPlaceholder` | `input` |
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
| `menu-toggle` | button | — | `a11y.openMenu`<br>`a11y.openMenu` | `click` |
| `model-dl-modal-close` | button | — | `history.closeTitle` | `click` |
| `music-abc` | textarea | — | `music.abcPlaceholder` | — |
| `music-cot` | select | — | — | — |
| `music-lyrics` | textarea | — | `music.lyricsPlaceholder` | — |
| `music-seed` | input | text | `music.seedPlaceholder` | — |
| `music-style` | textarea | — | `music.stylePlaceholder` | — |
| `music-submit` | button | — | `music.submit` | `click` |
| `other-extra` | textarea | — | `other.extraPlaceholder` | — |
| `other-submit` | button | — | `other.submit` | `click` |
| `profile-del-btn` | button | — | `launch.profileDelete` | `click` |
| `profile-save-btn` | button | — | `launch.profileSave` | `click` |
| `sep-submit` | button | — | `sep.submit` | `click` |
| `settings-btn` | button | — | `header.settingsTitle`<br>`header.settingsTitle` | `click` |
| `settings-modal-close` | button | — | `history.closeTitle` | `click` |
| `skip-to-content` | a | — | `a11y.skipToContent` | — |
| `stats-btn` | button | — | `stats.title`<br>`stats.title` | — |
| `stats-close` | button | — | `history.closeTitle`<br>`history.closeTitle` | `click` |
| `stats-refresh` | button | — | `history.refresh` | `click` |
| `theme-toggle` | button | — | `header.themeTitle`<br>`header.themeTitle` | `click` |
| `tts-download` | a | — | `tts.download` | — |
| `tts-emotion-alpha` | input | range | `emotion.alphaLabel` | `input` |
| `tts-emotion-text` | input | text | `emotion.textPlaceholder` | — |
| `tts-speaker-add` | button | — | `tts.speakerAdd` | `click` |
| `tts-submit` | button | — | `tts.submit` | `click` |
| `tts-text` | textarea | — | `tts.textPlaceholder` | — |
| `ui-language` | select | — | `settings.general.language` | `change` |
| `ui-theme` | select | — | `settings.general.theme` | `change` |
| `voice-add-btn` | button | — | `voices.add` | `click` |
| `voice-add-name` | input | text | `voices.namePlaceholder` | — |
| `voice-add-text` | textarea | — | `voices.textPlaceholder` | — |
| `voices-btn` | button | — | `voices.title`<br>`voices.title` | `click` |
| `voices-close` | button | — | `history.closeTitle`<br>`history.closeTitle` | `click` |
| `voices-search` | input | search | `voices.searchPlaceholder`<br>`voices.searchAria` | `input` |
| `weights-browse-btn` | button | — | `launch.browseDir` | `click` |
| `weights-gguf-btn` | button | — | `launch.browseGguf` | `click` |

## 键盘快捷键

| 按键 | 判定 | 来源 |
| --- | --- | --- |
| ` ` | 等值 | `web/audio-picker.js` |
| ` ` | 等值 | `web/modules/file-browser.js` |
| `ArrowDown` | 等值 | `web/modules/async-ui.js` |
| `ArrowDown` | 等值 | `web/modules/command-palette.js` |
| `ArrowDown` | 等值 | `web/modules/file-browser.js` |
| `ArrowLeft` | 等值 | `web/audio-picker.js` |
| `ArrowRight` | 等值 | `web/audio-picker.js` |
| `ArrowUp` | 等值 | `web/modules/async-ui.js` |
| `ArrowUp` | 等值 | `web/modules/command-palette.js` |
| `ArrowUp` | 等值 | `web/modules/file-browser.js` |
| `Delete` | 等值 | `web/audio-picker.js` |
| `End` | 等值 | `web/audio-picker.js` |
| `End` | 等值 | `web/modules/async-ui.js` |
| `End` | 等值 | `web/modules/file-browser.js` |
| `Enter` | 等值 | `web/audio-picker.js` |
| `Enter` | 等值 | `web/modules/command-palette.js` |
| `Enter` | 等值 | `web/modules/file-browser.js` |
| `Escape` | 非 (guard) | `web/app.js` |
| `Escape` | 等值 | `web/audio-picker.js` |
| `Escape` | 等值 | `web/modules/command-palette.js` |
| `Escape` | 等值 | `web/modules/file-browser.js` |
| `Escape` | 等值 | `web/modules/models.js` |
| `Escape` | 等值 | `web/modules/sidebar.js` |
| `Home` | 等值 | `web/audio-picker.js` |
| `Home` | 等值 | `web/modules/async-ui.js` |
| `Home` | 等值 | `web/modules/file-browser.js` |
| `k` | 等值 | `web/modules/command-palette.js` |
| `K` | 等值 | `web/modules/command-palette.js` |
| `Tab` | 非 (guard) | `web/app.js` |

说明：上表由源码中的 `e.key === "..."` 判定推导；Escape 用于关闭最上层弹窗 / 菜单，
Enter / Space 用于文件浏览与文件选择。快捷键未集中注册，散落在各模块事件处理器中。

## API 端点（前端引用）

| 方法 | 路径 | 来源 |
| --- | --- | --- |
| POST | `/api/audio/info` | `web/audio-picker.js` |
| POST | `/api/audio/upload` | `web/audio-picker.js` |
| POST | `/api/cert/generate` | `web/modules/settings.js` |
| GET | `/api/cert/status` | `web/modules/settings.js` |
| GET | `/api/downloads` | `web/modules/downloads.js` |
| POST | `/api/downloads` | `web/modules/downloads.js` |
| DELETE | `/api/downloads/{param}?purge=true` | `web/modules/downloads.js` |
| POST | `/api/downloads/{param}/{param}` | `web/modules/downloads.js` |
| GET | `/api/events` | `web/modules/async-ui.js` |
| GET | `/api/executables` | `web/modules/settings.js` |
| POST | `/api/executables` | `web/modules/launch.js` |
| DELETE | `/api/executables/{param}` | `web/modules/settings.js` |
| PUT | `/api/executables/{param}` | `web/modules/launch.js` |
| GET | `/api/executables/{param}/devices` | `web/modules/launch.js` |
| GET | `/api/fs/list` | `web/modules/file-browser.js` |
| GET | `/api/fs/list?path={param}` | `web/modules/file-browser.js` |
| POST | `/api/fs/mkdir` | `web/modules/file-browser.js` |
| GET | `/api/fs/roots` | `web/modules/file-browser.js` |
| DELETE | `/api/history/{param}` | `web/modules/sidebar.js` |
| GET | `/api/history/{param}` | `web/modules/sidebar.js` |
| DELETE | `/api/history/{param}/{param}` | `web/modules/sidebar.js` |
| GET | `/api/history/{param}/{param}` | `web/modules/sidebar.js` |
| PUT | `/api/history/{param}/{param}/group` | `web/modules/sidebar.js` |
| GET | `/api/history/{param}/groups` | `web/modules/sidebar.js` |
| POST | `/api/history/{param}/groups` | `web/modules/sidebar.js` |
| DELETE | `/api/history/{param}/groups/{param}` | `web/modules/sidebar.js` |
| PUT | `/api/history/{param}/groups/{param}` | `web/modules/sidebar.js` |
| POST | `/api/https/config` | `web/modules/settings.js` |
| GET | `/api/instances` | `web/modules/instances.js` |
| POST | `/api/instances` | `web/modules/launch.js` |
| DELETE | `/api/instances/{param}` | `web/modules/instances.js` |
| GET | `/api/models` | `web/modules/models.js` |
| GET | `/api/models/{param}/packages` | `web/modules/downloads.js` |
| GET | `/api/profiles` | `web/modules/launch.js` |
| POST | `/api/profiles` | `web/modules/launch.js` |
| DELETE | `/api/profiles/{param}` | `web/modules/launch.js` |
| PUT | `/api/profiles/{param}` | `web/modules/launch.js` |
| GET | `/api/stats` | `web/modules/stats.js` |
| POST | `/api/tasks` | `web/modules/tasks.js` |
| GET | `/api/tasks?modelId={param}` | `web/modules/tasks.js` |
| DELETE | `/api/tasks/{param}` | `web/modules/sidebar.js`, `web/modules/tasks.js` |
| GET | `/api/tasks/{param}` | `web/modules/tasks.js` |
| GET | `/api/tasks/{param}/result` | `web/modules/tasks.js` |
| GET | `/api/voices` | `web/audio-picker.js`, `web/voice-select.js`, `web/voices-panel.js` |
| POST | `/api/voices` | `web/voices-panel.js` |
| DELETE | `/api/voices/{param}` | `web/voices-panel.js` |
| PUT | `/api/voices/{param}` | `web/voices-panel.js` |
| GET | `/api/voices/{param}/audio` | `web/audio-picker.js` |

路径中的 `{param}` 表示由运行时拼接/模板插值（如实例 id、任务 id）。

## data-* 钩子

| 属性 | 静态出现次数 |
| --- | --- |
| `data-i18n` | 128 |
| `data-i18n-aria-label` | 27 |
| `data-i18n-placeholder` | 24 |
| `data-i18n-title` | 11 |
| `data-mode` | 4 |
| `data-section` | 3 |
| `data-theme` | 1 |
