'use strict';
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage,
} = require('electron');

const store = require('./core/store');
const { parseApk } = require('./core/apk');
const { Runtime } = require('./core/engine');
const { Installer, installStoredApp } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { DisplayController } = require('./core/display');
const { WindowController } = require('./core/windowctl');
const { WinAgent } = require('./core/agent');
const { AppWindow } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { pointerOptions, WheelRouter, isInputCommand } = require('./core/pointer');
const container = require('./core/container');
const { AndroidSettings } = require('./core/android');
const { Updater } = require('./core/updater');
const leftovers = require('./core/leftovers');
const layers = require('./core/layers');
const doctor = require('./core/doctor');
const { drawAppIcon } = require('./core/png');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./core/shortcut');
const { registerAssociation, unregisterAssociation } = require('./core/assoc');

// ---------------------------------------------------------------------------
// Single-instance lock (double-clicking an .apk or desktop shortcut forwards argv to the running instance)
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

app.setAppUserModelId('com.apkstart.runner');

// ---------------------------------------------------------------------------
// Global subsystems
// ---------------------------------------------------------------------------
let mainWindow = null;
let tray = null;
let runtime = null;
let engine = null;
let provisioner = null;
let installer = null;
let sharer = null;
let display = null;
let windowCtl = null;
let winAgent = null;
let appWin = null;
let notifyBridge = null;
let wheelRouter = null;
let idleTimer = null;
let lastActiveAt = Date.now();
let android = null;
let updater = null;
let brandIconPng = null;
let isQuitting = false;
let deployAbort = null;
let updateAbort = null;
let pendingOpenCount = 0;

function bundledRuntimeDir() {
  const candidates = [
    path.join(process.resourcesPath || '', 'runtime'),
    path.join(__dirname, '..', 'runtime'),
  ];
  for (const d of candidates) {
    if (!d || !fs.existsSync(d)) continue;
    const hasAdb = fs.existsSync(path.join(d, 'platform-tools', 'adb.exe'));
    const hasQemu = fs.existsSync(path.join(d, 'qemu', 'qemu-system-x86_64.exe'))
      || fs.existsSync(path.join(d, 'emulator', 'emulator.exe'));
    if (hasAdb || hasQemu) return d;
  }
  return null;
}

function runtimePaths() {
  if (runtime && runtime.provisioner) {
    const p = runtime.provisioner.paths();
    return {
      bundled: Boolean(p.bundled),
      runtimeDir: p.root,
      avdHome: p.avdHome,
      isoPath: p.isoFile,
      diskPath: p.diskFile,
      logDir: store.LOG_DIR,
    };
  }
  const s = store.getSettings();
  const bundled = bundledRuntimeDir();
  const runtimeDir = s.runtime.dir || bundled || path.join(store.DATA_DIR, 'runtime');
  const avdHome = s.runtime.avdDir || path.join(runtimeDir, 'avd');
  return {
    bundled: Boolean(bundled && !s.runtime.dir),
    runtimeDir,
    avdHome,
    isoPath: s.runtime.isoPath || path.join(runtimeDir, 'images', 'android-x86_64.iso'),
    diskPath: s.runtime.diskPath || path.join(runtimeDir, 'images', 'userdata.qcow2'),
    logDir: store.LOG_DIR,
  };
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  } catch (_) { /* ignore */ }
}

function ensureBrandIcon() {
  store.ensureDirs();
  const pngPath = path.join(store.DATA_DIR, 'brand.png');
  const icoPath = path.join(store.DATA_DIR, 'brand.ico');
  if (!fs.existsSync(pngPath)) {
    brandIconPng = drawAppIcon(256);
    fs.writeFileSync(pngPath, brandIconPng);
  } else {
    brandIconPng = fs.readFileSync(pngPath);
  }
  if (!fs.existsSync(icoPath)) {
    iconToIco(brandIconPng).then((ico) => { if (ico) fs.writeFileSync(icoPath, ico); }).catch(() => {});
  }
  return { pngPath, icoPath };
}

let decoderWin = null;
async function decodeImageToPng(raw) {
  if (!decoderWin || decoderWin.isDestroyed()) {
    decoderWin = new BrowserWindow({
      show: false, width: 64, height: 64,
      webPreferences: { offscreen: true, contextIsolation: true, sandbox: true },
    });
    await decoderWin.loadURL('data:text/html,<!doctype html><meta charset=utf-8>');
  }
  const b64 = Buffer.from(raw).toString('base64');
  const dataUrl = await decoderWin.webContents.executeJavaScript(`(async () => {
    const bin = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin]), { resizeWidth: 256, resizeHeight: 256, resizeQuality: 'high' });
    const c = new OffscreenCanvas(256, 256);
    c.getContext('2d').drawImage(bmp, 0, 0, 256, 256);
    bmp.close();
    const out = await c.convertToBlob({ type: 'image/png' });
    const ab = await out.arrayBuffer();
    let s = ''; const u = new Uint8Array(ab);
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  })()`);
  return Buffer.from(dataUrl, 'base64');
}

function appExeTarget() {
  if (app.isPackaged) {
    return { target: process.execPath, prefixArgs: '' };
  }
  return { target: process.execPath, prefixArgs: `"${path.resolve(__dirname, '..')}"` };
}

function shortcutDirs() {
  const s = store.getSettings();
  const desktop = s.shortcutDir || app.getPath('desktop');
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart');
  return { desktop, startMenu };
}

