'use strict';
/**
 * End-to-end APK / Split-APK (`.apks`, `.xapk`) installation, icon materialization,
 * Windows Desktop/Start Menu `.lnk` shortcut creation, and resilient app launch pipeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { parseApk, parseApkZip, quickCheck } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');
const store = require('./store');

function isBundleFile(p) {
  return /\.(apks|xapk)$/i.test(String(p || ''));
}

/**
 * Extract all `.apk` splits from a `.apks` / `.xapk` bundle using `ZipFile.pipeTo`
 * so multi-GB game bundles never buffer in RAM, and parse the base APK metadata.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const apkEntries = zip.list().filter((e) => /\.apk$/i.test(e.name) && !e.name.endsWith('/'));
  if (!apkEntries.length) {
    zip.close();
    throw new Error('No split APK entries found inside bundle archive (file may be corrupted or unsupported)');
  }
  const tag = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
  const tmpDir = path.join(os.tmpdir(), 'apkstart-bundle', tag);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const files = [];
  let baseMeta = null;
  try {
    apkEntries.sort((a, b) => {
      const rank = (n) => (/^(.*\/)?base\.apk$/i.test(n) ? 0 : 1);
      return rank(a.name) - rank(b.name);
    });
    for (let i = 0; i < apkEntries.length; i += 1) {
      const e = apkEntries[i];
      const baseName = `${String(i).padStart(2, '0')}-${path.basename(e.name).replace(/[^\w.-]/g, '_')}`;
      const out = path.join(tmpDir, baseName);
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(e.name, fs.createWriteStream(out));
      files.push(out);
      if (!baseMeta) {
        const sub = new ZipFile(out);
        try {
          const m = parseApkZip(sub, zip.size);
          if (m && m.package && m.launchActivity) baseMeta = m;
          else if (m && m.package && !baseMeta) baseMeta = m;
        } catch (_) { /* Configuration split without full manifest; keep scanning */ }
        finally { sub.close(); }
      }
    }
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    zip.close();
  }
  if (!baseMeta || !baseMeta.package) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('Unable to parse base APK inside bundle archive');
  }
  return {
    meta: { ...baseMeta, filePath },
    files,
    cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ } },
  };
}

