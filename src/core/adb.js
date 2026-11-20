'use strict';
/**
 * ADB protocol client (wraps platform-tools/adb with zero external dependencies).
 *
 * Isolates ApkStart's ADB server onto port 5044 (`ANDROID_ADB_SERVER_PORT=5044`) so
 * Android Studio, Scrcpy, or third-party emulators running mismatched ADB versions on
 * default port 5037 never kill or reset ApkStart's connection.
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pointer = require('./pointer');

const ADB_SERVER_PORT = 5044;
const SAFE_PKG = /^([A-Za-z][A-Za-z0-9_]*\.)+[A-Za-z][A-Za-z0-9_]*$/;

function adbEnv(extra) {
  return { ...process.env, ANDROID_ADB_SERVER_PORT: String(ADB_SERVER_PORT), ...(extra || {}) };
}

/** POSIX single-quote escaping for Android shell commands */
function shQuote(val) {
  return `'${String(val == null ? '' : val).replace(/'/g, "'\\''")}'`;
}

function assertSafePkg(pkg) {
  const s = String(pkg || '').trim();
  if (!SAFE_PKG.test(s)) throw new Error(`Invalid Android package name: ${s || '(empty)'}`);
  return s;
}

const KNOWN_INSTALL_ERRORS = [
  [/INSTALL_FAILED_NO_MATCHING_ABIS/,
    'This APK only ships ARM native libraries while the current guest image is x86_64 without ARM translation. Enable the Android 14 universal compatible image in Settings -> Runtime.'],
  [/INSTALL_FAILED_DEPRECATED_SDK_VERSION/,
    'Android 14 blocks apps targeting an obsolete SDK version. ApkStart can automatically use the Android 14 compatibility image; update or reinstall the app after switching images.'],
  [/INSTALL_FAILED_OLDER_SDK/,
    'This APK requires a newer Android SDK version than the current system image provides.'],
  [/INSTALL_FAILED_INSUFFICIENT_STORAGE/,
    'Insufficient Android /data storage space. Increase the Android Data Partition size in Settings -> Performance or uninstall unused apps.'],
  [/INSTALL_FAILED_VERSION_DOWNGRADE/,
    'A newer version of this app is already installed. Uninstall the existing version first if you want to downgrade.'],
  [/INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_SHARED_USER_INCOMPATIBLE/,
    'An existing installation with a different signature conflicts with this APK. Uninstall the existing app first, then reinstall.'],
  [/INSTALL_PARSE_FAILED_NO_CERTIFICATES|INSTALL_PARSE_FAILED_BAD_MANIFEST|INSTALL_FAILED_INVALID_APK/,
    'The APK archive is corrupted, incomplete, or unsigned. Please re-download the package and try again.'],
  [/INSTALL_FAILED_TEST_ONLY/,
    'This is a debug/test-only APK (automatically retried with -t; if it still fails, check its signature).'],
  [/INSTALL_FAILED_MISSING_SPLIT/,
    'This is a split APK missing required configuration splits (ABI/DPI/language). Install the full .apks / .xapk bundle instead.'],
  [/INSTALL_FAILED_DEXOPT|INSTALL_FAILED_CONTAINER_ERROR/,
    'Android package optimization failed, usually caused by low /data storage space or a corrupted download.'],
  [/device offline|device '.*' not found|cannot connect to daemon|closed/i,
    'Lost connection to the Android runtime during installation. Please retry in a few seconds.'],
];

function friendlyInstallError(raw) {
  const text = String(raw || '').trim();
  const code = (/\[([A-Z0-9_]+)(?::[^\]]*)?\]/.exec(text) || [])[1];
  for (const [re, hint] of KNOWN_INSTALL_ERRORS) {
    if (re.test(text)) return code ? `${hint} (${code})` : hint;
  }
  const oneLine = text.replace(/\s+/g, ' ').slice(0, 260);
  return `Installation failed: ${oneLine || 'unknown error'}`;
}

