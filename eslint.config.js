/*
 * ESLint flat config (dev/CI-only).
 *
 * The web/ frontend is plain, no-build browser JavaScript loaded as classic
 * <script> tags (see web/index.html). It is NOT a Node runtime and no build
 * step consumes these files — this config only exists to catch mistakes in
 * development and CI.
 *
 * Cross-script globals: app.js is a classic script (no IIFE) so its top-level
 * declarations live in the shared global lexical scope; the other files are
 * wrapped in IIFEs and publish their APIs on `window.*`. Both kinds are
 * declared below so `no-undef` stays useful instead of noisy.
 */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  localStorage: "readonly",
  sessionStorage: "readonly",
  console: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  queueMicrotask: "readonly",
  performance: "readonly",
  structuredClone: "readonly",
  atob: "readonly",
  btoa: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  Event: "readonly",
  CustomEvent: "readonly",
  MutationObserver: "readonly",
  ResizeObserver: "readonly",
  IntersectionObserver: "readonly",
  DOMParser: "readonly",
  Blob: "readonly",
  File: "readonly",
  FileReader: "readonly",
  FormData: "readonly",
  Headers: "readonly",
  Request: "readonly",
  Response: "readonly",
  Image: "readonly",
  Node: "readonly",
  MediaRecorder: "readonly",
  AudioContext: "readonly",
  webkitAudioContext: "readonly",
  AudioBuffer: "readonly",
  alert: "readonly",
  confirm: "readonly",
  prompt: "readonly",
  getComputedStyle: "readonly",
};

/* APIs published by the IIFE modules (window.I18N, window.AudioPicker, ...)
   and used by app.js. */
const windowApiGlobals = {
  I18N: "readonly",
  WavUtil: "readonly",
  FileBrowser: "readonly",
  AudioPicker: "readonly",
  VoiceSelect: "readonly",
};

/* Globals that app.js itself declares at top level and that the IIFE modules
   consume (shared global lexical scope across classic scripts). */
const appExportedGlobals = {
  refreshVoiceSelects: "readonly",
  openVoicesPanel: "readonly",
  closeVoicesPanel: "readonly",
  showToast: "readonly",
  focusDialog: "readonly",
  $: "readonly",
};

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
};

const webRules = {
  /* Correctness rules kept as errors. */
  "no-undef": "error",
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-unreachable": "error",
  "no-cond-assign": ["error", "except-parens"],
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-fallthrough": "error",
  "no-self-assign": "error",
  "no-self-compare": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-async-promise-executor": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-empty-pattern": "error",
  "no-sparse-arrays": "error",
  /* Noisy on the existing legacy code — surfaced as warnings, not failures. */
  "no-template-curly-in-string": "warn",
  "no-prototype-builtins": "warn",
  "no-control-regex": "warn",
  "no-useless-escape": "warn",
  "no-empty": ["warn", { allowEmptyCatch: true }],
  "no-unused-vars": ["warn", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
  "no-var": "warn",
  eqeqeq: ["warn", "smart"],
};

const webLinterOptions = {
  reportUnusedDisableDirectives: true,
};

/* IIFE-wrapped modules — they read globals app.js declares at top level. */
const iifeModules = [
  "web/audio-picker.js",
  "web/file-browser.js",
  "web/voice-select.js",
  "web/voices-panel.js",
];

export default [
  {
    ignores: ["node_modules/**", "run/**", "data/**", "models/**", "logs/**", "package-lock.json"],
  },
  {
    files: ["web/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: { ...browserGlobals, ...windowApiGlobals },
    },
    linterOptions: webLinterOptions,
    rules: webRules,
  },
  {
    files: iifeModules,
    languageOptions: {
      globals: { ...appExportedGlobals },
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...nodeGlobals },
    },
    rules: {
      "no-undef": "error",
      "no-redeclare": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "no-unused-vars": ["warn", { args: "none", varsIgnorePattern: "^_" }],
      eqeqeq: ["warn", "smart"],
    },
  },
];
