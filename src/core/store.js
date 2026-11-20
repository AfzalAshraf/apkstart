'use strict';
/**
 * Local JSON configuration & app registry store (`%APPDATA%\apkstart`).
 * Uses atomic write-then-rename (`writeJson`) to prevent half-written files on power loss.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(
  process.env.APPDATA || path.join(os.homedir(), '.config'),
  'apkstart',
);

const DEFAULT_SHARED = path.join(os.homedir(), 'Documents', 'ApkStartShared');

const DEFAULT_SETTINGS = {
  language: 'en',
  adbPath: '',
  device: '',
  engine: {
    mode: 'builtin',        // 'builtin' | 'attach'
    headless: false,
    autoMemory: true,
    memoryMB: 0,
    cores: 0,
    resourceMode: 'balanced', // 'save' | 'balanced' | 'smooth'
    renderSize: 'auto',     // 'auto' | '540x960' | '720x1280' | '1080x1920'
    dataPartitionGB: 0,
    fastDns: true,
    keepSnapshot: true,
    logMaxKB: 2048,
    liteMode: true,
    priorityMode: 'balanced', // 'balanced' | 'performance' | 'game'
    deepTrim: false,
    prewarm: true,
    mouseRightBack: true,
    mouseWheelMode: 'smooth', // 'smooth' | 'native' | 'off'
    mouseSideButtons: false,
    freeformWindows: false,
    idleShutdownMinutes: 0,
    audio: true,
  },
  display: {
    mode: 'window',         // 'window' | 'fullscreen'
    portrait: '540x960',
    density: 0,
    landscape: false,
  },
  runtime: {
    dir: '',
    avdDir: '',
    isoPath: '',
    diskPath: '',
    diskSizeGB: 24,
    installed: false,
    compatImage: true,
    preferGithubRuntime: true,
    runtimePackUrl: '',
    sourcePreference: 'auto', // 'auto' | 'gitee' | 'github'
    autoMirror: true,
    giteeToken: '',
    mirrorPrefix: '',
    downloadConnections: 8,
    adbUrl: '',
    emulatorUrl: '',
    sysimgUrl: '',
    qemuUrl: '',
    isoUrl: '',
  },
  autoDeploy: true,
  autoStart: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true,
  shortcutDir: '',
  sharedDir: DEFAULT_SHARED,
  deviceSharedDir: '/sdcard/ApkStartShared',
  hideAfterLaunch: false,
  notifyOnInstall: true,
  welcome: {
    disabled: false,
    lastDate: '',
  },
};

function ensureDirs() {
  for (const sub of ['', 'icons', 'apks', 'logs']) {
    fs.mkdirSync(path.join(DATA_DIR, sub), { recursive: true });
  }
  fs.mkdirSync(DEFAULT_SHARED, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');

function getSettings() {
  const raw = readJson(SETTINGS_FILE, {});
  const merged = {
    ...DEFAULT_SETTINGS,
    ...raw,
    engine: { ...DEFAULT_SETTINGS.engine, ...(raw.engine || {}) },
    display: { ...DEFAULT_SETTINGS.display, ...(raw.display || {}) },
    runtime: { ...DEFAULT_SETTINGS.runtime, ...(raw.runtime || {}) },
  };
  merged.engine.headless = false;
  merged.hideAfterLaunch = false;
  return merged;
}

const RESOURCE_PRESETS = {
  save: { liteMode: true, priorityMode: 'balanced', renderSize: '540x960' },
  balanced: { liteMode: true, priorityMode: 'balanced', renderSize: 'auto' },
  smooth: { liteMode: false, priorityMode: 'game', renderSize: '720x1280' },
};

function saveSettings(patch) {
  const cur = getSettings();
  let engPatch = (patch && patch.engine) || {};
  if (engPatch.resourceMode && RESOURCE_PRESETS[engPatch.resourceMode]) {
    engPatch = { ...RESOURCE_PRESETS[engPatch.resourceMode], ...engPatch };
  }
  const next = {
    ...cur,
    ...patch,
    engine: { ...cur.engine, ...engPatch },
    display: { ...cur.display, ...((patch && patch.display) || {}) },
    runtime: { ...cur.runtime, ...((patch && patch.runtime) || {}) },
  };
  writeJson(SETTINGS_FILE, next);
  return next;
}

function getApps() {
  const list = readJson(APPS_FILE, []);
  return Array.isArray(list) ? list : [];
}

function saveApps(list) {
  writeJson(APPS_FILE, list);
}

function upsertApp(record) {
  const apps = getApps();
  const idx = apps.findIndex((a) => a.package === record.package);
  if (idx >= 0) apps[idx] = { ...apps[idx], ...record };
  else apps.push(record);
  saveApps(apps);
  return record;
}

function removeApp(pkg) {
  const apps = getApps().filter((a) => a.package !== pkg);
  saveApps(apps);
}

function getApp(pkg) {
  return getApps().find((a) => a.package === pkg) || null;
}

module.exports = {
  DATA_DIR,
  ICON_DIR: path.join(DATA_DIR, 'icons'),
  APK_DIR: path.join(DATA_DIR, 'apks'),
  LOG_DIR: path.join(DATA_DIR, 'logs'),
  DEFAULT_SHARED,
  ensureDirs,
  getSettings,
  saveSettings,
  getApps,
  saveApps,
  upsertApp,
  removeApp,
  getApp,
};