async function restartForOrientation(landscape) {
  const pkg = appWin && appWin.pkg;
  store.saveSettings({ display: { landscape: Boolean(landscape) } });
  const pushTip = (msg) => {
    if (appWin && appWin.isOpen) appWin.setState({ tip: msg, ready: false });
  };
  pushTip('Restarting Android engine for new screen orientation...');
  await runtime.stop().catch(() => {});
  runtime.emulator.clearSnapshots();
  const rt = await runtime.ensure({ onLog: (message) => pushTip(message) });
  if (!rt.ok) { pushTip(`Restart failed: ${rt.error}`); return; }
  if (pkg) {
    const appRecord = store.getApp(pkg);
    const installed = await rt.client.isInstalled(pkg).catch(() => false);
    if (!installed && appRecord) {
      pushTip('Restoring application package...');
      await installer.installStoredApp(appRecord, rt.client, (m) => pushTip(m)).catch(() => {});
    }
    if (appRecord) {
      pushTip(`Relaunching ${appRecord.label || pkg}...`);
      const activity = appRecord.activity
        || (await rt.client.resolveLauncher(pkg).catch(() => null));
      await rt.client.startApp(pkg, activity).catch(() => {});
    }
  }
  pushTip('Embedding application window...');
  if (appWin && appWin.isOpen) await appWin.embed({ timeoutMs: 25000 });
}

function initSubsystems() {
  ensureBrandIcon();
  runtime = new Runtime(path.join(__dirname, '..'));
  engine = runtime;
  provisioner = runtime.provisioner;
  const p = runtimePaths();

  windowCtl = new WindowController();
  winAgent = new WinAgent();
  winAgent.scope([p.runtimeDir, store.DATA_DIR, path.dirname(process.execPath)], process.pid).catch(() => {});
  winAgent.bootHide(true).catch(() => {});
  engine.setAgent(winAgent);

  display = new DisplayController(
    async () => runtime.getClient(),
    store.getSettings,
    null,
  );
  appWin = new AppWindow({
    agent: winAgent,
    setOrientation: async (landscape) => {
      const client = runtime.getClient();
      const cmds = [
        'settings put system accelerometer_rotation 0',
        `settings put system user_rotation ${landscape ? 1 : 0}`,
      ];
      for (const command of cmds) {
        try { await client.shell(command, { timeout: 6000 }); } catch (_) { /* ignore */ }
      }
    },
    pointerConfig: () => pointerOptions(store.getSettings()),
    onRestart: restartForOrientation,
  });
  appWin.onCloseApp(async (pkg) => {
    touchActive();
    const client = runtime.getClient();
    if (client) { try { await client.forceStop(pkg); } catch (_) { /* ignore */ } }
    try { notifyBridge?.stop(); } catch (_) { /* ignore */ }
    runtime.scheduleSnapshotSave();
    scheduleIdleCheck();
  });

  const adbInput = async (command) => {
    if (!isInputCommand(command)) return;
    const client = runtime.getClient();
    if (!client) return;
    touchActive();
    try { await client.input(command); } catch (_) { /* ignore */ }
  };
  let cachedGuestSize = { width: 1080, height: 1920, at: 0 };
  const guestSize = async () => {
    const now = Date.now();
    if (now - cachedGuestSize.at < 5000) return cachedGuestSize;
    const client = runtime.getClient();
    if (client) {
      const size = await client.wmSize().catch(() => null);
      if (size) { cachedGuestSize = { ...size, at: now }; return cachedGuestSize; }
    }
    const landscape = Boolean(appWin && appWin.landscape);
    return landscape ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
  };
  wheelRouter = new WheelRouter({ inject: adbInput, getSize: guestSize });
  winAgent.on('back', () => adbInput('input keyevent 4'));
  winAgent.on('forward', () => adbInput('input keyevent 125'));
  winAgent.on('wheel', (event) => wheelRouter.push(event));

  notifyBridge = new NotifyBridge({
    getClient: () => runtime.getClient(),
    getAppLabel: (pkg) => { const record = store.getApp(pkg); return record ? record.label : pkg; },
    getAppIcon: (pkg) => {
      const record = store.getApp(pkg);
      return (record && record.iconPath && fs.existsSync(record.iconPath)) ? record.iconPath : '';
    },
    onOpen: (pkg) => {
      if (appWin.isOpen && appWin.pkg === pkg) {
        appWin.win.show(); appWin.win.focus();
      } else {
        launchWithFlow(pkg);
      }
    },
  });
  android = new AndroidSettings(runtime);
  updater = new Updater({
    currentVersion: app.getVersion(),
    exePath: process.execPath,
    isPackaged: app.isPackaged,
    dataDir: store.DATA_DIR,
    settings: store.getSettings,
  });

  const { target, prefixArgs } = appExeTarget();
  const { desktop, startMenu } = shortcutDirs();
  installer = new Installer(runtime, {
    launcherTarget: target,
    launcherArgs: prefixArgs,
    cwd: app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'),
    desktopDir: desktop,
    startMenuDir: startMenu,
    decodeIcon: decodeImageToPng,
  });

  sharer = new Sharer(runtime);
}

function touchActive() {
  lastActiveAt = Date.now();
}