function accentFrom(str) {
  const h = crypto.createHash('md5').update(str).digest();
  const hue = (h[0] * 360) >> 8;
  const s = 0.55, l = 0.52;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Reinstall an already-recorded app (`store.getApp(pkg)`), handling both single `.apk`
 * archives and multi-split `.apks` / `.xapk` bundles transparently.
 */
async function installStoredApp(client, appRecord, onProgress) {
  if (!appRecord || !appRecord.apkPath || !fs.existsSync(appRecord.apkPath)) {
    throw new Error(`Cached APK archive not found for ${appRecord ? appRecord.package : 'unknown app'}`);
  }
  if (appRecord.bundle || isBundleFile(appRecord.apkPath)) {
    const bundle = await parseBundle(appRecord.apkPath);
    try {
      await client.installMultiple(bundle.files, onProgress);
    } finally {
      bundle.cleanup();
    }
    return;
  }
  await client.install(appRecord.apkPath, onProgress);
}

class Installer {
  constructor(runtime, opts) {
    this.runtime = runtime;
    this.opts = opts; // { launcherTarget, launcherArgs, cwd, desktopDir, startMenuDir, decodeIcon }
  }

  shortcutDir() {
    const custom = store.getSettings().shortcutDir;
    if (custom && fs.existsSync(custom)) return custom;
    return this.opts.desktopDir;
  }

  shortcutPathFor(label, dir = this.shortcutDir()) {
    return path.join(dir, `${safeFileName(label)}.lnk`);
  }

  createShortcut(appRecord, dir) {
    const linkPath = this.shortcutPathFor(appRecord.label, dir);
    const launchArgs = [
      this.opts.launcherArgs || '',
      `--launch=${appRecord.package}`,
    ].filter(Boolean).join(' ');

    writeShortcut({
      shortcutPath: linkPath,
      target: this.opts.launcherTarget,
      args: launchArgs,
      iconIcoPath: appRecord.icoPath || undefined,
      description: `${appRecord.label} (${appRecord.package}) — Run with ApkStart`,
      cwd: this.opts.cwd,
      appUserModelId: `com.apkstart.app.${appRecord.package}`,
    });
    return linkPath;
  }

  createStartMenuShortcut(appRecord) {
    if (!this.opts.startMenuDir) return null;
    return this.createShortcut(appRecord, this.opts.startMenuDir);
  }

  async ensureIconFor(app) {
    if (app.icoPath && fs.existsSync(app.icoPath)) return app.icoPath;
    const icoPath = path.join(store.ICON_DIR, `${app.package}.ico`);
    let raw = null;
    if (app.iconPath && fs.existsSync(app.iconPath)) {
      try { raw = fs.readFileSync(app.iconPath); } catch (_) { raw = null; }
    }
    const ico = await iconToIco(raw || Buffer.alloc(1), { decode: this.opts.decodeIcon });
    if (!ico) return null;
    fs.writeFileSync(icoPath, ico);
    store.upsertApp({ package: app.package, icoPath });
    app.icoPath = icoPath;
    return icoPath;
  }

  async ensureShortcuts() {
    const settings = store.getSettings();
    const fixed = [];
    for (const app of store.getApps()) {
      await this.ensureIconFor(app);
      const patch = {};
      if (settings.createShortcutOnInstall !== false) {
        if (!app.shortcutPath || !fs.existsSync(app.shortcutPath)) {
          try { patch.shortcutPath = this.createShortcut(app); fixed.push(app.label); } catch (_) { /* ignore */ }
        }
      }
      if (settings.createStartMenuShortcut !== false && this.opts.startMenuDir) {
        if (!app.startMenuPath || !fs.existsSync(app.startMenuPath)) {
          try { patch.startMenuPath = this.createStartMenuShortcut(app); } catch (_) { /* ignore */ }
        }
      }
      if (Object.keys(patch).length) store.upsertApp({ package: app.package, ...patch });
    }
    return fixed;
  }

  async install(filePath, emit = () => {}) {
    if (!filePath || !fs.existsSync(filePath)) throw new Error('APK file does not exist');
    if (!quickCheck(filePath)) throw new Error('Not a valid APK / ZIP archive');

    const bundle = isBundleFile(filePath);
    emit({ stage: 'parse', message: bundle ? 'Extracting split APK bundle...' : 'Parsing APK manifest & resources...' });

    let meta;
    let bundlePack = null;
    try {
      if (bundle) {
        bundlePack = await parseBundle(filePath);
        meta = bundlePack.meta;
      } else {
        meta = parseApk(filePath);
      }
    } catch (e) {
      if (bundlePack) bundlePack.cleanup();
      throw e;
    }
    if (!meta.package) {
      if (bundlePack) bundlePack.cleanup();
      throw new Error('Could not determine package name from AndroidManifest.xml');
    }

    try {
      emit({ stage: 'parse-done', meta, message: `${meta.label} (${meta.package}) v${meta.versionName}` });
      return await this._installParsed({ filePath, meta, bundle, bundlePack, emit });
    } finally {
      if (bundlePack) bundlePack.cleanup();
    }
  }

  async installApk(filePath, onProgress) {
    const result = await this.install(filePath, (event) => {
      if (onProgress) onProgress(event.message || event);
    });
    return { ...result.app, app: result.app, warnings: result.warnings || [] };
  }

  async installStoredApp(appRecord, client, onProgress) {
    return installStoredApp(client, appRecord, onProgress);
  }

  async rebuildShortcutFor(pkg) {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error(`App is not registered: ${pkg}`);
    await this.ensureIconFor(appRecord);
    const patch = {};
    const settings = store.getSettings();
    if (settings.createShortcutOnInstall !== false) patch.shortcutPath = this.createShortcut(appRecord);
    if (settings.createStartMenuShortcut !== false && this.opts.startMenuDir) {
      patch.startMenuPath = this.createStartMenuShortcut(appRecord);
    }
    const updated = { ...appRecord, ...patch };
    store.upsertApp({ package: pkg, ...patch });
    return updated;
  }

  async rebuildAllShortcuts() {
    const apps = store.getApps();
    for (const app of apps) {
      // eslint-disable-next-line no-await-in-loop
      await this.rebuildShortcutFor(app.package).catch(() => {});
    }
    return store.getApps();
  }

  async _installParsed({ filePath, meta, bundle, bundlePack, emit }) {
    const warnings = [];
    const hasX86 = meta.abis.length === 0 || meta.abis.some((a) => a.startsWith('x86'));
    if (!hasX86) {
      warnings.push(`ARM-only native libraries (${meta.abis.join(', ')}).`);
      if (!store.getSettings().runtime.compatImage) {
        store.saveSettings({ runtime: { compatImage: true } });
        emit({ stage: 'runtime', message: 'Detected ARM-only app: enabling Android 14 universal ARM-compatible image...' });
        const playInfo = this.runtime.provisioner.playImageInfo();
        if (!playInfo.ok) {
          emit({ stage: 'runtime', message: 'First ARM app: downloading Android 14 universal image (~1.5 GB, one-time)...' });
          await this.runtime.provisioner.installPlayImage((p) => {
            emit({ stage: 'runtime', message: p.message || 'Downloading universal image...', percent: p.percent });
          });
        }
        if (this.runtime.emulator.running()) {
          emit({ stage: 'runtime', message: 'Switching to universal ARM-compatible image...' });
          await this.runtime.stop({ graceful: false });
        }
      }
    }

    emit({ stage: 'runtime', message: 'Preparing Android runtime...' });
    let rt = await this.runtime.ensure({
      onLog: (m) => emit({ stage: 'runtime', message: m }),
    });
    if (!rt.ok && rt.needsSetup && store.getSettings().autoDeploy !== false) {
      emit({ stage: 'runtime', message: 'First launch: downloading the Android runtime (a large one-time download, often over 1 GB)...' });
      const p = this.runtime.provisioner;
      const env0 = await p.checkEnv();
      const step = (msg) => (pr) => emit({
        stage: 'runtime',
        message: pr.message || msg,
        percent: pr.percent,
      });
      if ((!env0.emulator.ok || !env0.sysimg.ok) && store.getSettings().runtime.preferGithubRuntime !== false) {
        try {
          await p.installRuntimePack(step('Downloading runtime bundle from GitHub...'));
        } catch (e) {
          emit({ stage: 'runtime', message: `GitHub runtime bundle unavailable (${e.message}); falling back to official SDK sources...` });
        }
      }
      const env = await p.checkEnv();
      if (!env.adb.ok) await p.installAdb(step('Downloading ADB...'));
      if (!env.emulator.ok) await p.installEmulator(step('Downloading Android Emulator engine...'));
      if (!env.sysimg.ok) await p.installSystemImage(step('Downloading Android system image...'));
      rt = await this.runtime.ensure({ onLog: (m) => emit({ stage: 'runtime', message: m }) });
    }
    if (!rt.ok) {
      const err = new Error(rt.error);
      err.needsSetup = rt.needsSetup;
      throw err;
    }

    const doInstall = async (client) => {
      if (bundle && bundlePack) {
        await client.installMultiple(bundlePack.files, (p) => emit({ stage: 'install', message: p.message }));
      } else {
        await client.install(filePath, (p) => emit({ stage: 'install', message: p.message }));
      }
    };

    emit({ stage: 'install', message: `Installing ${meta.label}...` });
    try {
      await doInstall(rt.client);
    } catch (e) {
      if (/NO_MATCHING_ABIS/.test(e.message) && !store.getSettings().runtime.compatImage) {
        emit({ stage: 'runtime', message: 'ARM native library mismatch: switching to Android 14 universal image and retrying...' });
        store.saveSettings({ runtime: { compatImage: true } });
        if (!this.runtime.provisioner.playImageInfo().ok) {
          await this.runtime.provisioner.installPlayImage((p) => emit({
            stage: 'runtime', message: p.message || 'Downloading universal image...', percent: p.percent,
          }));
        }
        await this.runtime.stop({ graceful: false });
        const rt2 = await this.runtime.ensure({ onLog: (m) => emit({ stage: 'runtime', message: m }) });
        if (!rt2.ok) throw new Error(rt2.error);
        rt = rt2;
        await doInstall(rt.client);
      } else {
        throw e;
      }
    }

    store.ensureDirs();
    const cachedExt = bundle ? (path.extname(filePath).toLowerCase() || '.xapk') : '.apk';
    const apkCopy = path.join(store.APK_DIR, `${meta.package}-${meta.versionCode || '0'}${cachedExt}`);
    try {
      if (path.resolve(filePath) !== path.resolve(apkCopy)) fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* Non-fatal if disk is tight; falls back to original path */ }

    let iconPath = null;
    let icoPath = null;
    if (meta.iconPng) {
      const ext = (meta.iconFile && path.extname(meta.iconFile).toLowerCase()) || '.png';
      iconPath = path.join(store.ICON_DIR, `${meta.package}${ext}`);
      fs.writeFileSync(iconPath, meta.iconPng);
      const ico = await iconToIco(meta.iconPng, {
        decode: this.opts.decodeIcon,
        onFallback: (why) => warnings.push(`Icon fallback applied (${why})`),
      });
      if (ico) {
        icoPath = path.join(store.ICON_DIR, `${meta.package}.ico`);
        fs.writeFileSync(icoPath, ico);
      }
    } else {
      const ico = await iconToIco(Buffer.from('placeholder'), { decode: null });
      if (ico) {
        icoPath = path.join(store.ICON_DIR, `${meta.package}.ico`);
        fs.writeFileSync(icoPath, ico);
      }
    }

    const resolvedActivity = await rt.client.resolveLauncher(meta.package);
    const activity = resolvedActivity || meta.launchActivity;

    const prev = store.getApp(meta.package);
    const record = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity,
      apkPath: fs.existsSync(apkCopy) ? apkCopy : filePath,
      bundle: Boolean(bundle),
      iconPath,
      icoPath,
      accent: accentFrom(meta.package),
      abis: meta.abis,
      sizeBytes: meta.sizeBytes,
      installedAt: prev?.installedAt || Date.now(),
      updatedAt: Date.now(),
      lastLaunchAt: prev?.lastLaunchAt || null,
      shortcutPath: prev?.shortcutPath || null,
      startMenuPath: prev?.startMenuPath || null,
      pinned: prev?.pinned || false,
    };

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      emit({ stage: 'shortcut', message: 'Creating desktop shortcut...' });
      try {
        if (prev?.shortcutPath && prev.label !== record.label) removeShortcut(prev.shortcutPath);
        record.shortcutPath = this.createShortcut(record);
      } catch (e) {
        warnings.push(`Desktop shortcut was not created (${e.message}); you can retry from the app card menu.`);
      }
    }
    if (settings.createStartMenuShortcut !== false && this.opts.startMenuDir) {
      try {
        if (prev?.startMenuPath && prev.label !== record.label) removeShortcut(prev.startMenuPath);
        record.startMenuPath = this.createStartMenuShortcut(record);
      } catch (_) { /* ignore */ }
    }

    await rt.client.batteryOptimizeOff(meta.package);

    store.upsertApp(record);
    emit({ stage: 'done', app: record, warnings, message: 'Installation complete' });
    return { app: record, warnings };
  }

  async launch(pkg, { onLog, onMark, beforeStart } = {}) {
    const mark = (s) => { if (onMark) onMark(s); };
    const app = store.getApp(pkg);
    if (!app) throw new Error(`App is not registered: ${pkg}`);

    mark('ensure begin');
    const rt = await this.runtime.ensure({ onLog });
    mark(`ensure done ok=${rt.ok}`);
    if (!rt.ok) throw new Error(rt.error);

    if (!(await rt.client.isInstalled(pkg))) {
      if (app.apkPath && fs.existsSync(app.apkPath)) {
        if (onLog) onLog('Reinstalling app into clean Android runtime...');
        await installStoredApp(rt.client, app);
        mark('reinstalled');
      } else {
        throw new Error('App is no longer installed in Android and the cached APK archive is missing. Please reinstall the APK.');
      }
    }

    const freeform = store.getSettings().engine.freeformWindows && (await rt.client.supportsFreeform());
    if (freeform) await rt.client.enableFreeform();

    const net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 25000 });
    mark(`net ok=${net && net.ok}`);
    if (beforeStart) await beforeStart(rt);

    if (onLog) onLog(`Launching ${app.label}...`);
    await rt.client.startApp(app.package, app.activity, { freeform });
    mark('am start returned');

    let life = await rt.client.waitAppAlive(app.package, 6000);
    mark(`alive1=${life.alive} fg=${life.foreground} crashed=${!!life.crashed}`);
    if (!life.alive && !life.crashed) {
      await rt.client.startApp(app.package, '', { freeform });
      life = await rt.client.waitAppAlive(app.package, 4000);
      mark(`alive2=${life.alive}`);
    }

    if (life.crashed) {
      let crashNeedsRepair = false;
      try {
        const log = await rt.client.shell('logcat -d -t 260 *:E', { timeout: 6000 });
        crashNeedsRepair = /UnsatisfiedLinkError|dlopen failed|cannot locate symbol|INSTALL_FAILED_NO_MATCHING_ABIS|FileNotFoundException.*split|Resources\$NotFoundException/i.test(log);
      } catch (_) { /* ignore */ }

      const canSwitch = !store.getSettings().runtime.compatImage
        && app.abis && app.abis.length > 0 && !app.abis.some((a) => a.startsWith('x86'));
      if (canSwitch) {
        if (onLog) onLog('App crashed on x86_64 image: switching to Android 14 universal ARM-compatible image...');
        store.saveSettings({ runtime: { compatImage: true } });
        if (!this.runtime.provisioner.playImageInfo().ok) {
          await this.runtime.provisioner.installPlayImage((p) => onLog && onLog(p.message || 'Downloading universal image...'));
        }
        await this.runtime.stop({ graceful: false });
        const rt2 = await this.runtime.ensure({ onLog });
        if (!rt2.ok) throw new Error(rt2.error);
        if (app.apkPath && fs.existsSync(app.apkPath)) await installStoredApp(rt2.client, app);
        if (beforeStart) await beforeStart(rt2);
        await rt2.client.startApp(app.package, app.activity, { freeform: false });
        life = await rt2.client.waitAppAlive(app.package, 6000);
      } else if (crashNeedsRepair && app.apkPath && fs.existsSync(app.apkPath)) {
        if (onLog) onLog('Detected missing native library or split resource; reinstalling app...');
        await installStoredApp(rt.client, app);
        await rt.client.startApp(app.package, app.activity, { freeform });
        life = await rt.client.waitAppAlive(app.package, 6000);
      }
      if (!life.alive) {
        throw new Error(`${app.label} exited immediately after launch (commonly caused by root/emulator detection or missing GMS requirements).`);
      }
    }

    store.upsertApp({ package: pkg, lastLaunchAt: Date.now() });
    return { ok: true, freeform, engine: rt.engine };
  }

  async uninstall(pkg, { fromDevice = true } = {}) {
    const app = store.getApp(pkg);
    if (!app) return;
    if (fromDevice) {
      try {
        const c = this.runtime.client();
        if (await c.isOnline()) await c.uninstall(pkg);
      } catch (_) { /* Remove local state even if runtime is offline */ }
    }
    removeShortcut(app.shortcutPath);
    removeShortcut(app.startMenuPath);
    for (const p of [app.apkPath, app.iconPath, app.icoPath]) {
      try { if (p && p.startsWith(store.DATA_DIR) && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
    }
    store.removeApp(pkg);
  }
}

module.exports = { Installer, parseBundle, isBundleFile, installStoredApp };
