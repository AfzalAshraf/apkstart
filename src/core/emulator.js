'use strict';
/**
 * Google Android Emulator (QEMU2 + Ranchu + WHPX/AEHD) zero-configuration manager.
 *
 * Key design guarantees:
 *  - Zero user prompts: dynamically generates `apkstart.ini` + `apkstart.avd/config.ini`
 *    without requiring `avdmanager` or Java;
 *  - Self-adaptive hardware profile (`doctor.autoProfile`) for RAM, vCPUs, GPU, hypervisor,
 *    and `/data` partition size;
 *  - Automatic multi-variant fallback (`doctor.planVariants`) from hardware GPU + WHPX
 *    down to SwiftShader + TCG software emulation with stale lock/snapshot self-healing;
 *  - Quickboot snapshot (`apkstart`) validation (`ram.bin` / `ram.img` + `snapshot.pb` + `snapshot.key`).
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const { Provisioner } = require('./provision');
const { AdbClient, adbEnv } = require('./adb');
const doctor = require('./doctor');
const logfile = require('./logfile');
const { buildEmptyExt4 } = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAP_NAME = 'apkstart';
const PRIORITY_SCRIPT = path.join(__dirname, 'win', 'priority.ps1');
const FAST_DNS_SERVERS = '1.1.1.1,8.8.8.8,223.5.5.5,119.29.29.29';

function iniBlock(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
}

function clearLocks(avdDir) {
  let removed = 0;
  for (const dir of [avdDir, path.dirname(avdDir)]) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.lock$/i.test(f)) {
        try {
          fs.rmSync(path.join(dir, f), { recursive: true, force: true });
          removed++;
        } catch (_) { /* Still held by a live process */ }
      }
    }
  }
  return removed;
}

class EmulatorEngine {
  constructor(appRoot) {
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this.serial = null;
    this.logFile = path.join(store.LOG_DIR, 'emulator.log');
    this._log = [];
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    this.failureFile = path.join(store.DATA_DIR, 'last-boot-failure.json');
    this.onBeforeSpawn = null;
    this._snapTimer = null;
  }

  get settings() { return store.getSettings(); }

  pushLog(line) {
    for (const l of String(line).split(/\r?\n/)) {
      if (!l.trim()) continue;
      this._log.push({ t: Date.now(), line: l });
      if (this._log.length > 600) this._log.shift();
      const limitKB = (this.settings.engine && this.settings.engine.logMaxKB) || 2048;
      logfile.append(this.logFile, `[${new Date().toISOString()}] ${l}`, limitKB);
    }
  }

  tailLog(n = 120) {
    return this._log.slice(-n).map((x) => x.line);
  }

  _attemptLines(sinceIdx, cap = 160) {
    const start = Math.max(0, Number(sinceIdx) || 0);
    const slice = this._log.slice(start).map((x) => x.line);
    if (!slice.length) return this.tailLog(cap);
    return slice.slice(-cap);
  }