function friendlyLaunchError(raw, pkg = '') {
  const text = String(raw || '').trim();
  const target = pkg ? ` ${pkg}` : '';
  if (/libndk_translation|DoBadTrampoline|ARM translation|SIGABRT/i.test(text)) {
    return `The ARM translation layer crashed while starting${target}. Switch to the Android 14 ARM-compatible system image in Settings -> Runtime, then reinstall the app.`;
  }
  if (/INSTALL_FAILED_DEPRECATED_SDK_VERSION|target.*(?:too old|obsolete|at least 23)/i.test(text)) {
    return `Android 14 blocks this app${target} because its target SDK is obsolete. Update the app or use the Android 14 compatibility image.`;
  }
  const oneLine = text.replace(/\s+/g, ' ').slice(0, 300);
  return `Unable to launch${target}: ${oneLine || 'unknown Android error'}`;
}

const COMMON_ADB_LOCATIONS = [
  () => process.env.APKSTART_ADB,
  () => path.join(process.resourcesPath || '', 'runtime', 'platform-tools', 'adb.exe'),
  () => path.join(process.cwd(), 'engine', 'platform-tools', 'adb.exe'),
  () => path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  () => path.join(process.env.USERPROFILE || '', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  () => 'C:\\Android\\platform-tools\\adb.exe',
  () => path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Android', 'platform-tools', 'adb.exe'),
];

function findAdb(explicitPath) {
  if (explicitPath && fs.existsSync(explicitPath)) return explicitPath;
  for (const fn of COMMON_ADB_LOCATIONS) {
    try {
      const p = fn();
      if (p && fs.existsSync(p)) return p;
    } catch (_) { /* ignore */ }
  }
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, 'adb' + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, {
      timeout: opts.timeout ?? 60000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      encoding: opts.encoding ?? 'utf8',
      env: adbEnv(),
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
    if (opts.onSpawn) opts.onSpawn(child);
  });
}

const COMMON_PORTS = [
  { port: 58526, name: 'Windows Subsystem for Android (WSA)' },
  { port: 5555, name: 'Built-in Runtime / Default ADB' },
  { port: 16384, name: 'MuMu Player 12' },
  { port: 7555, name: 'MuMu Player' },
  { port: 62001, name: 'NoxPlayer' },
  { port: 21503, name: 'MEmu Play' },
];

class AdbClient {
  constructor(opts = {}) {
    this.explicitAdb = opts.adbPath || '';
    this.serial = opts.serial || '';
    this._input = null;
  }

  bin() {
    const b = findAdb(this.explicitAdb);
    if (!b) throw new Error('ADB executable not found. Deploy the built-in runtime in Settings -> Runtime first.');
    return b;
  }

  hasAdb() { return Boolean(findAdb(this.explicitAdb)); }

  args(rest) {
    return this.serial ? ['-s', this.serial, ...rest] : rest;
  }

  async exec(rest, opts) {
    return run(this.bin(), this.args(rest), opts);
  }