function scheduleIdleCheck() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const mins = Number((store.getSettings().engine || {}).idleShutdownMinutes) || 0;
  if (mins <= 0) return;
  if (appWin && appWin.isOpen) return;
  const dueIn = Math.max(15000, mins * 60000 - (Date.now() - lastActiveAt));
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (appWin && appWin.isOpen) return;
    const curMins = Number((store.getSettings().engine || {}).idleShutdownMinutes) || 0;
    if (curMins <= 0) return;
    if (Date.now() - lastActiveAt < curMins * 60000 - 1000) {
      scheduleIdleCheck();
      return;
    }
    try { sharer?.stop(); } catch (_) { /* ignore */ }
    try { notifyBridge?.stop(); } catch (_) { /* ignore */ }
    try { await runtime.stop(); } catch (_) { /* ignore */ }
    broadcast('state:changed', {});
  }, dueIn);
  idleTimer.unref?.();
}

function applyAutoStart() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const s = store.getSettings();
    app.setLoginItemSettings({
      openAtLogin: Boolean(s.autoStart),
      args: ['--tray'],
    });
  } catch (_) { /* ignore */ }
}

function rebuildPathsIfChanged() {
  const settings = store.getSettings();
  provisioner.runtimeDir = String(settings.runtime.dir || '').trim();
  provisioner.avdHome = String(settings.runtime.avdDir || '').trim();
  provisioner.isoPath = String(settings.runtime.isoPath || '').trim();
  provisioner.invalidateEnvCache();
}