  _persistFailure(extra = {}) {
    try {
      const payload = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        logTail: this.tailLog(80),
        ...extra,
      };
      fs.mkdirSync(path.dirname(this.failureFile), { recursive: true });
      fs.writeFileSync(this.failureFile, JSON.stringify(payload, null, 2));
    } catch (_) { /* ignore */ }
  }

  _clearFailure() {
    try { fs.rmSync(this.failureFile, { force: true }); } catch (_) { /* ignore */ }
  }

  lastFailure() {
    try {
      if (!fs.existsSync(this.failureFile)) return null;
      return JSON.parse(fs.readFileSync(this.failureFile, 'utf8'));
    } catch (_) { return null; }
  }

  running() {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  emulatorEnv() {
    const p = this.provisioner.paths();
    fs.mkdirSync(p.avdHome, { recursive: true });
    fs.mkdirSync(p.root, { recursive: true });
    const sdkRoot = doctor.shortPath(p.root);
    const avdHome = doctor.shortPath(p.avdHome);
    return {
      ...adbEnv(),
      ANDROID_SDK_ROOT: sdkRoot,
      ANDROID_HOME: sdkRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
    };
  }

  avdDir() {
    return path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
  }

  clearSnapshots() {
    const dir = path.join(this.avdDir(), 'snapshots');
    if (!fs.existsSync(dir)) return;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return;
    } catch (_) { /* Fall back to rename if partially locked */ }
    try {
      const stale = `${dir}.stale-${Date.now()}`;
      fs.renameSync(dir, stale);
      try { fs.rmSync(stale, { recursive: true, force: true }); } catch (_) { /* Clean on next startup */ }
    } catch (_) { /* ignore */ }
  }

  hasSnapshot() {
    const snap = path.join(this.avdDir(), 'snapshots', SNAP_NAME);
    if (!fs.existsSync(snap)) return false;
    const sizeOf = (f) => {
      try { return fs.statSync(path.join(snap, f)).size; } catch (_) { return 0; }
    };
    const pb = sizeOf('snapshot.pb');
    const ram = Math.max(sizeOf('ram.bin'), sizeOf('ram.img'));
    const valid = pb >= 256 && ram >= 1024 * 1024;
    if (!valid) {
      try { fs.rmSync(snap, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    return valid;
  }

  dataInfo() {
    const avd = this.avdDir();
    const qcow = path.join(avd, 'userdata-qemu.img.qcow2');
    const raw = path.join(avd, 'userdata-qemu.img');
    const cfgFile = path.join(avd, 'config.ini');
    let configuredMB = 0;
    try {
      const m = /^disk\.dataPartition\.size=(\d+)([MG])$/m.exec(fs.readFileSync(cfgFile, 'utf8'));
      if (m) configuredMB = m[2] === 'G' ? Number(m[1]) * 1024 : Number(m[1]);
    } catch (_) { /* ignore */ }
    const sizeOf = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
    const imageBytes = sizeOf(qcow) || sizeOf(raw);
    return {
      configuredMB,
      configuredGB: configuredMB ? +(configuredMB / 1024).toFixed(1) : 0,
      imageBytes,
      imageGB: imageBytes ? +(imageBytes / 1073741824).toFixed(2) : 0,
      avdDir: avd,
    };
  }

  /**
   * Expand `/data` partition capacity in place without wiping installed apps or saves:
   * updates `disk.dataPartition.size` in `config.ini`, discards the qcow2 overlay header,
   * and clears the quickboot RAM snapshot so the next cold boot triggers `resize2fs`.
   */
  resizeDataPartition(newMB) {
    const mb = Math.max(2048, Math.min(64 * 1024, Math.round(Number(newMB) || 0)));
    const avd = this.avdDir();
    const cfgFile = path.join(avd, 'config.ini');
    if (!fs.existsSync(cfgFile)) return { ok: false, reason: 'no-avd' };
    const cur = fs.readFileSync(cfgFile, 'utf8');
    const next = /^disk\.dataPartition\.size=/m.test(cur)
      ? cur.replace(/^disk\.dataPartition\.size=.*$/m, `disk.dataPartition.size=${mb}M`)
      : `${cur.trimEnd()}\ndisk.dataPartition.size=${mb}M\n`;
    fs.writeFileSync(cfgFile, next);
    try { fs.rmSync(path.join(avd, 'userdata-qemu.img.qcow2'), { force: true }); } catch (_) { /* ignore */ }
    this.clearSnapshots();
    return { ok: true, dataMB: mb };
  }

  ensureAvd(variant, meta = {}) {
    const p = this.provisioner.paths();
    // `ensureAvd` writes configuration only; `Runtime.ensure` validates that the
    // selected image exists before attempting a boot. Keep a deterministic default
    // image path here so diagnostics and config-generation tests can run offline.
    const sysDir = p.sysImgDir || meta.sysImgDir || path.join(
      p.sysImgRoot,
      `android-${meta.api || '34'}`,
      meta.tag || 'google_apis_playstore',
      meta.abi || 'x86_64',
    );

    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });

    const sysRel = path.relative(p.root, sysDir).replace(/\\/g, '/') + '/';
    const shortAvd = doctor.shortPath(avdDir);

    const keyFile = path.join(avdDir, 'snapshot.key');
    const nextKey = doctor.snapshotKey(meta, sysDir);
    const prevKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
    if (prevKey && prevKey !== nextKey) {
      this.pushLog(`Runtime/system image changed (${prevKey} -> ${nextKey}); invalidating stale quickboot snapshots`);
      this.clearSnapshots();
    }
    fs.writeFileSync(keyFile, nextKey);

    try { fs.rmSync(path.join(avdDir, 'snapshots', 'default_boot'), { recursive: true, force: true }); } catch (_) { /* ignore */ }

    const rootIni = path.join(home, `${AVD_NAME}.ini`);
    fs.writeFileSync(rootIni, iniBlock({
      'avd.ini.encoding': 'UTF-8',
      path: shortAvd,
      'path.rel': `avd/${AVD_NAME}.avd`,
      target: `android-${meta.api || '30'}`,
    }));

    const isPlay = /playstore/i.test(sysRel);
    const gpuMode = variant.gpu || 'software';
    const lcd = variant.lcd || { w: 720, h: 1280, dpi: 320 };
    const cfg = {
      'AvdId': AVD_NAME,
      'PlayStore.enabled': isPlay ? 'yes' : 'no',
      'abi.type': 'x86_64',
      'avd.ini.displayname': 'ApkStart',
      'avd.ini.encoding': 'UTF-8',
      'disk.dataPartition.size': `${variant.dataMB || 4096}M`,
      'fastboot.chosenSnapshotFile': '',
      'hw.accelerometer': 'yes',
      'hw.arc': 'false',
      'hw.audioInput': 'yes',
      'hw.audioOutput': 'yes',
      'hw.battery': 'yes',
      'hw.camera.back': 'none',
      'hw.camera.front': 'none',
      'hw.cpu.arch': 'x86_64',
      'hw.cpu.ncore': String(variant.cores || 2),
      'hw.dPad': 'no',
      'hw.gps': 'yes',
      'hw.gpu.enabled': 'yes',
      'hw.gpu.mode': gpuMode,
      'hw.initialOrientation': lcd.w > lcd.h ? 'landscape' : 'portrait',
      'hw.keyboard': 'yes',
      'hw.lcd.density': String(lcd.dpi || 320),
      'hw.lcd.width': String(lcd.w),
      'hw.lcd.height': String(lcd.h),
      'hw.mainKeys': 'no',
      'hw.ramSize': String(variant.memoryMB || 2048),
      'hw.sdCard': 'no',
      'hw.sensors.orientation': 'yes',
      'hw.sensors.proximity': 'yes',
      'image.sysdir.1': sysRel,
      'runtime.network.latency': 'none',
      'runtime.network.speed': 'full',
      'sdcard.size': '512M',
      'showDeviceFrame': 'no',
      'skin.dynamic': 'yes',
      'tag.display': isPlay ? 'Google Play' : 'Default',
      'tag.id': isPlay ? 'google_apis_playstore' : 'default',
      'vm.heapSize': '256',
    };
    fs.writeFileSync(path.join(avdDir, 'config.ini'), iniBlock(cfg));

    this._ensureSeedUserdata(avdDir, sysDir);
    return { avdName: AVD_NAME, avdDir, snapshotReset: Boolean(prevKey && prevKey !== nextKey) };
  }

  _ensureSeedUserdata(avdDir, sysDir) {
    const dest = path.join(avdDir, 'userdata.img');
    const qcow = path.join(avdDir, 'userdata-qemu.img.qcow2');
    const qemuRaw = path.join(avdDir, 'userdata-qemu.img');
    const sizeOf = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const isExt4 = (p) => {
      let fd = null;
      try {
        fd = fs.openSync(p, 'r');
        const b = Buffer.alloc(2);
        fs.readSync(fd, b, 0, 2, 1024 + 0x38);
        return b.readUInt16LE(0) === 0xEF53;
      } catch (_) {
        return false;
      } finally {
        if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
      }
    };
    if (sizeOf(qcow) > 1024 * 1024) return;
    if (sizeOf(qemuRaw) >= 32 * 1024 * 1024 && isExt4(qemuRaw)) return;
    if (sizeOf(dest) >= 32 * 1024 * 1024 && isExt4(dest)) return;

    const sysSeed = sysDir ? path.join(sysDir, 'userdata.img') : '';
    try {
      if (sysSeed && sizeOf(sysSeed) >= 32 * 1024 * 1024 && isExt4(sysSeed)) {
        fs.copyFileSync(sysSeed, dest);
        this.pushLog('Copied valid ext4 userdata.img seed from system-images');
      } else {
        fs.writeFileSync(dest, buildEmptyExt4({ sizeMB: 64 }));
        this.pushLog('Generated minimal 64 MB ext4 userdata.img seed (4K blocks + ENCRYPT + ext_attr)');
      }
      for (const stale of [qemuRaw, qcow]) {
        try { fs.rmSync(stale, { force: true }); } catch (_) { /* ignore */ }
      }
    } catch (e) {
      this.pushLog(`Failed to prepare userdata.img seed: ${e.message}`);
    }
  }

  buildArgs(variant = {}) {
    const gpu = variant.gpu || 'software';
    const accel = variant.accel || 'auto';
    const args = [
      '-avd', AVD_NAME,
      '-port', '5554',
      '-gpu', gpu,
      '-accel', accel,
      '-no-boot-anim',
      '-no-metrics',
    ];
    if (this.settings.engine?.audio === false) args.push('-no-audio');
    if (this.settings.engine?.fastDns !== false) {
      args.push('-dns-server', FAST_DNS_SERVERS);
    }
    if (variant.memoryMB) args.push('-memory', String(variant.memoryMB));
    if (variant.cores) args.push('-cores', String(variant.cores));

    if (variant.headless) {
      args.push('-no-window');
    } else {
      const lcd = variant.lcd || { w: 720, h: 1280 };
      args.push('-skin', `${lcd.w}x${lcd.h}`);
    }

    const keepSnap = this.settings.engine?.keepSnapshot !== false;
    if (variant.wipe) {
      args.push('-wipe-data', '-no-snapshot-load');
      if (keepSnap) args.push('-snapshot', SNAP_NAME);
      else args.push('-no-snapshot-save');
    } else if (!keepSnap) {
      args.push('-no-snapshot');
    } else if (variant.snapshot === false) {
      args.push('-no-snapshot');
    } else if (!this.hasSnapshot()) {
      args.push('-snapshot', SNAP_NAME, '-no-snapshot-load');
    } else {
      args.push('-snapshot', SNAP_NAME);
    }
    return args;
  }

  /**
   * Schedule an explicit quickboot snapshot save once Android has settled.
   * Checks free space on `avdHome` (not `DATA_DIR`) and works even when detached
   * `qemu-system-x86_64.exe` outlives `emulator.exe` or on adopted sessions.
   */
  scheduleSnapshotSave(adbPath, { delayMs = 20000, onLog } = {}) {
    if (this.settings.engine?.keepSnapshot === false) return;
    if (this.hasSnapshot()) return;
    if (this._snapTimer) return;
    const freeMB = doctor.freeDiskMB(this.provisioner.paths().avdHome);
    if (freeMB && freeMB < 4096) {
      this.pushLog(`Skipping quickboot snapshot save: only ${freeMB} MB free on AVD volume (need >= 4 GB)`);
      return;
    }
    this._snapTimer = setTimeout(async () => {
      this._snapTimer = null;
      const serial = this.serial || 'emulator-5554';
      const client = new AdbClient({ adbPath, serial });
      const alive = this.running() || (await client.isOnline().catch(() => false));
      if (!alive || this.hasSnapshot()) return;
      const log = (m) => { this.pushLog(m); if (onLog) onLog(m); };
      log('Saving quickboot snapshot for instant future launches...');
      const ok = await this._saveViaAdb(adbPath, serial);
      log(ok ? 'Quickboot snapshot saved' : 'Quickboot snapshot save skipped; will save on graceful shutdown');
    }, delayMs);
    if (this._snapTimer.unref) this._snapTimer.unref();
  }

  _saveViaAdb(adbPath, serialOverride) {
    const targetSerial = serialOverride || this.serial || 'emulator-5554';
    return new Promise((resolve) => {
      if (!adbPath || !fs.existsSync(adbPath)) { resolve(false); return; }
      execFile(adbPath, ['-s', targetSerial, 'emu', 'avd', 'snapshot', 'save', SNAP_NAME],
        { timeout: 120000, windowsHide: true, env: adbEnv() },
        (err, stdout) => {
          const ok = !err && /OK/i.test(String(stdout)) && this.hasSnapshot();
          resolve(ok);
        });
    });
  }

  async checkNetwork(adbPath) {
    const c = new AdbClient({ adbPath, serial: this.serial || 'emulator-5554' });
    if (!(await c.isOnline())) return { ok: false, reason: 'offline' };
    try {
      const out = await c.shell(
        'ip -4 addr show wlan0 2>/dev/null; echo ---ROUTE---; ip route 2>/dev/null',
        { timeout: 6000 },
      );
      const ip = (/inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(out) || [])[1] || '';
      const def = /---ROUTE---[\s\S]*default\s+via\s+(\d+\.\d+\.\d+\.\d+)/.exec(out);
      return { ok: Boolean(ip && def), ip, gw: def ? def[1] : '', raw: out.slice(0, 400) };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  async waitForNetwork(adbPath, { timeoutMs = 45000, onLog } = {}) {
    const log = (m) => { this.pushLog(m); if (onLog) onLog(m); };
    const c = new AdbClient({ adbPath, serial: this.serial || 'emulator-5554' });
    const deadline = Date.now() + timeoutMs;
    let nudged = false;
    while (Date.now() < deadline) {
      const st = await this.checkNetwork(adbPath);
      if (st.ok) return st;
      if (!nudged) {
        nudged = true;
        log('Waiting for guest virtual Wi-Fi (AndroidWifi)...');
        await c.shell('svc wifi enable; cmd wifi set-wifi-enabled enabled 2>/dev/null || true', { timeout: 6000 }).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return this.checkNetwork(adbPath);
  }

  async bootOnce(variant, { adbPath, onLog, envMeta }) {
    const log = (m) => { this.pushLog(m); if (onLog) onLog(m); };
    const p = this.provisioner.paths();

    await this.provisioner.materializeImages((pr) => {
      if (pr && pr.message) log(pr.message);
    });

    const avd = this.ensureAvd(variant, envMeta);
    clearLocks(avd.avdDir);

    const args = this.buildArgs(variant);
    const env = this.emulatorEnv();
    fs.mkdirSync(store.LOG_DIR, { recursive: true });

    const attemptStart = this._log.length;
    log(`--- Boot attempt [${variant.label}] ---`);
    log(`cmd: ${p.emulatorExe} ${args.join(' ')}`);

    if (typeof this.onBeforeSpawn === 'function') {
      try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
    }

    const child = spawn(p.emulatorExe, args, {
      cwd: p.emulatorDir,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;
    this.serial = 'emulator-5554';
    this.lastExitCode = null;

    child.stdout.on('data', (b) => this.pushLog(b.toString('utf8')));
    child.stderr.on('data', (b) => this.pushLog(b.toString('utf8')));
    child.on('exit', (code) => {
      this.lastExitCode = code;
      this.pushLog(`emulator exit ${code}`);
    });
    child.unref();

    const budgetMs = (variant.accel === 'off' ? 10 : (variant.snapshot && this.hasSnapshot() ? 2 : 5)) * 60 * 1000;
    const t0 = Date.now();
    const client = new AdbClient({ adbPath, serial: this.serial });

    let stage = 'process';
    let lastReport = 0;
    while (Date.now() - t0 < budgetMs) {
      if (!this.running() && !(await client.isOnline())) {
        const diag = doctor.diagnose(this._attemptLines(attemptStart, 160));
        return { ok: false, crashed: true, exitCode: this.lastExitCode, diagnosis: diag, ms: Date.now() - t0 };
      }

      if (await client.isOnline()) {
        stage = 'kernel';
        try {
          const boot = (await client.shell('getprop sys.boot_completed', { timeout: 6000 })).trim();
          if (boot === '1') {
            stage = 'services';
            const pm = await client.shell('pm path android', { timeout: 8000 }).catch(() => '');
            if (/^package:/m.test(pm)) {
              try {
                const keepAwake = 'settings put global stay_on_while_plugged_in 7; '
                  + 'settings put system screen_off_timeout 2147483647; '
                  + 'svc power stayon true; wm dismiss-keyguard';
                await client.shell(keepAwake, { timeout: 6000 });
              } catch (_) { /* ignore */ }
              log(`Android ready (${Math.round((Date.now() - t0) / 1000)}s · ${variant.label})`);
              if (variant.snapshot !== false) {
                this.scheduleSnapshotSave(adbPath, { onLog });
              }
              return { ok: true, serial: this.serial, client, ms: Date.now() - t0, variant };
            }
          }
        } catch (_) { /* Still booting */ }
      }

      if (Date.now() - lastReport > 6000) {
        lastReport = Date.now();
        const sec = Math.round((Date.now() - t0) / 1000);
        const stageText = {
          process: 'Starting virtual machine',
          kernel: 'Booting Android kernel',
          services: 'Starting Android system services',
        }[stage];
        log(`${stageText}... (${sec}s)`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    const diag = doctor.diagnose(this._attemptLines(attemptStart, 160));
    await this.stop(adbPath);
    return { ok: false, timeout: true, stage, diagnosis: diag, ms: Date.now() - t0 };
  }

  async boot({ adbPath, headless, onLog, wipe = false } = {}) {
    const log = (m) => { this.pushLog(m); if (onLog) onLog(m); };
    const p = this.provisioner.paths();
    if (!fs.existsSync(p.emulatorExe)) {
      throw new Error('Android runtime engine is not installed yet; deploy it in Settings -> Runtime.');
    }

    const env = await this.provisioner.checkEnv();
    const host = doctor.hostInfo();
    const diskMB = doctor.freeDiskMB(p.avdHome || store.DATA_DIR);

    if (diskMB > 0 && diskMB < 2048) {
      const diag = {
        code: 'DISK_FULL',
        title: `Critically low disk space (${diskMB} MB remaining)`,
        hint: 'At least 4 GB of free disk space is required on the Android data drive. Free up space or change the directory in Settings -> System Integration.',
        fatal: true,
      };
      this.lastDiagnosis = diag;
      this._persistFailure({ diskMB });
      const err = new Error(`${diag.title}: ${diag.hint}`);
      err.diagnosis = diag;
      throw err;
    }

    const profile = doctor.autoProfile({
      host,
      accel: env.accel,
      emulatorVersion: env.emulator.version || '',
      diskMB,
      settings: this.settings,
    });
    this.profile = profile;
    log(`Hardware profile: ${doctor.describeProfile(profile)}`);

    const variants = wipe
      ? [{ ...profile, wipe: true, snapshot: false, headless: Boolean(headless), label: `${profile.gpu} / Factory reset` }]
      : doctor.planVariants(profile).map((v) => ({ ...v, headless: Boolean(headless) }));
    this.attempts = [];

    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const r = await this.bootOnce(v, {
        adbPath,
        onLog,
        envMeta: {
          emulatorVersion: env.emulator.version,
          api: env.sysimg.api,
          tag: env.sysimg.tag,
        },
      });
      this.attempts.push({
        label: v.label,
        ms: r.ms,
        outcome: r.ok ? 'ok' : (r.crashed ? `exit=${r.exitCode}` : `timeout@${r.stage}`),
        code: r.diagnosis?.code,
      });

      if (r.ok) {
        this.lastDiagnosis = null;
        this._clearFailure();
        return r;
      }

      const d = r.diagnosis;
      this.lastDiagnosis = d;
      log(`Boot attempt did not complete: [${d.code}] ${d.title}`);

      if (d.clearSnapshot) {
        log('Detected corrupted snapshot -> clearing snapshots and retrying cold boot');
        this.clearSnapshots();
      }
      if (d.clearLocks) {
        log('Detected stale AVD lock -> clearing locks');
        clearLocks(this.avdDir());
      }
      if (d.fatal) {
        this._persistFailure();
        const err = new Error(`${d.title}. ${d.hint}`);
        err.diagnosis = d;
        throw err;
      }

      if (i + 1 < variants.length) {
        log(`Automatically switching to fallback #${i + 2}: ${variants[i + 1].label}`);
      }
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.tailLog(160));
    this._persistFailure();
    const err = new Error(`${d.title}. ${d.hint}`);
    err.diagnosis = d;
    throw err;
  }

  /**
   * Adjust OS process priority of `emulator.exe` / `qemu-system-x86_64.exe` matching our AVD.
   * Levels: `idle` | `below` | `normal` | `game`.
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    if (!fs.existsSync(PRIORITY_SCRIPT)) return Promise.resolve(0);
    const valid = ['idle', 'below', 'normal', 'game'].includes(level) ? level : 'below';
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PRIORITY_SCRIPT, '-Avd', AVD_NAME, '-Level', valid,
      ], { timeout: 6000, windowsHide: true }, (_err, stdout) => {
        const m = /CHANGED=(\d+)/.exec(String(stdout || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  async stop(adbPath) {
    if (this._snapTimer) { clearTimeout(this._snapTimer); this._snapTimer = null; }
    const targetSerial = this.serial || 'emulator-5554';
    if (adbPath && fs.existsSync(adbPath)) {
      await new Promise((res) => {
        execFile(adbPath, ['-s', targetSerial, 'emu', 'kill'], {
          timeout: 8000,
          windowsHide: true,
          env: adbEnv(),
        }, () => res());
      });
    }
    if (this.running()) {
      await new Promise((res) => {
        const done = () => res();
        this.proc.once('exit', done);
        setTimeout(() => {
          try { if (this.running()) this.proc.kill(); } catch (_) { /* ignore */ }
          res();
        }, 6000);
      });
    }
    this.proc = null;
    if (process.platform === 'win32') {
      await this.killOrphanProcesses();
    }
    clearLocks(this.avdDir());
  }

  killOrphanProcesses() {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const ps = [
      '$killed = 0',
      'try {',
      '  $procs = Get-CimInstance Win32_Process | Where-Object {',
      "    $_.Name -match '^(qemu-system-x86_64(-headless)?|emulator(-headless)?|netsimd)\\.exe$' -and",
      `    ($_.CommandLine -like '*${AVD_NAME}*' -or $_.Name -eq 'netsimd.exe')`,
      '  }',
      '  foreach ($p in $procs) {',
      '    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; $killed++ } catch { }',
      '  }',
      '} catch { }',
      '"KILLED=$killed"',
    ].join('; ');
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { timeout: 10000, windowsHide: true },
        (_err, stdout) => {
          const m = /KILLED=(\d+)/.exec(String(stdout || ''));
          const n = m ? Number(m[1]) : 0;
          if (n > 0) this.pushLog(`Cleaned up ${n} residual emulator/QEMU process(es)`);
          resolve(n);
        });
    });
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAP_NAME, FAST_DNS_SERVERS, clearLocks };