  async shell(cmd, opts) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return stdout.replace(/\r\n/g, '\n');
  }

  /**
   * Persistent low-latency `adb shell` stdin pipe for mouse right-click BACK and
   * smooth wheel swipes. Avoids spawning a new `adb.exe` + `sh` process per gesture.
   * Strictly gated by `pointer.isInputCommand` whitelist to prevent shell injection.
   */
  input(cmd) {
    if (!pointer.isInputCommand(cmd)) {
      return Promise.reject(new Error(`Invalid input command rejected: ${cmd}`));
    }
    try {
      const proc = this._ensureInputShell();
      return new Promise((resolve, reject) => {
        proc.stdin.write(`${cmd}\n`, (err) => (err ? reject(err) : resolve()));
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  _ensureInputShell() {
    if (this._input && !this._input.killed && this._input.stdin && !this._input.stdin.destroyed) {
      return this._input;
    }
    const child = spawn(this.bin(), this.args(['shell']), {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      env: adbEnv(),
    });
    const clear = () => { if (this._input === child) this._input = null; };
    child.on('exit', clear);
    child.on('error', clear);
    if (child.stdin) child.stdin.on('error', clear);
    this._input = child;
    return child;
  }

  closeInput() {
    const p = this._input;
    this._input = null;
    if (!p) return;
    try { p.stdin?.end(); } catch (_) { /* ignore */ }
    try { p.kill(); } catch (_) { /* ignore */ }
  }

  async startServer() {
    await run(this.bin(), ['start-server'], { timeout: 15000 });
  }

  async devices() {
    await this.startServer();
    const { stdout } = await run(this.bin(), ['devices', '-l']);
    const list = [];
    for (const line of stdout.split(/\r?\n/).slice(1)) {
      const m = /^(\S+)\s+(device|offline|unauthorized)\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      const model = (/model:(\S+)/.exec(m[3]) || [])[1] || m[1];
      list.push({ serial: m[1], state: m[2], model, raw: m[3] });
    }
    return list;
  }

  async connect(hostPort) {
    try {
      const { stdout } = await run(this.bin(), ['connect', hostPort], { timeout: 5000 });
      return /connected to|already connected/i.test(stdout);
    } catch (_) {
      return false;
    }
  }

  async probeKnownPorts() {
    const found = [];
    for (const item of COMMON_PORTS) {
      const target = `127.0.0.1:${item.port}`;
      if (await this.connect(target)) found.push({ serial: target, name: item.name });
    }
    return found;
  }

  async isOnline() {
    if (!this.hasAdb()) return false;
    try {
      const devs = await this.devices();
      const online = devs.filter((d) => d.state === 'device');
      if (this.serial) return online.some((d) => d.serial === this.serial);
      if (online.length) { this.serial = online[0].serial; return true; }
      return false;
    } catch (_) {
      return false;
    }
  }

  async install(apkPath, onProgress) {
    if (onProgress) onProgress({ stage: 'push', message: 'Transferring and installing APK...' });
    const attempt = async (extraFlags) => {
      const { stdout, stderr } = await this.exec(
        ['install', '-r', '-d', '-g', ...extraFlags, apkPath],
        { timeout: 10 * 60 * 1000 },
      );
      return `${stdout}\n${stderr}`;
    };
    let out;
    try {
      out = await attempt([]);
    } catch (e) {
      const raw = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`;
      if (/INSTALL_FAILED_TEST_ONLY/.test(raw)) {
        try {
          out = await attempt(['-t']);
        } catch (e2) {
          throw new Error(friendlyInstallError(`${e2.stdout || ''}\n${e2.stderr || ''}\n${e2.message || ''}`));
        }
      } else {
        throw new Error(friendlyInstallError(raw));
      }
    }
    if (!/Success/i.test(out)) {
      if (/INSTALL_FAILED_TEST_ONLY/.test(out)) {
        const out2 = await attempt(['-t']);
        if (/Success/i.test(out2)) return true;
        throw new Error(friendlyInstallError(out2));
      }
      throw new Error(friendlyInstallError(out));
    }
    return true;
  }

  async installMultiple(apkPaths, onProgress) {
    if (!Array.isArray(apkPaths) || !apkPaths.length) {
      throw new Error('Split APK installation failed: empty split list');
    }
    if (onProgress) {
      onProgress({ stage: 'push', message: `Installing ${apkPaths.length} split APK components...` });
    }
    const attempt = async (extraFlags) => {
      const { stdout, stderr } = await this.exec(
        ['install-multiple', '-r', '-d', '-g', ...extraFlags, ...apkPaths],
        { timeout: 12 * 60 * 1000 },
      );
      return `${stdout}\n${stderr}`;
    };
    let out;
    try {
      out = await attempt([]);
    } catch (e) {
      const raw = `${e.stdout || ''}\n${e.stderr || ''}\n${e.message || ''}`;
      if (/INSTALL_FAILED_TEST_ONLY/.test(raw)) {
        try {
          out = await attempt(['-t']);
        } catch (e2) {
          throw new Error(friendlyInstallError(`${e2.stdout || ''}\n${e2.stderr || ''}\n${e2.message || ''}`));
        }
      } else {
        throw new Error(friendlyInstallError(raw));
      }
    }
    if (!/Success/i.test(out)) {
      throw new Error(friendlyInstallError(out));
    }
    return true;
  }

  async uninstall(pkg) {
    const safe = assertSafePkg(pkg);
    await this.exec(['uninstall', safe], { timeout: 60000 });
  }

  async isInstalled(pkg) {
    try {
      const safe = assertSafePkg(pkg);
      const out = await this.shell(`pm path ${shQuote(safe)}`, { timeout: 8000 });
      return /^package:/m.test(out);
    } catch (_) {
      return false;
    }
  }

  async supportsFreeform() {
    try {
      const out = await this.shell('pm list features');
      return /android\.software\.freeform_window_management/.test(out);
    } catch (_) {
      return false;
    }
  }

  async ensureFreeform() {
    const supported = await this.supportsFreeform();
    if (!supported) return false;
    await this.enableFreeform();
    return true;
  }

  async sdkInt() {
    const value = Number((await this.shell('getprop ro.build.version.sdk')).trim());
    return Number.isFinite(value) ? value : 0;
  }

  async screenshot() {
    const { stdout } = await run(this.bin(), this.args(['exec-out', 'screencap', '-p']), {
      timeout: 30000,
      encoding: 'buffer',
    });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || '');
  }

  async enableFreeform() {
    try {
      await this.shell('settings put global enable_freeform_support 1');
      await this.shell('settings put global force_resizable_activities 1');
    } catch (_) { /* Read-only on some builds; safe to ignore */ }
  }

  /**
   * Prepare immersive foreground mode:
   *  - Dismiss lockscreen & collapse notification shade
   *  - Hide status & navigation bars (`immersive.full=*`)
   *  - Disable window/transition animations for snappy app launches
   */
  async prepareForeground() {
    const cmds = [
      'wm dismiss-keyguard',
      'input keyevent 82',
      'cmd statusbar collapse',
      'settings put global policy_control immersive.full=*',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put secure show_ime_with_hard_keyboard 1',
    ];
    for (const c of cmds) {
      try { await this.shell(c, { timeout: 5000 }); } catch (_) { /* ignore */ }
    }
  }

  async resolveLauncher(pkg) {
    try {
      const safe = assertSafePkg(pkg);
      const out = await this.shell(
        `cmd package resolve-activity --brief -c android.intent.category.LAUNCHER ${shQuote(safe)}`,
        { timeout: 8000 },
      );
      return parseResolvedActivity(safe, out);
    } catch (_) {
      return '';
    }
  }

  async resolveLauncherActivity(pkg) { return this.resolveLauncher(pkg); }

  async launch(pkg, activity, opts = {}) { return this.startApp(pkg, activity, opts); }

  async startApp(pkg, activity, opts = {}) {
    const safe = assertSafePkg(pkg);
    const windowing = opts.freeform ? '--windowingMode 5 ' : '';
    const runStart = async (comp) => {
      if (!comp) return { ok: false, out: 'empty-component' };
      const out = await this.shell(
        `am start -W ${windowing}-n ${shQuote(comp)} -a android.intent.action.MAIN -c android.intent.category.LAUNCHER`,
        { timeout: 25000 },
      );
      const bad = /Error:|Exception|Activity class .* does not exist|unable to resolve Intent|Permission Denial/i.test(out);
      return { ok: !bad, out };
    };

    const first = await runStart(componentArg(safe, activity));
    if (first.ok) return;

    const real = await this.resolveLauncher(safe);
    if (real) {
      const second = await runStart(real);
      if (second.ok) return;
    }

    const out = await this.shell(
      `monkey -p ${shQuote(safe)} -c android.intent.category.LAUNCHER 1`,
      { timeout: 15000 },
    );
    if (/No activities found|monkey aborted/i.test(out)) {
      throw new Error(`Unable to launch ${safe}: ${(first.out || out).trim().slice(0, 200)}`);
    }
  }

  async waitAppAlive(pkg, timeoutMs = 6000) {
    const safe = assertSafePkg(pkg);
    const end = Date.now() + timeoutMs;
    let seenPid = false;
    while (Date.now() < end) {
      try {
        const pid = (await this.shell(`pidof ${shQuote(safe)}`, { timeout: 4000 })).trim();
        if (pid) {
          seenPid = true;
          const win = await this.shell('dumpsys window displays', { timeout: 5000 }).catch(() => '');
          if (win.includes(safe)) return { alive: true, foreground: true };
        } else if (seenPid) {
          return { alive: false, crashed: true };
        }
      } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (seenPid) return { alive: true, foreground: false };
    try {
      const pid = (await this.shell(`pidof ${shQuote(safe)}`, { timeout: 4000 })).trim();
      return { alive: !!pid, foreground: false };
    } catch (_) {
      return { alive: false, foreground: false };
    }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities');
      const set = new Set();
      const re = /ActivityRecord\{[^\s]+\s+\S+\s+([\w.]+)\//g;
      let m;
      while ((m = re.exec(out))) set.add(m[1]);
      return [...set];
    } catch (_) {
      return [];
    }
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 5 * 60 * 1000 });
  }

  async pull(remote, local) {
    fs.mkdirSync(path.dirname(local), { recursive: true });
    await this.exec(['pull', remote, local], { timeout: 5 * 60 * 1000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p ${shQuote(remote)}`);
  }

  async listRemote(remote) {
    try {
      const out = await this.shell(`ls -la ${shQuote(remote)} 2>/dev/null`);
      const items = [];
      for (const line of out.split('\n')) {
        const m = /^([d\-l])[rwxstST\-]{9}\s+\d+\s+\S+(?:\s+\S+)?\s+(\d+)\s+(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|[A-Za-z]{3}\s+\d+\s+[\d:]+)\s+(.+)$/.exec(line.trim());
        if (!m) continue;
        const name = m[3].trim();
        if (name === '.' || name === '..') continue;
        items.push({ name, isDir: m[1] === 'd', size: Number(m[2]) });
      }
      return items;
    } catch (_) {
      return [];
    }
  }

  async listRemoteStat(remote) {
    try {
      const q = shQuote(remote);
      const cmd = `cd ${q} 2>/dev/null && find . -maxdepth 4 -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`;
      const out = await this.shell(cmd, { timeout: 15000 });
      return parseStatList(out);
    } catch (_) {
      return null;
    }
  }

  async androidVersion() {
    try {
      return (await this.shell('getprop ro.build.version.release')).trim();
    } catch (_) {
      return '';
    }
  }

  async wmSize() {
    try {
      const out = await this.shell('wm size');
      const over = /Override size:\s*(\d+)x(\d+)/i.exec(out);
      const phys = /Physical size:\s*(\d+)x(\d+)/i.exec(out);
      const m = over || phys;
      return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
    } catch (_) {
      return null;
    }
  }

  async setDisplaySize(w, h, dpi) {
    const rw = Math.round(w);
    const rh = Math.round(h);
    if (!Number.isFinite(rw) || !Number.isFinite(rh) || rw <= 0 || rh <= 0) return;
    await this.shell(`wm size ${rw}x${rh}`);
    if (dpi && Number.isFinite(Number(dpi))) await this.shell(`wm density ${Math.round(Number(dpi))}`);
  }

  async resetDisplaySize() {
    try { await this.shell('wm size reset'); } catch (_) { /* ignore */ }
    try { await this.shell('wm density reset'); } catch (_) { /* ignore */ }
  }

  async setOrientation(landscape) {
    const cmds = landscape
      ? [
        'wm size reset',
        'settings put system accelerometer_rotation 0',
        'settings put system user_rotation 1',
        'cmd window user-rotation lock 1',
        'wm density 190',
      ]
      : [
        'wm size reset',
        'wm density reset',
        'settings put system accelerometer_rotation 0',
        'settings put system user_rotation 0',
        'cmd window user-rotation lock 0',
      ];
    for (const c of cmds) {
      try { await this.shell(c, { timeout: 5000 }); } catch (_) { /* ignore */ }
    }
  }

  async resetDisplayOverrides() {
    for (const c of ['wm size reset', 'wm density reset', 'cmd window user-rotation lock 0']) {
      try { await this.shell(c, { timeout: 4000 }); } catch (_) { /* ignore */ }
    }
  }

  async keyBack() {
    return this._keyevent(4);
  }

  async keyForward() {
    return this._keyevent(125);
  }

  async _keyevent(code) {
    const n = Number(code);
    if (!Number.isInteger(n) || n < 0 || n > 400) return;
    const cmd = `input keyevent ${n}`;
    try {
      await this.input(cmd);
    } catch (_) {
      try { await this.shell(cmd, { timeout: 4000 }); } catch (__) { /* ignore */ }
    }
  }

  async clearData(pkg) {
    const safe = assertSafePkg(pkg);
    await this.shell(`pm clear ${shQuote(safe)}`);
  }

  async exportAppData(pkg, destFile) {
    const safe = assertSafePkg(pkg);
    const tmp = `/sdcard/.apkstart-backup-${Date.now()}.ab`;
    await this.exec(['backup', '-f', destFile, '-noapk', safe]).catch(async () => {
      await this.shell(`tar -czf ${shQuote(tmp)} /sdcard/Android/data/${shQuote(safe)} 2>/dev/null || true`);
      await this.pull(tmp, destFile);
      await this.shell(`rm -f ${shQuote(tmp)}`);
    });
    return fs.existsSync(destFile);
  }

  async forceStop(pkg) {
    try {
      const safe = assertSafePkg(pkg);
      await this.shell(`am force-stop ${shQuote(safe)}`, { timeout: 6000 });
    } catch (_) { /* ignore */ }
  }

  async batteryOptimizeOff(pkg) {
    try {
      const safe = assertSafePkg(pkg);
      await this.shell(`dumpsys deviceidle whitelist +${shQuote(safe)}`, { timeout: 6000 });
    } catch (_) { /* ignore */ }
  }
}

function parseStatList(out) {
  const text = String(out || '').trim();
  if (!text) return [];
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d+)\|(\d+)\|(?:\.\/)?(.+)$/.exec(line);
    if (!m) return null;
    rows.push({
      mtime: Number(m[1]) * 1000,
      size: Number(m[2]),
      rel: m[3],
    });
  }
  return rows;
}

function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

function parseResolvedActivity(pkg, out) {
  const lines = String(out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^priority=/i.test(s));
  const last = lines[lines.length - 1] || '';
  if (!last.includes('/') || /No activity/i.test(last)) return '';
  if (pkg && !last.startsWith(`${pkg}/`)) return '';
  return last;
}

module.exports = {
  AdbClient,
  findAdb,
  COMMON_PORTS,
  ADB_SERVER_PORT,
  adbEnv,
  shQuote,
  assertSafePkg,
  friendlyInstallError,
  friendlyLaunchError,
  parseStatList,
  componentArg,
  parseResolvedActivity,
  TMP_DIR: os.tmpdir(),
};
