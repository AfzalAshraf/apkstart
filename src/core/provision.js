'use strict';
/**
 * Runtime self-provisioning & image materialization (`Provisioner`).
 *
 * Supports:
 *  - Bundled offline runtime (`resources/runtime` with `.img.xz` / `.img.gz` streaming decompression)
 *  - Pre-assembled `ApkStart-runtime-*.zip` download from GitHub/Gitee Releases
 *  - Official Google Android SDK repository fallback (`platform-tools`, `emulator`, `system-images`, `AEHD`)
 *  - Standalone QEMU + Android-x86 ISO/qcow2 fallback
 *
 * Security & reliability invariants:
 *  - `extractZip` enforces strict Zip-Slip boundary checks (`destAbs + path.sep`);
 *  - `inspectIso` and `inspectImage` always close file descriptors in `finally`;
 *  - `materializeImages` streams into `.part` files and atomically renames on completion.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { execFile, spawn } = require('child_process');
const { download, downloadMulti, head } = require('./download');
const { Sources } = require('./sources');
const { ZipFile } = require('./zip');
const { findAdb } = require('./adb');
const store = require('./store');

function baseOf(url) {
  return String(url).replace(/[^/]+$/, '');
}

function absUrl(u, baseUrl = 'https://dl.google.com/android/repository/') {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return base + String(u).replace(/^\/+/, '');
}

const SOURCES = {
  platformTools: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  playSysImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  addonIndex: 'https://dl.google.com/android/repository/addon2-3.xml',
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-12650504.zip',
  sysImgFallback: {
    url: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
    api: '34',
    tag: 'google_apis_playstore',
  },
  playSysImgFallback: {
    url: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
    api: '34',
    tag: 'google_apis_playstore',
  },
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  qemuFallbacks: [
    'https://qemu.weilnetz.de/w64/2024/qemu-w64-setup-20240423.exe',
    'https://qemu.weilnetz.de/w64/2023/qemu-w64-setup-20231224.exe',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/2024/',
  androidIsoMirrors: [
    'https://sourceforge.net/projects/android-x86/files/Release%209.0/android-x86_64-9.0-r2.iso/download',
    'https://osdn.net/frs/redir.php?m=acc&f=android-x86%2F71931%2Fandroid-x86_64-9.0-r2.iso',
  ],
  isoMinBytes: 400 * 1024 * 1024,
};

function execOut(bin, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function fetchText(url) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'ApkStart/0.4' }, timeout: 15000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchText(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

const QEMU_SEARCH = [
  (root) => path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
  () => path.join(process.resourcesPath || '', 'runtime', 'qemu', 'qemu-system-x86_64.exe'),
  () => 'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',
  () => 'C:\\Program Files (x86)\\qemu\\qemu-system-x86_64.exe',
  () => path.join(process.env.LOCALAPPDATA || '', 'Programs', 'qemu', 'qemu-system-x86_64.exe'),
];

class Provisioner {
  constructor(appRoot) {
    const opts = appRoot && typeof appRoot === 'object' ? appRoot : {};
    this.appRoot = opts.appRoot || (typeof appRoot === 'string' ? appRoot : process.cwd());
    this.runtimeDir = opts.runtimeDir || '';
    this.avdHome = opts.avdHome || '';
    this.isoPath = opts.isoPath || '';
    this._cache = {};
    this._envCache = null;
    this.sources = new Sources(() => store.getSettings());
  }

  _connections() {
    const n = Number(store.getSettings().runtime.downloadConnections);
    return Math.max(1, Math.min(16, n || 8));
  }

  async _fastDownload(urlOrList, dest, onProgress, label = 'Downloading') {
    const seeds = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
    const expanded = [];
    for (const u of seeds) {
      for (const c of this.sources.candidates(u)) {
        if (!expanded.includes(c)) expanded.push(c);
      }
    }
    const ranked = await this.sources.rank(expanded, (msg) => {
      if (onProgress) onProgress({ stage: 'probe', percent: 0, message: msg });
    });
    return downloadMulti(ranked, dest, {
      connections: this._connections(),
      onProgress: (p) => onProgress && onProgress({
        ...p,
        stage: 'download',
        message: `${label}... ${p.percent != null ? `${p.percent}%` : ''}${p.sources > 1 ? ` (${p.sources} mirrors · ${p.connections || 1} threads)` : p.connections ? ` (${p.connections} threads)` : ''}`,
      }),
    });
  }

  bundledRoot() {
    const cands = [
      process.env.APKSTART_BUNDLED_RUNTIME,
      process.resourcesPath && path.join(process.resourcesPath, 'runtime'),
      this.appRoot && path.join(this.appRoot, 'engine'),
    ].filter(Boolean);
    for (const dir of cands) {
      if (fs.existsSync(path.join(dir, 'emulator', 'emulator.exe'))) return dir;
    }
    return null;
  }

  get root() {
    const custom = this.runtimeDir || store.getSettings().runtime.dir;
    if (custom) return custom;
    const bundled = this.bundledRoot();
    if (bundled) return bundled;
    return path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const r = this.root;
    const bundled = this.bundledRoot();
    const isBundled = bundled && path.resolve(r) === path.resolve(bundled);
    const configuredRoot = this.runtimeDir || String(store.getSettings().runtime.dir || '').trim();
    const dataRoot = configuredRoot || store.DATA_DIR;
    const customAvd = this.avdHome || String(store.getSettings().runtime.avdDir || '').trim();
    const avdHome = customAvd || (isBundled ? path.join(dataRoot, 'avd') : path.join(r, 'avd'));
    const legacySysImgRoot = path.join(store.DATA_DIR, 'system-images');
    const sysImgRoot = isBundled
      ? path.join(dataRoot, 'system-images')
      : (fs.existsSync(path.join(r, 'system-images'))
        ? path.join(r, 'system-images')
        : (fs.existsSync(legacySysImgRoot)
          ? legacySysImgRoot
          : path.join(r, 'system-images')));
    return {
      root: r,
      bundled: isBundled ? bundled : null,
      dlDir: path.join(isBundled ? dataRoot : r, '_dl'),
      adbDir: path.join(r, 'platform-tools'),
      adbExe: path.join(r, 'platform-tools', 'adb.exe'),
      emulatorDir: path.join(r, 'emulator'),
      emulatorExe: path.join(r, 'emulator', 'emulator.exe'),
      emulatorCheck: path.join(r, 'emulator', 'emulator-check.exe'),
      sysImgRoot,
      sysImgDir: this.findSystemImageDir(sysImgRoot) || (isBundled ? this.findSystemImageDir(path.join(r, 'system-images')) : null),
      avdHome,
      aehdDir: path.join(isBundled ? dataRoot : r, 'aehd'),
      qemuDir: path.join(r, 'qemu'),
      qemuExe: path.join(r, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(r, 'qemu', 'qemu-img.exe'),
      imagesDir: path.join(isBundled ? dataRoot : r, 'images'),
      isoFile: this.isoPath || path.join(isBundled ? dataRoot : r, 'images', 'android-x86_64.iso'),
      diskFile: path.join(isBundled ? dataRoot : r, 'images', 'userdata.qcow2'),
    };
  }

  /**
   * Stream-decompress any `.img.xz` / `.img.gz` system images into `sysImgRoot`
   * on first launch using `.part` staging + atomic rename.
   */
  async materializeImages(onProgress) {
    const p = this.paths();
    const roots = [
      p.bundled && path.join(p.bundled, 'system-images'),
      path.join(p.root, 'system-images'),
      p.sysImgRoot,
    ].filter((x, i, a) => x && a.indexOf(x) === i && fs.existsSync(x));
    if (!roots.length) return 0;

    const findPy = () => {
      const { spawnSync } = require('child_process');
      for (const cmd of ['python', 'python3', 'py']) {
        try {
          const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
            encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
          });
          if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
        } catch (_) { /* ignore */ }
      }
      return null;
    };

    const decompressTo = async (src, part, isXz) => {
      if (!isXz) {
        await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(part));
        return;
      }
      let napiErr = null;
      try {
        const lzma = require('@napi-rs/lzma');
        await pipeline(fs.createReadStream(src), lzma.createDecompressStream(), fs.createWriteStream(part));
        return;
      } catch (e) {
        napiErr = e;
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      }
      const py = findPy();
      if (py) {
        const { spawn: sp } = require('child_process');
        await new Promise((resolve, reject) => {
          const c = sp(py, ['-c',
            'import lzma,sys,shutil;'
            + 'f=lzma.open(sys.argv[1],"rb");'
            + 'o=open(sys.argv[2],"wb");'
            + 'shutil.copyfileobj(f,o,1048576);'
            + 'o.close();f.close()',
            src, part,
          ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
          let err = '';
          c.stderr.on('data', (d) => { err += String(d); });
          c.on('error', reject);
          c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `python exit ${code}`))));
        });
        return;
      }
      throw napiErr || new Error('Unable to decompress .xz image (@napi-rs/lzma unavailable and Python was not found)');
    };

    const MIN_EXPANDED = { 'system.img': 32 * 1024 * 1024 };
    let unpacked = 0;
    for (const srcRoot of roots) {
      for (const api of fs.readdirSync(srcRoot)) {
        const apiDir = path.join(srcRoot, api);
        if (!fs.statSync(apiDir).isDirectory()) continue;
        for (const tag of fs.readdirSync(apiDir)) {
          const tagDir = path.join(apiDir, tag);
          if (!fs.statSync(tagDir).isDirectory()) continue;
          for (const abi of fs.readdirSync(tagDir)) {
            const from = path.join(tagDir, abi);
            if (!fs.statSync(from).isDirectory()) continue;
            const to = path.join(p.sysImgRoot, api, tag, abi);
            const sameDir = path.resolve(from) === path.resolve(to);
            fs.mkdirSync(to, { recursive: true });
            for (const f of fs.readdirSync(from)) {
              const src = path.join(from, f);
              if (!fs.statSync(src).isFile()) continue;
              const cm = /^(.+\.img)\.(gz|xz)$/i.exec(f);
              if (cm) {
                const rawName = cm[1];
                const isXz = cm[2].toLowerCase() === 'xz';
                const dest = path.join(to, rawName);
                const minOk = MIN_EXPANDED[rawName.toLowerCase()] || 1024;
                if (fs.existsSync(dest) && fs.statSync(dest).size >= minOk) continue;
                if (onProgress) {
                  onProgress({
                    stage: 'extract',
                    percent: 30,
                    message: `First-run setup: unpacking Android image (${rawName}, ~1-2 min)...`,
                  });
                }
                const part = `${dest}.part`;
                try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
                try {
                  // eslint-disable-next-line no-await-in-loop
                  await decompressTo(src, part, isXz);
                  const sz = fs.existsSync(part) ? fs.statSync(part).size : 0;
                  if (sz < minOk) throw new Error(`Unpacked image is unexpectedly small (${sz} bytes)`);
                  fs.renameSync(part, dest);
                } catch (e) {
                  try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
                  try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
                  const err = new Error(`Failed to unpack system image ${f}: ${e.message}`);
                  err.code = 'MATERIALIZE_FAILED';
                  throw err;
                }
                if (sameDir) {
                  try { fs.rmSync(src, { force: true }); } catch (_) { /* ignore */ }
                }
                unpacked += 1;
              } else if (!sameDir) {
                const dest = path.join(to, f);
                if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
              }
            }
          }
        }
      }
    }
    return unpacked;
  }

  findSystemImageDir(sysImgRoot) {
    if (!fs.existsSync(sysImgRoot)) return null;
    const found = [];
    for (const api of fs.readdirSync(sysImgRoot)) {
      const apiDir = path.join(sysImgRoot, api);
      if (!fs.statSync(apiDir).isDirectory()) continue;
      for (const tag of fs.readdirSync(apiDir)) {
        const tagDir = path.join(apiDir, tag);
        if (!fs.statSync(tagDir).isDirectory()) continue;
        for (const abi of fs.readdirSync(tagDir)) {
          if (!/^x86_64/i.test(abi)) continue;
          const leaf = path.join(tagDir, abi);
          const hasKernel = fs.existsSync(path.join(leaf, 'kernel-ranchu'))
            || fs.existsSync(path.join(leaf, 'kernel-ranchu-64'));
          const hasSys = ['system.img', 'system.img.gz', 'system.img.xz']
            .some((n) => fs.existsSync(path.join(leaf, n)));
          if (hasKernel && hasSys) {
            const apiNum = Number((/\d+/.exec(api) || [0])[0]);
            found.push({ leaf, tag, apiNum });
          }
        }
      }
    }
    if (!found.length) return null;
    const rank = (x) => (x.tag === 'google_apis_playstore' ? 1000 : x.tag === 'google_apis' ? 500 : 100) + x.apiNum;
    found.sort((a, b) => rank(b) - rank(a));
    return found[0].leaf;
  }

  playImageInfo() {
    const leaf = path.join(this.paths().sysImgRoot, 'android-34', 'google_apis_playstore', 'x86_64');
    const sysPlain = path.join(leaf, 'system.img');
    const sysGz = path.join(leaf, 'system.img.gz');
    const sysXz = path.join(leaf, 'system.img.xz');
    const hasKernel = fs.existsSync(path.join(leaf, 'kernel-ranchu'))
      || fs.existsSync(path.join(leaf, 'kernel-ranchu-64'));
    let ok = false;
    let size = 0;
    if (hasKernel && fs.existsSync(sysPlain)) {
      size = fs.statSync(sysPlain).size;
      ok = size > 300 * 1024 * 1024;
    } else if (hasKernel && (fs.existsSync(sysXz) || fs.existsSync(sysGz))) {
      const f = fs.existsSync(sysXz) ? sysXz : sysGz;
      size = fs.statSync(f).size;
      ok = size > 100 * 1024 * 1024;
    }
    return { ok, path: ok ? leaf : null, size, api: '34', tag: 'google_apis_playstore' };
  }

  findEmulator() {
    const p = this.paths();
    if (fs.existsSync(p.emulatorExe)) return p.emulatorExe;
    const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
      || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
    const cand = sdk && path.join(sdk, 'emulator', 'emulator.exe');
    if (cand && fs.existsSync(cand)) return cand;
    return null;
  }

  async emulatorAccel() {
    const p = this.paths();
    const bin = fs.existsSync(p.emulatorCheck) ? p.emulatorCheck : null;
    if (!bin) return { ok: false, driver: 'none', note: 'Emulator acceleration checker not installed yet' };
    const r = await execOut(bin, ['accel'], 8000);
    const text = `${r.stdout}\n${r.stderr}`;
    const ok = /is installed and usable|WHPX.*usable|AEHD.*usable|HAXM.*usable/i.test(text);
    const driver = (/((?:WHPX|AEHD|GVM|HAXM)[^\r\n]*)/i.exec(text) || [])[1] || '';
    return { ok, driver: driver.trim(), note: text.replace(/accel:\s*\d+\s*/g, '').trim() };
  }

  findQemu() {
    const root = this.root;
    for (const fn of QEMU_SEARCH) {
      try {
        const p = fn(root);
        if (p && fs.existsSync(p)) return p;
      } catch (_) { /* ignore */ }
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const full = path.join(dir, 'qemu-system-x86_64.exe');
      if (fs.existsSync(full)) return full;
    }
    return null;
  }

  findQemuImg() {
    const q = this.findQemu();
    if (!q) return null;
    const cand = path.join(path.dirname(q), 'qemu-img.exe');
    return fs.existsSync(cand) ? cand : null;
  }

  findAdb() {
    const p = this.paths();
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    return findAdb('');
  }

  async hypervisor() {
    if (this._cache.hv) return this._cache.hv;
    const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const hasDll = fs.existsSync(path.join(sys32, 'WinHvPlatform.dll'));
    if (!hasDll || process.platform !== 'win32') {
      return (this._cache.hv = { whpx: false, dll: false, note: 'WinHvPlatform.dll is not available on this Windows version' });
    }
    const r = await execOut('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent',
    ], 8000);
    const active = /true/i.test(r.stdout);
    this._cache.hv = {
      whpx: active,
      dll: true,
      note: active
        ? 'Windows Hypervisor Platform (WHPX) is active'
        : 'WHPX is not active (enable "Virtual Machine Platform" in Windows Features for hardware acceleration; software emulation works without it)',
    };
    return this._cache.hv;
  }

  inspectIso(file) {
    if (!file || !fs.existsSync(file)) return { ok: false, size: 0, reason: 'File not found' };
    const size = fs.statSync(file).size;
    if (size < SOURCES.isoMinBytes) {
      return {
        ok: false,
        size,
        reason: `Incomplete download (${(size / 1048576).toFixed(1)} MB < 400 MB); click Download again to resume.`,
      };
    }
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const sig = Buffer.alloc(5);
      fs.readSync(fd, sig, 0, 5, 0x8001);
      if (sig.toString('latin1') === 'CD001') {
        return { ok: true, size, format: 'iso9660', iso9660: true };
      }
      const mbr = Buffer.alloc(2);
      fs.readSync(fd, mbr, 0, 2, 510);
      if (mbr[0] === 0x55 && mbr[1] === 0xaa) {
        return { ok: true, size, format: 'raw-mbr', iso9660: false };
      }
      return { ok: false, size, reason: 'Invalid image header (missing ISO9660 CD001 / MBR boot signature)' };
    } catch (e) {
      return { ok: false, size, reason: e.message };
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
  }

  inspectImage(file) {
    if (!file || !fs.existsSync(file)) return { ok: false, size: 0 };
    const size = fs.statSync(file).size;
    if (size < 64 * 1024) return { ok: false, size, reason: 'File is too small' };
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      const qcow2 = head[0] === 0x51 && head[1] === 0x46 && head[2] === 0x49 && head[3] === 0xfb;
      return { ok: true, size, format: qcow2 ? 'qcow2' : 'raw' };
    } catch (_) {
      return { ok: size > 0, size };
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
  }

  invalidateEnvCache() {
    this._envCache = null;
    this._cache = {};
  }

  async status() { return this.checkEnv(); }

  async deploy({ onProgress, signal } = {}) {
    const report = (message, stage = 'setup') => {
      if (onProgress) onProgress({ stage, message, label: message });
    };
    const checkAbort = () => {
      if (signal && signal.aborted) throw new Error('Runtime setup was cancelled.');
    };
    checkAbort();
    let env = await this.checkEnv({ fresh: true });
    if (env.adb.ok && env.emulator.ok && env.sysimg.ok) return env;

    if (store.getSettings().runtime.preferGithubRuntime !== false) {
      report('Checking for a pre-assembled offline runtime bundle...');
      try {
        await this.installRuntimePack((progress) => onProgress && onProgress(progress));
        env = await this.checkEnv({ fresh: true });
      } catch (error) {
        report(`Runtime bundle unavailable (${error.message}); continuing with official SDK packages.`, 'fallback');
      }
    }

    checkAbort();
    env = await this.checkEnv({ fresh: true });
    if (!env.adb.ok) {
      report('Installing Android platform-tools...');
      await this.installAdb(onProgress);
    }
    checkAbort();
    env = await this.checkEnv({ fresh: true });
    if (!env.emulator.ok) {
      report('Installing the Android Emulator engine...');
      await this.installEmulator(onProgress);
    }
    checkAbort();
    env = await this.checkEnv({ fresh: true });
    if (!env.sysimg.ok) {
      report('Installing the Android system image...');
      await this.installSystemImage(onProgress);
    }
    await this.materializeImages(onProgress);
    this.invalidateEnvCache();
    env = await this.checkEnv({ fresh: true });
    if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
      throw new Error('Runtime deployment completed, but one or more components failed validation.');
    }
    return env;
  }

  reset() {
    const p = this.paths();
    const root = path.resolve(p.root);
    const bundled = p.bundled && path.resolve(p.bundled) === root;
    if (bundled) throw new Error('The bundled runtime is read-only and cannot be reset.');
    const targets = [
      path.join(root, 'platform-tools'),
      path.join(root, 'emulator'),
      path.join(root, 'qemu'),
      path.join(root, 'aehd'),
      path.join(root, '_dl'),
      path.join(root, 'system-images'),
    ];
    if (path.resolve(p.sysImgRoot) !== path.resolve(root, 'system-images')) targets.push(p.sysImgRoot);
    for (const target of targets) {
      const resolved = path.resolve(target);
      if (resolved === root || !resolved.startsWith(root + path.sep)
          && path.resolve(target) !== path.resolve(p.sysImgRoot)) continue;
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    store.saveSettings({ runtime: { installed: false } });
    this.invalidateEnvCache();
    return { ok: true };
  }

  importLocalIso(srcFile, onProgress) {
    if (onProgress) onProgress({ stage: 'import', message: 'Validating the selected system image...' });
    return this.importIso(srcFile);
  }

  async checkEnv({ fresh = false } = {}) {
    if (!fresh && this._envCache && Date.now() - this._envCache.at < 8000) {
      return this._envCache.val;
    }
    const val = await this._checkEnvUncached();
    this._envCache = { at: Date.now(), val };
    return val;
  }

  async _checkEnvUncached() {
    const p = this.paths();
    const s = store.getSettings();
    const adb = this.findAdb();
    const emu = this.findEmulator();
    const qemu = this.findQemu();
    const isoPath = s.runtime.isoPath || p.isoFile;
    const diskPath = s.runtime.diskPath || p.diskFile;

    let qemuVer = '';
    if (qemu) {
      const r = await execOut(qemu, ['--version'], 6000);
      qemuVer = (r.stdout.split(/\r?\n/)[0] || '').trim();
    }
    let adbVer = '';
    if (adb) {
      const r = await execOut(adb, ['version'], 6000);
      adbVer = (r.stdout.split(/\r?\n/)[0] || '').trim();
    }
    let emuVer = '';
    if (emu) {
      const r = await execOut(emu, ['-version'], 8000);
      emuVer = (r.stdout.split(/\r?\n/)[0] || '').trim();
    }

    const sysDir = p.sysImgDir;
    let sysMeta = null;
    if (sysDir) {
      const rel = path.relative(p.sysImgRoot, sysDir).split(path.sep);
      const sysCandidates = ['system.img', 'system.img.xz', 'system.img.gz']
        .map((n) => path.join(sysDir, n))
        .filter((f) => fs.existsSync(f));
      const sysSize = sysCandidates.length ? fs.statSync(sysCandidates[0]).size : 0;
      sysMeta = {
        api: (rel[0] || '').replace(/^android-/, ''),
        tag: rel[1] || '',
        abi: rel[2] || 'x86_64',
        size: sysSize,
      };
    }

    const [hv, accel] = await Promise.all([
      this.hypervisor(),
      emu ? this.emulatorAccel() : Promise.resolve({ ok: false, driver: 'none', note: '' }),
    ]);

    const iso = this.inspectIso(isoPath);
    const disk = this.inspectImage(diskPath);

    const emuReady = Boolean(adb && emu && sysDir);
    const qemuReady = Boolean(adb && qemu && disk.ok && s.runtime.installed);

    return {
      root: p.root,
      bundled: Boolean(p.bundled),
      adb: { ok: Boolean(adb), path: adb, version: adbVer },
      emulator: { ok: Boolean(emu), path: emu, version: emuVer },
      sysimg: { ok: Boolean(sysDir), path: sysDir, ...(sysMeta || {}) },
      playImage: this.playImageInfo(),
      accel,
      qemu: { ok: Boolean(qemu), path: qemu, version: qemuVer },
      hypervisor: hv,
      iso: { ...iso, path: iso.ok ? isoPath : null, targetPath: isoPath },
      disk: { ...disk, path: disk.ok ? diskPath : null, targetPath: diskPath },
      installed: Boolean(s.runtime.installed),
      ready: emuReady || qemuReady,
      needsSetup: emuReady || qemuReady
        ? null
        : (!adb ? 'adb' : (!emu ? 'emulator' : 'sysimg')),
    };
  }

  /**
   * Stream-extract a ZIP archive into `destDir` with strict Zip-Slip boundary checks.
   */
  async extractZip(zipPath, destDir, onProgress) {
    const destAbs = path.resolve(destDir);
    fs.mkdirSync(destAbs, { recursive: true });
    const zip = new ZipFile(zipPath);
    try {
      const entries = zip.list().filter((e) => !e.name.endsWith('/'));
      let done = 0;
      for (const e of entries) {
        const rel = e.name.replace(/^\/+/, '').replace(/\\/g, '/');
        const out = path.resolve(destAbs, rel);
        if (out !== destAbs && !out.startsWith(destAbs + path.sep)) continue;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        await zip.pipeTo(e.name, fs.createWriteStream(out));
        done++;
        if (onProgress && (done % 25 === 0 || done === entries.length)) {
          onProgress({
            stage: 'extract',
            percent: Math.round((done / entries.length) * 100),
            message: `Extracting (${done}/${entries.length})...`,
          });
        }
      }
    } finally {
      zip.close();
    }
  }

  async resolveEmulatorUrl() {
    const custom = store.getSettings().runtime.emulatorUrl;
    if (custom) return custom;
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await fetchText(SOURCES.sdkIndex);
      const blocks = xml.match(/<remotePackage[^>]*path="emulator"[\s\S]*?<\/remotePackage>/g) || [];
      const urls = [];
      for (const b of blocks) {
        if (/channelRef[^>]*ref="channel-[123]"/.test(b)) continue;
        const archives = b.match(/<archive>[\s\S]*?<\/archive>/g) || [];
        for (const a of archives) {
          if (!/<host-os>windows<\/host-os>/.test(a)) continue;
          if (/<host-arch>aarch64<\/host-arch>/.test(a)) continue;
          const u = (/<url>([^<]+\.zip)<\/url>/.exec(a) || [])[1];
          if (u) urls.push(absUrl(u, baseOf(SOURCES.sdkIndex)));
        }
      }
      if (urls.length) return (this._cache.emulatorUrl = urls[urls.length - 1]);
    } catch (_) { /* Fall back to pinned URL */ }
    return SOURCES.emulatorFallback;
  }

  async resolveSysimgUrl() {
    const custom = store.getSettings().runtime.sysimgUrl;
    if (custom) return custom;
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const play = await this.resolvePlaySysimgUrl();
    return (this._cache.sysimgUrl = play);
  }

  async resolvePlaySysimgUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await fetchText(SOURCES.playSysImgIndex);
      const pkgs = xml.match(/<remotePackage[^>]*path="system-images;android-(\d+);google_apis_playstore;x86_64"[\s\S]*?<\/remotePackage>/g) || [];
      const cands = [];
      for (const b of pkgs) {
        const api = Number((/android-(\d+)/.exec(b) || [])[1]);
        if (api < 33 || api > 35) continue;
        const u = (/<url>([^<]+\.zip)<\/url>/.exec(b) || [])[1];
        if (u) cands.push({ api, url: absUrl(u, baseOf(SOURCES.playSysImgIndex)) });
      }
      cands.sort((a, b) => (b.api === 34) - (a.api === 34) || b.api - a.api);
      if (cands.length) return (this._cache.playUrl = cands[0].url);
    } catch (_) { /* Fall back to pinned URL */ }
    return SOURCES.playSysImgFallback.url;
  }

  async installPlayImage(onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    const url = await this.resolvePlaySysimgUrl();
    const zipPath = path.join(p.dlDir, path.basename(new URL(url).pathname));
    await this._fastDownload(url, zipPath, onProgress, 'Downloading Android 14 universal image');

    const tmp = path.join(p.dlDir, '_play_unpack');
    fs.rmSync(tmp, { recursive: true, force: true });
    await this.extractZip(zipPath, tmp, onProgress);

    let top = fs.readdirSync(tmp).find((d) => fs.statSync(path.join(tmp, d)).isDirectory()) || 'x86_64';
    const src = fs.existsSync(path.join(tmp, top, 'system.img')) ? path.join(tmp, top) : tmp;
    const dest = path.join(p.sysImgRoot, 'android-34', 'google_apis_playstore', 'x86_64');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.unlinkSync(zipPath); } catch (_) { /* ignore */ }
    store.saveSettings({ runtime: { compatImage: true } });
    return this.playImageInfo();
  }

  async resolveAehdUrl() {
    try {
      const xml = await fetchText(SOURCES.addonIndex);
      const m = /<remotePackage[^>]*path="extras;google;(?:auto|Android_Emulator_Hypervisor_Driver)"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (m) {
        const u = (/<url>([^<]+\.zip)<\/url>/.exec(m[0]) || [])[1];
        if (u) return absUrl(u, baseOf(SOURCES.addonIndex));
      }
    } catch (_) { /* ignore */ }
    return SOURCES.aehdFallback;
  }

  async installEmulator(onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    const url = await this.resolveEmulatorUrl();
    const zipPath = path.join(p.dlDir, path.basename(new URL(url).pathname));
    await this._fastDownload(url, zipPath, onProgress, 'Downloading Android Emulator engine');
    if (fs.existsSync(p.emulatorDir)) fs.rmSync(p.emulatorDir, { recursive: true, force: true });
    await this.extractZip(zipPath, p.root, onProgress);
    if (!fs.existsSync(p.emulatorExe)) {
      throw new Error('emulator.exe not found after extraction; archive layout may have changed.');
    }
    try { fs.unlinkSync(zipPath); } catch (_) { /* ignore */ }
    return { path: p.emulatorExe };
  }

  async installSystemImage(onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    const url = await this.resolveSysimgUrl();
    const zipPath = path.join(p.dlDir, path.basename(new URL(url).pathname));
    await this._fastDownload(url, zipPath, onProgress, 'Downloading Android 14 system image');

    const apiMatch = /x86_64-(\d+)_/.exec(path.basename(zipPath));
    const api = apiMatch ? apiMatch[1] : '34';
    const tag = /google_apis_playstore/.test(url)
      ? 'google_apis_playstore'
      : (/google_apis/.test(url) ? 'google_apis' : 'default');

    const tmp = path.join(p.dlDir, '_sysimg_unpack');
    fs.rmSync(tmp, { recursive: true, force: true });
    await this.extractZip(zipPath, tmp, onProgress);

    let top = fs.readdirSync(tmp).find((d) => fs.statSync(path.join(tmp, d)).isDirectory()) || 'x86_64';
    const src = fs.existsSync(path.join(tmp, top, 'system.img')) ? path.join(tmp, top) : tmp;
    const dest = path.join(p.sysImgRoot, `android-${api}`, tag, 'x86_64');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.unlinkSync(zipPath); } catch (_) { /* ignore */ }
    return { path: dest, api, tag };
  }

  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { name: path.basename(custom.split('?')[0]) || 'ApkStart-runtime.zip', url: custom, urls: [custom] };
    if (this._cache.pack) return this._cache.pack;

    const merged = await this.sources.latest().catch(() => null);
    if (merged && Array.isArray(merged.assets)) {
      const hit = merged.assets.find((a) => /^ApkStart-runtime-.*\.zip$/i.test(a.name));
      if (hit) {
        return (this._cache.pack = { ...hit, tag: merged.tag });
      }
    }
    const { REPOS } = require('./sources');
    const https = require('https');
    const listText = await new Promise((resolve, reject) => {
      const req = https.get(REPOS.github.api, {
        headers: { 'User-Agent': 'ApkStart/0.4', Accept: 'application/vnd.github+json' },
        timeout: 8000,
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub ${res.statusCode}`)); }
        let d = ''; res.setEncoding('utf8');
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('timeout')));
    });
    const rels = JSON.parse(listText);
    for (const r of Array.isArray(rels) ? rels : []) {
      if (!r || r.draft) continue;
      const a = (r.assets || []).find((x) => /^ApkStart-runtime-.*\.zip$/i.test(x && x.name));
      if (a && a.browser_download_url) {
        return (this._cache.pack = {
          name: a.name,
          size: Number(a.size) || 0,
          url: a.browser_download_url,
          urls: [a.browser_download_url],
          tag: r.tag_name,
        });
      }
    }
    return null;
  }

  async installRuntimePack(onProgress) {
    this.invalidateEnvCache();
    const pack = await this.resolveRuntimePack();
    if (!pack) throw new Error('No pre-assembled runtime pack found in GitHub/Gitee releases');

    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    const zipPath = path.join(p.dlDir, path.basename(pack.name || 'ApkStart-runtime.zip'));

    if ((pack.urls && pack.urls.length) || pack.url) {
      const seeds = [...(pack.urls || []), pack.url].filter(Boolean);
      await this._fastDownload(seeds, zipPath, onProgress, 'Downloading runtime bundle from GitHub');
    } else if (pack.parts && pack.parts.length) {
      const { Updater } = require('./updater');
      const helper = new Updater({
        currentVersion: '0.0.0', exePath: process.execPath, isPackaged: true,
        dataDir: p.dlDir, settings: () => store.getSettings(), onProgress,
      });
      await helper._downloadParts(pack, zipPath, this._connections(), pack.size || 0);
    } else {
      throw new Error('Runtime pack has no valid download URLs');
    }

    const tmp = path.join(p.dlDir, '_rtpack_unpack');
    fs.rmSync(tmp, { recursive: true, force: true });
    await this.extractZip(zipPath, tmp, onProgress);

    let src = tmp;
    if (!fs.existsSync(path.join(src, 'emulator')) && !fs.existsSync(path.join(src, 'system-images'))) {
      const sub = fs.readdirSync(tmp).find((d) => fs.statSync(path.join(tmp, d)).isDirectory());
      if (sub) src = path.join(tmp, sub);
    }
    fs.mkdirSync(p.root, { recursive: true });
    for (const name of ['platform-tools', 'emulator', 'system-images']) {
      const from = path.join(src, name);
      if (!fs.existsSync(from)) continue;
      const to = name === 'system-images' ? p.sysImgRoot : path.join(p.root, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try { fs.unlinkSync(zipPath); } catch (_) { /* ignore */ }

    await this.materializeImages(onProgress);
    this.invalidateEnvCache();
    const after = await this.checkEnv({ fresh: true });
    if (!after.emulator.ok || !after.sysimg.ok) {
      throw new Error('Runtime bundle extracted, but emulator or system image failed validation');
    }
    return { ok: true, tag: pack.tag, emulator: after.emulator.path, sysimg: after.sysimg.path };
  }

  async installAehd(onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    const url = await this.resolveAehdUrl();
    const zipPath = path.join(p.dlDir, 'aehd-windows.zip');
    await this._fastDownload(url, zipPath, onProgress, 'Downloading AEHD hypervisor driver');
    fs.rmSync(p.aehdDir, { recursive: true, force: true });
    await this.extractZip(zipPath, p.aehdDir, onProgress);
    const sub = fs.readdirSync(p.aehdDir).find((f) => fs.existsSync(path.join(p.aehdDir, f, 'silent_install.bat')));
    const bat = sub
      ? path.join(p.aehdDir, sub, 'silent_install.bat')
      : path.join(p.aehdDir, 'silent_install.bat');
    if (!fs.existsSync(bat)) return { ok: false, error: 'silent_install.bat not found inside AEHD archive' };
    return { ok: true, installer: bat, note: 'Driver downloaded; click "Enable Hardware Acceleration" to authorize installation via UAC.' };
  }

  async probeSources() {
    const [pt, emuUrl, imgUrl, q, iso] = await Promise.all([
      head(SOURCES.platformTools),
      this.resolveEmulatorUrl().then((u) => head(u)),
      this.resolveSysimgUrl().then((u) => head(u)),
      this.resolveQemuUrl().then((u) => head(u)).catch(() => ({ size: 0 })),
      head(SOURCES.androidIsoMirrors[0]),
    ]);
    return {
      adbBytes: pt.size,
      emulatorBytes: emuUrl.size,
      emulatorUrl: emuUrl.finalUrl,
      sysimgBytes: imgUrl.size,
      sysimgUrl: imgUrl.finalUrl,
      qemuBytes: q.size,
      qemuUrl: q.finalUrl,
      isoBytes: iso.size || 960 * 1024 * 1024,
    };
  }

  async resolveQemuUrl() {
    const custom = store.getSettings().runtime.qemuUrl;
    if (custom) return custom;
    try {
      const html = await fetchText(SOURCES.qemuIndex);
      const matches = [...html.matchAll(/href="(qemu-w64-setup-\d{8}\.exe)"/g)].map((m) => m[1]).sort();
      if (matches.length) return SOURCES.qemuIndex + matches[matches.length - 1];
    } catch (_) { /* ignore */ }
    return SOURCES.qemuFallbacks[0];
  }

  async installAdb(onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    const zipPath = path.join(p.dlDir, 'platform-tools.zip');
    const url = store.getSettings().runtime.adbUrl || SOURCES.platformTools;

    await this._fastDownload(url, zipPath, onProgress, 'Downloading ADB platform-tools');
    await this.extractZip(zipPath, p.root, onProgress);
    if (!fs.existsSync(p.adbExe)) throw new Error('adb.exe not found after extracting platform-tools.zip');
    try { fs.unlinkSync(zipPath); } catch (_) { /* ignore */ }
    return { path: p.adbExe };
  }

  async find7z() {
    const cands = [
      'C:\\Program Files\\7-Zip\\7z.exe',
      'C:\\Program Files (x86)\\7-Zip\\7z.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    const r = await execOut('where', ['7z'], 4000);
    if (r.ok) return r.stdout.split(/\r?\n/)[0].trim();
    return null;
  }

  async installQemu(onProgress) {
    this.invalidateEnvCache();
    const existing = this.findQemu();
    if (existing) return { path: existing, reused: true };

    const p = this.paths();
    fs.mkdirSync(p.dlDir, { recursive: true });
    fs.mkdirSync(p.qemuDir, { recursive: true });

    const url = await this.resolveQemuUrl();
    const setupExe = path.join(p.dlDir, path.basename(url));
    await this._fastDownload(url, setupExe, onProgress, 'Downloading QEMU');

    const emit = (msg, percent = null) => onProgress && onProgress({ stage: 'install', percent, message: msg });

    const seven = await this.find7z();
    if (seven) {
      emit('Extracting QEMU silently via 7-Zip...', 60);
      await execOut(seven, ['x', '-y', `-o${p.qemuDir}`, setupExe], 180000);
      if (fs.existsSync(p.qemuExe)) return { path: p.qemuExe, method: '7z' };
    }

    emit('Running QEMU installer...', 70);
    await new Promise((resolve) => {
      const child = spawn(setupExe, ['/S', `/D=${p.qemuDir}`], { windowsHide: true });
      child.on('exit', () => resolve());
      child.on('error', () => resolve());
      setTimeout(resolve, 180000);
    });
    if (this.findQemu()) return { path: this.findQemu(), method: 'nsis-silent' };

    const wg = await execOut('winget', ['--version'], 4000);
    if (wg.ok) {
      emit('Installing QEMU via winget...', 80);
      await execOut('winget', [
        'install', '--id', 'SoftwareFreedomConservancy.QEMU', '-e',
        '--silent', '--accept-package-agreements', '--accept-source-agreements',
      ], 300000);
      if (this.findQemu()) return { path: this.findQemu(), method: 'winget' };
    }

    emit('Please approve the UAC prompt to complete QEMU installation...', 90);
    await execOut('powershell.exe', [
      '-NoProfile', '-Command',
      `Start-Process -FilePath '${setupExe.replace(/'/g, "''")}' -ArgumentList '/S','/D=${p.qemuDir}' -Verb RunAs -Wait`,
    ], 300000);
    if (this.findQemu()) return { path: this.findQemu(), method: 'nsis-elevated' };

    throw new Error('Automatic QEMU installation did not complete. Run the installer in runtime/_dl manually or install 7-Zip and retry.');
  }

  async downloadIso(onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.imagesDir, { recursive: true });
    const target = store.getSettings().runtime.isoPath || p.isoFile;

    const existing = this.inspectIso(target);
    if (existing.ok) return { path: target, size: existing.size, reused: true };
    if (fs.existsSync(target)) {
      const part = `${target}.part`;
      if (!fs.existsSync(part)) fs.renameSync(target, part);
      else fs.unlinkSync(target);
    }

    const custom = store.getSettings().runtime.isoUrl;
    const mirrors = custom ? [custom, ...SOURCES.androidIsoMirrors] : SOURCES.androidIsoMirrors;

    let lastErr;
    for (const url of mirrors) {
      try {
        await download(url, target, {
          onProgress: (pr) => onProgress && onProgress({ ...pr, stage: 'download', message: 'Downloading Android-x86 ISO...' }),
        });
        const check = this.inspectIso(target);
        if (!check.ok) {
          fs.unlinkSync(target);
          throw new Error(check.reason || 'Downloaded file is not a valid ISO image');
        }
        return { path: target, size: check.size };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`Failed to download Android-x86 ISO: ${lastErr ? lastErr.message : 'All mirrors unreachable'}`);
  }

  async createDisk(sizeGB = 24, onProgress) {
    this.invalidateEnvCache();
    const p = this.paths();
    fs.mkdirSync(p.imagesDir, { recursive: true });
    const disk = store.getSettings().runtime.diskPath || p.diskFile;
    if (fs.existsSync(disk) && fs.statSync(disk).size > 64 * 1024) {
      return { path: disk, reused: true };
    }
    const qimg = this.findQemuImg();
    if (!qimg) throw new Error('qemu-img.exe not found; install QEMU first.');
    if (onProgress) onProgress({ stage: 'disk', percent: 50, message: `Creating ${sizeGB} GB sparse qcow2 virtual disk...` });
    const r = await execOut(qimg, ['create', '-f', 'qcow2', disk, `${Number(sizeGB) || 24}G`], 30000);
    if (!r.ok || !fs.existsSync(disk)) throw new Error(`Virtual disk creation failed: ${r.stderr || r.stdout}`);
    return { path: disk };
  }

  importIso(srcFile) {
    this.invalidateEnvCache();
    const check = this.inspectIso(srcFile);
    if (!check.ok) throw new Error(`Invalid system image: ${check.reason}`);
    store.saveSettings({ runtime: { isoPath: srcFile } });
    return { path: srcFile, size: check.size, format: check.format };
  }

  importDisk(srcFile) {
    this.invalidateEnvCache();
    const check = this.inspectImage(srcFile);
    if (!check.ok) throw new Error(`Invalid virtual disk: ${check.reason || 'file not found'}`);
    store.saveSettings({ runtime: { diskPath: srcFile } });
    return { path: srcFile, size: check.size, format: check.format };
  }
}

module.exports = { Provisioner, SOURCES, absUrl, baseOf };