// ---------------------------------------------------------------------------
// Main window & system tray
// ---------------------------------------------------------------------------
function createMainWindow(showNow = true) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (showNow) { mainWindow.show(); mainWindow.focus(); }
    return mainWindow;
  }
  const icon = nativeImage.createFromBuffer(brandIconPng);
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 820,
    minHeight: 560,
    show: showNow,
    title: 'ApkStart — Windows Android App Runner',
    icon,
    backgroundColor: '#0f172a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));

  mainWindow.on('close', (e) => {
    if (!isQuitting && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  return mainWindow;
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromBuffer(brandIconPng).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('ApkStart — Double-click any .apk or desktop shortcut to run');
  refreshTrayMenu();
  tray.on('double-click', () => createMainWindow(true));
}

function refreshTrayMenu() {
  if (!tray) return;
  const apps = store.getApps().slice(0, 12);
  const appItems = apps.length
    ? apps.map((a) => ({
      label: `▶ ${a.label}`,
      click: () => launchWithFlow(a.package),
    }))
    : [{ label: '(No Android apps installed yet)', enabled: false }];

  const menu = Menu.buildFromTemplate([
    { label: 'Open ApkStart Manager', click: () => createMainWindow(true) },
    { label: 'Install APK / Bundle...', click: () => pickAndInstall() },
    { type: 'separator' },
    ...appItems,
    { type: 'separator' },
    { label: 'Open Shared Folder', click: () => shell.openPath(store.getSettings().sharedDir) },
    {
      label: 'Stop Android Engine',
      click: async () => { await runtime.stop(); broadcast('state:changed', {}); },
    },
    { type: 'separator' },
    {
      label: 'Quit ApkStart',
      click: async () => {
        isQuitting = true;
        sharer.stop();
        await runtime.stop();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Auto-provisioning + APK install/launch workflows
// ---------------------------------------------------------------------------
async function ensureEngineProvisioned() {
  const s = store.getSettings();
  if (s.engine.mode !== 'builtin') return true;
  const st = await provisioner.status();
  if (st.ready || st.installed) return true;

  createMainWindow(true);
  if (!s.autoDeploy) {
    broadcast('deploy:ask', st);
    return false;
  }
  return runDeploy();
}

async function runDeploy() {
  if (deployAbort) return false;
  deployAbort = new AbortController();
  broadcast('progress', {
    kind: 'deploy',
    busy: true,
    message: 'Starting one-time Android runtime setup (often over 1 GB)...',
    ratio: 0,
  });
  try {
    await provisioner.deploy({
      signal: deployAbort.signal,
      onProgress: (p) => {
        const base = p.message || `${p.label || p.stage}`;
        const hasReceived = Number.isFinite(p.received) && p.received >= 0;
        const hasTotal = Number.isFinite(p.total) && p.total > 0;
        const transferred = hasReceived
          ? ` · ${(p.received / 1048576).toFixed(1)}${hasTotal ? ` / ${(p.total / 1048576).toFixed(1)}` : ''} MiB`
          : '';
        const speed = Number.isFinite(p.speed) && p.speed > 0
          ? ` · ${(p.speed / 1048576).toFixed(1)} MiB/s`
          : '';
        broadcast('progress', {
          kind: 'deploy',
          busy: true,
          step: p.step,
          ratio: p.ratio || (Number.isFinite(p.percent) ? p.percent / 100 : 0),
          message: `${base}${transferred}${speed}`,
        });
      },
    });
    store.saveSettings({ runtime: { installed: true } });
    broadcast('progress', { kind: 'deploy', busy: false, done: true, message: 'Android runtime is ready!' });
    broadcast('state:changed', {});
    return true;
  } catch (e) {
    broadcast('progress', {
      kind: 'deploy', busy: false, error: true,
      message: `Runtime setup failed: ${e.message}`,
    });
    return false;
  } finally {
    deployAbort = null;
  }
}

async function pickAndInstall() {
  createMainWindow(true);
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Android App Package (.apk / .apks / .xapk)',
    filters: [{ name: 'Android App Package', extensions: ['apk', 'apks', 'xapk'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (res.canceled || !res.filePaths.length) return;
  for (const p of res.filePaths) {
    await installFlow(p, { autoLaunch: res.filePaths.length === 1 });
  }
}

async function installFlow(apkPath, { autoLaunch = true } = {}) {
  createMainWindow(true);
  broadcast('progress', { kind: 'install', message: `Parsing ${path.basename(apkPath)}...`, busy: true });

  const ready = await ensureEngineProvisioned();
  if (!ready) {
    broadcast('progress', {
      kind: 'install', busy: false, error: true,
      message: 'Please complete one-time Android runtime setup before installing apps.',
    });
    return { ok: false, needDeploy: true };
  }

  try {
    const installed = await installer.installApk(apkPath, (message) => {
      broadcast('progress', { kind: 'install', message, busy: true });
    });
    const rec = installed.app || installed;
    const warnings = installed.warnings || [];
    sharer.start();
    refreshTrayMenu();
    broadcast('state:changed', { apps: store.getApps() });
    const shortcutPath = rec.shortcutPath || rec.startMenuPath || '';
    const warningText = warnings.length ? ` (Warnings: ${warnings.join('; ')})` : '';
    const shortcutText = shortcutPath ? ' · Desktop shortcut created' : '';
    broadcast('progress', {
      kind: 'install',
      message: `Installed: ${rec.label}${warningText}${shortcutText}`,
      busy: false,
      done: true,
    });
    if (store.getSettings().notifyOnInstall) {
      notify(
        `${rec.label} installed`,
        shortcutPath ? 'A desktop shortcut is ready — double-click anytime to launch.' : `Location: ${store.DATA_DIR}`,
      );
    }
    if (autoLaunch) await launchWithFlow(rec.package);
    return { ok: true, app: rec, warnings };
  } catch (e) {
    broadcast('progress', { kind: 'install', message: `Installation failed: ${e.message}`, busy: false, error: true });
    dialog.showErrorBox('APK Installation Failed', `${path.basename(apkPath)}\n\n${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function launchWithFlow(pkg) {
  touchActive();
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const ready = await ensureEngineProvisioned();
  if (!ready) return { ok: false, needDeploy: true };

  const s = store.getSettings();
  const rec = store.getApp(pkg);
  const label = (rec && rec.label) || pkg;
  const iconPng = rec && rec.iconPath && fs.existsSync(rec.iconPath) ? rec.iconPath : null;
  const [pw, ph] = String((s.display && s.display.portrait) || '540x960').split('x').map(Number);

  appWin.open({
    pkg,
    label,
    iconPath: iconPng,
    portrait: { w: pw || 540, h: ph || 960 },
    fullscreen: s.display && s.display.mode === 'fullscreen',
    landscape: Boolean((s.display && s.display.landscape) || (rec && rec.preferLandscape)),
  });
  appWin.setIcon(iconPng || '');
  appWin.setState({ ready: false, tip: 'Starting Android runtime...' });

  const progress = (msg) => {
    broadcast('progress', { kind: 'launch', message: msg, busy: true });
    appWin.setState({ tip: msg });
  };

  progress(`Launching ${label}...`);
  try {
    await installer.launch(pkg, { onLog: progress });
    appWin.setState({ tip: 'Embedding Android surface...' });
    await display.apply(undefined, store.getApp(pkg));
    const ok = await appWin.embed({ timeoutMs: 25000 });
    if (!ok) {
      throw new Error(
        `Could not attach Android graphics surface (${appWin.lastEmbedError || 'emulator window not found'}). Export a Doctor diagnostic report in Settings if this persists.`,
      );
    }
    sharer.start();
    notifyBridge.start();
    broadcast('progress', { kind: 'launch', message: 'Running', busy: false, done: true });
    broadcast('state:changed', { apps: store.getApps() });
    return { ok: true, embedded: ok };
  } catch (e) {
    appWin.close({ keepApp: true });
    broadcast('progress', { kind: 'launch', message: `Launch failed: ${e.message}`, busy: false, error: true });
    createMainWindow(true);
    dialog.showErrorBox('App Launch Failed', e.message);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Command-line argument routing (--run=pkg / path.apk / --tray)
// ---------------------------------------------------------------------------
function parseArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  let runPkg = null;
  let apkFile = null;
  let trayOnly = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--run=') || a.startsWith('--launch=')) {
      runPkg = a.slice(a.indexOf('=') + 1).replace(/^"|"$/g, '');
    } else if (a === '--launch' && args[i + 1]) {
      runPkg = args[i + 1].replace(/^"|"$/g, '');
      i += 1;
    } else if (a === '--tray') trayOnly = true;
    else if (/\.(apk|apks|xapk)$/i.test(a) && fs.existsSync(a)) apkFile = a;
  }
  return { runPkg, apkFile, trayOnly };
}

async function handleLaunchArgs(argv) {
  const { runPkg, apkFile, trayOnly } = parseArgv(argv);
  if (apkFile) {
    await installFlow(apkFile, { autoLaunch: true });
  } else if (runPkg) {
    await launchWithFlow(runPkg);
  } else if (!trayOnly) {
    createMainWindow(true);
  }
}

app.on('second-instance', (_event, argv) => {
  handleLaunchArgs(argv);
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (/\.(apk|apks|xapk)$/i.test(filePath)) installFlow(filePath, { autoLaunch: true });
});

function isAllowedLocalPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
  const p = runtimePaths();
  const s = store.getSettings();
  const roots = [store.DATA_DIR, p.runtimeDir, p.avdHome, s.sharedDir].filter(Boolean).map((r) => path.resolve(r));
  return roots.some((root) => (
    process.platform === 'win32'
      ? resolved.toLowerCase() === root.toLowerCase() || resolved.toLowerCase().startsWith((root + path.sep).toLowerCase())
      : resolved === root || resolved.startsWith(root + path.sep)
  ));
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('state:get', async () => {
    const [rtStatus, prov] = await Promise.all([runtime.status(), provisioner.status()]);
    const apps = store.getApps().map((record) => ({ ...record, iconPng: record.iconPath || '' }));
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      settings: store.getSettings(),
      apps,
      runtime: { ...rtStatus, online: Boolean(rtStatus.deviceOnline) },
      engineStatus: { running: Boolean(rtStatus.vmRunning), phase: rtStatus.phase },
      provision: {
        installed: Boolean(prov.installed || prov.ready),
        mode: prov.emulator && prov.emulator.ok ? 'emulator' : (prov.qemu && prov.qemu.ok ? 'qemu' : ''),
        adb: Boolean(prov.adb && prov.adb.ok),
        emulator: Boolean(prov.emulator && prov.emulator.ok),
        qemu: Boolean(prov.qemu && prov.qemu.ok),
        systemImage: Boolean(prov.sysimg && prov.sysimg.ok),
        iso: Boolean(prov.iso && prov.iso.ok),
        runtimeDir: prov.root || runtimePaths().runtimeDir,
        details: prov,
      },
      dataDir: store.DATA_DIR,
      bundledRuntime: runtimePaths().bundled,
    };
  });

  ipcMain.handle('settings:save', (_e, patch) => {
    const prev = store.getSettings();
    const next = store.saveSettings(patch || {});
    rebuildPathsIfChanged();
    if ('autoStart' in (patch || {})) applyAutoStart();
    appWin?.refreshPointer();
    if (patch && patch.engine && 'priorityMode' in patch.engine && engine) {
      engine.applyPriority(next.engine.priorityMode).catch(() => {});
    }
    if (patch && patch.engine && 'freeformWindows' in patch.engine) {
      const c = runtime.getClient();
      if (c) container.setFreeform(c, Boolean(next.engine.freeformWindows)).catch(() => {});
    }
    if (patch && patch.engine && 'idleShutdownMinutes' in patch.engine) {
      scheduleIdleCheck();
    }
    const prevAudio = prev.engine && prev.engine.audio !== false;
    const nextAudio = next.engine && next.engine.audio !== false;
    if (patch && patch.engine && 'audio' in patch.engine && prevAudio !== nextAudio) {
      if (runtime) runtime.stop().catch(() => {});
    }
    refreshTrayMenu();
    return next;
  });

  const guardDialog = async (fn) => {
    pendingOpenCount++;
    try { return await fn(); } finally { pendingOpenCount--; }
  };

  ipcMain.handle('dialog:pickApk', () => guardDialog(async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Android App Package (.apk / .apks / .xapk)',
      filters: [{ name: 'Android App Package', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('dialog:pickAdb', () => guardDialog(async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select adb.exe',
      filters: [{ name: 'ADB Executable', extensions: ['exe'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('dialog:pickFolder', () => guardDialog(async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('dialog:pickIso', () => guardDialog(async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Android-x86 ISO or System Image Archive',
      filters: [{ name: 'System Image', extensions: ['iso', 'img', 'zip', '7z'] }],
      properties: ['openFile'],
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('apk:inspect', (_e, p) => {
    try {
      const m = parseApk(p);
      return {
        ok: true,
        package: m.package,
        label: m.label,
        versionName: m.versionName,
        minSdk: m.minSdk,
        abis: m.abis,
        preferLandscape: Boolean(m.preferLandscape),
        iconDataUrl: m.iconPng
          ? `data:image/${/\.webp$/i.test(m.iconFile || '') ? 'webp' : 'png'};base64,${m.iconPng.toString('base64')}`
          : null,
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('apk:install', (_e, p) => installFlow(p, { autoLaunch: true }));
  ipcMain.handle('app:launch', (_e, pkg) => launchWithFlow(pkg));
  ipcMain.handle('app:stop', async (_e, pkg) => {
    if (appWin && appWin.isOpen && (!pkg || appWin.pkg === pkg)) {
      appWin.close({ keepApp: false });
    } else {
      const rt = await runtime.ensure();
      if (rt.ok) await rt.client.forceStop(pkg);
    }
    return { ok: true };
  });
  ipcMain.handle('app:uninstall', async (_e, pkg, fromDevice = true) => {
    await installer.uninstall(pkg, { fromDevice });
    refreshTrayMenu();
    return { ok: true, apps: store.getApps() };
  });
  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    try {
      const record = await installer.rebuildShortcutFor(pkg);
      const where = record.shortcutPath || record.startMenuPath || '';
      if (where) shell.showItemInFolder(where);
      return { ok: true, path: where, warnings: [] };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });
  ipcMain.handle('app:rebuildShortcuts', async () => installer.rebuildAllShortcuts());
  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) return rt;
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('runtime:ensure', async () => {
    const ok = await ensureEngineProvisioned();
    if (!ok) return { ok: false, error: 'Android runtime has not been provisioned yet' };
    return runtime.ensure({
      onLog: (message) => broadcast('progress', { kind: 'runtime', message, busy: true }),
    });
  });
  ipcMain.handle('runtime:stop', async () => {
    sharer.stop();
    notifyBridge.stop();
    appWin.close({ keepApp: true });
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('engine:status', () => engine.status());

  ipcMain.handle('provision:status', () => provisioner.status());
  ipcMain.handle('provision:deploy', () => runDeploy());
  ipcMain.handle('provision:cancel', () => {
    if (deployAbort) deployAbort.abort();
    return { ok: true };
  });
  ipcMain.handle('provision:reset', async () => {
    await runtime.stop({ graceful: false });
    provisioner.reset();
    return provisioner.status();
  });
  ipcMain.handle('provision:importIso', async (_e, src) => {
    broadcast('progress', { kind: 'deploy', busy: true, message: 'Importing local Android image...' });
    try {
      const r = await provisioner.importLocalIso(src, (p) => {
        broadcast('progress', { kind: 'deploy', busy: true, message: p.label });
      });
      broadcast('progress', { kind: 'deploy', busy: false, done: true, message: 'System image imported successfully' });
      return { ok: true, ...r };
    } catch (e) {
      broadcast('progress', { kind: 'deploy', busy: false, error: true, message: e.message });
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('sources:probe', () => provisioner.probeSources());

  ipcMain.handle('layers:analyze', () => {
    const p = runtimePaths();
    const summary = layers.summary(p.runtimeDir, { avdHome: p.avdHome });
    return {
      ...summary,
      totalBytes: summary.total,
      reclaimableBytes: summary.reclaimable,
      pruneCount: summary.count,
      categories: summary.layers.map((layer) => ({ label: layer.name, bytes: layer.size })),
    };
  });
  ipcMain.handle('layers:prune', async () => {
    if (engine.isRunning()) {
      return { ok: false, error: 'Please stop the Android engine before reclaiming disk space.' };
    }
    const p = runtimePaths();
    const result = layers.prune(p.runtimeDir, { avdHome: p.avdHome, apply: true });
    const after = layers.summary(p.runtimeDir, { avdHome: p.avdHome });
    return { ok: true, ...result, freedBytes: result.saved, after };
  });
  ipcMain.handle('layers:verify', () => ({ ok: true, ...layers.analyze(runtimePaths().runtimeDir) }));

  const doctorCtx = async () => {
    const p = runtimePaths();
    return {
      runtimeDir: p.runtimeDir,
      avdHome: p.avdHome,
      dataDir: store.DATA_DIR,
      logDir: store.LOG_DIR,
      appVersion: app.getVersion(),
      settings: store.getSettings(),
      provisionStatus: await provisioner.status(),
    };
  };
  ipcMain.handle('doctor:check', async () => doctor.check(await doctorCtx()));
  ipcMain.handle('doctor:export', async () => {
    let winExtras = null;
    try {
      if (winAgent && winAgent.available()) {
        const [probe, allWins, cons] = await Promise.all([
          winAgent.probe().catch((e) => ({ error: e.message })),
          winAgent.windows(true).catch((e) => ({ error: e.message })),
          winAgent.consoles().catch((e) => ({ error: e.message })),
        ]);
        winExtras = {
          appWinOpen: Boolean(appWin && appWin.isOpen),
          appWinEmbedded: Boolean(appWin && appWin.embedded),
          lastEmbedError: (appWin && appWin.lastEmbedError) || '',
          probe,
          windows: allWins,
          consoles: cons,
        };
      }
    } catch (_) { /* Diagnostics export never throws */ }
    const rep = await doctor.collectFullReport({ ...(await doctorCtx()), extras: { winAgent: winExtras } });
    const outPath = path.join(app.getPath('desktop'), `ApkStart-Diagnostic-Report-${Date.now()}.txt`);
    fs.writeFileSync(outPath, doctor.formatReport(rep), 'utf8');
    shell.showItemInFolder(outPath);
    return { ok: true, path: outPath };
  });

  ipcMain.handle('doctor:selfCheck', async () => {
    const start = Date.now();
    const context = await doctorCtx();
    const d = doctor.check(context);
    const prov = context.provisionStatus;
    const eng = await engine.status();
    const p = runtimePaths();
    const avdDir = path.join(p.avdHome, 'apkstart.avd');
    const lockCandidates = [
      path.join(avdDir, 'hardware-qemu.ini.lock'),
      path.join(avdDir, 'multiinstance.lock'),
      path.join(avdDir, 'snapshot.lock.lock'),
      path.join(p.runtimeDir, 'avd', 'apkstart.avd', 'hardware-qemu.ini.lock'),
      path.join(p.runtimeDir, 'avd', 'apkstart.avd', 'multiinstance.lock'),
    ];
    const locks = lockCandidates.filter((f) => { try { return fs.existsSync(f); } catch (_) { return false; } });
    const checks = [
      ...d.items,
      {
        id: 'prov',
        title: 'Android Runtime Package',
        level: prov.installed ? 'ok' : 'warn',
        detail: prov.installed
          ? `Installed (${prov.mode || 'emulator'})`
          : 'Not installed yet — click "One-Click Setup" to download automatically',
      },
      {
        id: 'locks',
        title: 'AVD Lock Status',
        level: locks.length && !eng.running ? 'warn' : 'ok',
        detail: locks.length && !eng.running
          ? `${locks.length} stale lock(s) found — click "Clear Stale Locks" to fix`
          : (eng.running ? 'Engine currently running' : 'Clean (no stale lock files)'),
      },
      {
        id: 'apps',
        title: 'Installed Apps Registry',
        level: 'ok',
        detail: `${store.getApps().length} app(s) registered`,
      },
    ];
    const ok = checks.every((c) => c.level !== 'fail');
    return { ok, checks, elapsedMs: Date.now() - start, locks: locks.length };
  });

  ipcMain.handle('app:clearLocks', async () => {
    if (engine.isRunning()) {
      return { ok: false, error: 'Android engine is currently running — stop the engine first.' };
    }
    const p = runtimePaths();
    const avdDirs = [
      path.join(p.avdHome, 'apkstart.avd'),
      path.join(p.runtimeDir, 'avd', 'apkstart.avd'),
    ];
    let cleared = 0;
    for (const avd of avdDirs) {
      let names = [];
      try { names = fs.readdirSync(avd); } catch (_) { continue; }
      for (const n of names) {
        if (!/\.lock$/i.test(n)) continue;
        try {
          fs.rmSync(path.join(avd, n), { recursive: true, force: true });
          cleared++;
        } catch (_) { /* ignore */ }
      }
    }
    return { ok: true, cleared };
  });

  ipcMain.handle('display:set', async (_e, patch) => {
    const prev = store.getSettings();
    const prevLand = Boolean(prev.display && prev.display.landscape);
    const next = store.saveSettings({ display: patch || {} });
    if (patch && 'landscape' in patch && Boolean(patch.landscape) !== prevLand) {
      if (appWin && appWin.isOpen) await appWin.setLandscape(Boolean(patch.landscape));
    }
    const r = await display.apply(next.display.mode);
    if (appWin && appWin.isOpen) {
      if (next.display.mode === 'fullscreen' && !appWin.win.isMaximized()) appWin.win.maximize();
      if (next.display.mode === 'window' && appWin.win.isMaximized()) appWin.win.unmaximize();
    }
    return { settings: next.display, applied: r };
  });
  ipcMain.handle('display:fullscreen', async () => {
    store.saveSettings({ display: { mode: 'fullscreen' } });
    if (appWin && appWin.isOpen) appWin.win.maximize();
    return display.apply('fullscreen');
  });
  ipcMain.handle('display:window', async () => {
    store.saveSettings({ display: { mode: 'window' } });
    if (appWin && appWin.isOpen && appWin.win.isMaximized()) appWin.win.unmaximize();
    return display.apply('window');
  });

  ipcMain.handle('shell:ready', () => ({
    ...appWin.state,
    iconUrl: appWin.iconUrl,
  }));
  ipcMain.handle('shell:rotate', () => appWin.rotate(restartForOrientation));
  ipcMain.handle('shell:min', () => { if (appWin.isOpen) appWin.win.minimize(); });
  ipcMain.handle('shell:max', () => {
    if (!appWin.isOpen) return;
    if (appWin.win.isMaximized()) appWin.win.unmaximize(); else appWin.win.maximize();
  });
  ipcMain.handle('shell:close', () => { appWin.close(); });

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await android.status()) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('android:wifi', (_e, on) => android.setWifi(Boolean(on)));
  ipcMain.handle('android:airplane', (_e, on) => android.setAirplane(Boolean(on)));
  ipcMain.handle('android:volume', (_e, v) => android.setVolume(v));
  ipcMain.handle('android:animations', (_e, on) => android.setAnimations(Boolean(on)));
  ipcMain.handle('android:fontScale', (_e, s) => android.setFontScale(s));
  ipcMain.handle('android:density', (_e, d) => android.setDensity(d));
  ipcMain.handle('android:tune', (_e, pkg) => android.tune({ pkg }));
  ipcMain.handle('android:open', async (_e, action) => {
    await android.open(action);
    if (!appWin.isOpen) {
      const s = store.getSettings();
      const [pw, ph] = String((s.display && s.display.portrait) || '540x960').split('x').map(Number);
      appWin.open({
        pkg: 'com.android.settings',
        label: 'Android System Settings',
        portrait: { w: pw || 540, h: ph || 960 },
      });
      await appWin.embed({ timeoutMs: 8000 });
    } else {
      appWin.win.focus();
    }
    return { ok: true };
  });
  ipcMain.handle('android:permissions', (_e, pkg) => android.permissions(pkg));
  ipcMain.handle('android:grantAll', (_e, pkg) => android.grantAll(pkg));

  ipcMain.handle('update:check', async () => {
    try {
      const info = await updater.check();
      return {
        ok: true,
        ...info,
        latest: info.version,
        preferredAsset: info.asset,
        source: (info.sources && info.sources[0] && info.sources[0].name) || 'release channels',
      };
    } catch (e) { return { ok: false, error: e.message }; }
  });
  ipcMain.handle('update:apply', async (_e, asset) => {
    if (updateAbort) return { ok: false, error: 'An update download is already in progress' };
    updateAbort = new AbortController();
    try {
      const pkg = await updater.download(asset, {
        signal: updateAbort.signal,
        connections: store.getSettings().runtime.downloadConnections || 8,
        onProgress: (p) => broadcast('progress', {
          kind: 'update', busy: true, ratio: p.ratio || 0,
          message: `Downloading update ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB (${((p.speed || 0) / 1048576).toFixed(1)} MB/s)`,
        }),
      });
      broadcast('progress', { kind: 'update', busy: true, ratio: 1, message: 'Applying update and restarting...' });
      isQuitting = true;
      sharer.stop();
      notifyBridge.stop();
      await runtime.stop();
      const r = await updater.applyAndRestart(pkg, () => app.quit());
      return { ok: true, ...r };
    } catch (e) {
      broadcast('progress', { kind: 'update', busy: false, error: true, message: `Update failed: ${e.message}` });
      return { ok: false, error: e.message };
    } finally {
      updateAbort = null;
    }
  });
  ipcMain.handle('update:cancel', () => { if (updateAbort) updateAbort.abort(); return { ok: true }; });

  ipcMain.handle('leftovers:scan', () => {
    const p = runtimePaths();
    return leftovers.scan({
      installDir: path.dirname(process.execPath),
      dataDir: store.DATA_DIR,
      avdHome: p.avdHome,
    });
  });
  ipcMain.handle('leftovers:clean', async (_e, items) => {
    const hasSnap = (items || []).some((x) => x && x.kind === 'snapshot');
    if (hasSnap && engine.isRunning()) {
      return {
        removed: [],
        freedBytes: 0,
        failed: [{ path: 'snapshots', reason: 'Please stop the Android engine before deleting old snapshots.' }],
      };
    }
    const p = runtimePaths();
    return leftovers.clean(items, {
      installDir: path.dirname(process.execPath),
      avdHome: p.avdHome,
    });
  });

  ipcMain.handle('app:removeSelf', async (_e, { wipeData = false } = {}) => {
    if (!app.isPackaged) {
      return { ok: false, error: 'Development mode: cannot self-uninstall source checkout.' };
    }
    isQuitting = true;
    try { unregisterAssociation(); } catch (_) { /* ignore */ }
    try {
      const { desktop, startMenu } = shortcutDirs();
      for (const a of store.getApps()) {
        const sc = a.shortcut || {};
        if (sc.desktop) removeShortcut(sc.desktop);
        if (sc.startMenu) removeShortcut(sc.startMenu);
        removeShortcut(path.join(desktop, `${safeFileName(a.label)}.lnk`));
      }
      fs.rmSync(startMenu, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
    sharer.stop();
    notifyBridge.stop();
    await runtime.stop();
    winAgent.dispose();

    const installDir = path.dirname(process.execPath);
    let uninstaller = '';
    try {
      const candidates = fs.readdirSync(installDir).filter((f) => /^(Uninstall\b|unins\d*).*\.exe$/i.test(f));
      if (candidates.length) uninstaller = path.join(installDir, candidates[0]);
    } catch (_) { /* ignore */ }

    const { spawn } = require('child_process');
    if (wipeData) {
      try { fs.rmSync(store.DATA_DIR, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    if (uninstaller && fs.existsSync(uninstaller)) {
      spawn(uninstaller, [], { detached: true, stdio: 'ignore' }).unref();
    } else {
      const ps = `Start-Sleep -Milliseconds 1200; Remove-Item -LiteralPath '${installDir.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`;
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
        detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    }
    setTimeout(() => app.quit(), 200);
    return { ok: true };
  });

  ipcMain.handle('share:openLocal', () => {
    const dir = sharer.localDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return dir;
  });
  ipcMain.handle('share:syncNow', async () => {
    await sharer.syncOnce();
    return { ok: true };
  });
  ipcMain.handle('share:pushFile', () => guardDialog(async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Select File(s) to Send to Android',
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return { ok: false };
    const sent = [];
    for (const f of r.filePaths) sent.push(await sharer.pushFileNow(f));
    return { ok: true, sent };
  }));

  ipcMain.handle('assoc:register', () => {
    const { target, prefixArgs } = appExeTarget();
    const ico = path.join(store.DATA_DIR, 'brand.ico');
    return registerAssociation(target, fs.existsSync(ico) ? ico : target, prefixArgs);
  });
  ipcMain.handle('assoc:unregister', () => unregisterAssociation());

  ipcMain.handle('app:openData', () => shell.openPath(store.DATA_DIR));
  ipcMain.handle('shell:openPath', (_e, targetPath) => {
    if (!isAllowedLocalPath(targetPath)) return { ok: false, error: 'Path is outside ApkStart directories' };
    return shell.openPath(path.resolve(targetPath));
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  initSubsystems();
  registerIpc();
  createTray();
  applyAutoStart();

  const { trayOnly } = parseArgv(process.argv);
  if (!trayOnly) createMainWindow(false);
  await handleLaunchArgs(process.argv);

  const s = store.getSettings();
  const provisionStatus = await provisioner.status();
  if (s.engine && s.engine.prewarm && s.engine.mode === 'builtin'
      && (provisionStatus.installed || provisionStatus.ready) && !(appWin && appWin.isOpen)) {
    setTimeout(() => {
      if (isQuitting || (appWin && appWin.isOpen) || engine.isRunning()) return;
      runtime.ensure().then((rt) => {
        if (rt && rt.ok) scheduleIdleCheck();
      }).catch(() => {});
    }, 3500).unref?.();
  }
});

app.on('window-all-closed', () => {
  // Keep alive in the system tray on Windows for instant shortcut launches unless quitting or tray is unavailable.
  if (isQuitting || !tray) app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  try { sharer?.stop(); } catch (_) { /* ignore */ }
  try { notifyBridge?.stop(); } catch (_) { /* ignore */ }
  try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
  try { winAgent?.dispose(); } catch (_) { /* ignore */ }
});

module.exports = { isPendingDialog: () => pendingOpenCount > 0 };
