'use strict';
/**
 * Unified Android runtime orchestrator (`Runtime`).
 *
 * Engine selection order:
 *  1) Already-online ADB device (reuses prewarmed container, WSA, or external emulator);
 *  2) Built-in Google Android Emulator (`EmulatorEngine`: WHPX/AEHD + Ranchu + Quickboot);
 *  3) Legacy standalone QEMU + Android-x86 ISO/qcow2 fallback (advanced manual setups).
 *
 * Also manages container session trimming (`container.js`), idle auto-hibernation,
 * network self-repair (`repairNetwork`), factory reset (`resetAndroidData`), and diagnostics.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { AdbClient, findAdb } = require('./adb');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const layers = require('./layers');
const container = require('./container');
const store = require('./store');
const logfile = require('./logfile');

const ADB_FORWARD_PORT = 5555;
const MONITOR_PORT = 5556;

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmMode = null; // 'run' | 'install'
    this.activeEngine = null; // 'emulator' | 'qemu' | 'external'
    this.idleTimer = null;
    this.lastActivity = Date.now();
    this.logFile = path.join(store.LOG_DIR, 'runtime.log');
    this.bootLog = [];
    this._hv = null;
    this._activeApps = [];
    this._ensuring = null;
  }

  get settings() { return store.getSettings(); }

  adbPath() {
    return this.settings.adbPath || this.provisioner.findAdb() || findAdb('') || '';
  }

  client(serial) {
    return new AdbClient({
      adbPath: this.adbPath(),
      serial: serial ?? this.settings.device,
    });
  }

  log(line) {
    const s = `[${new Date().toISOString()}] ${line}`;
    this.bootLog.push(s);
    if (this.bootLog.length > 200) this.bootLog.shift();
    const limitKB = (this.settings.engine && this.settings.engine.logMaxKB) || 2048;
    logfile.append(this.logFile, s, limitKB);
  }

  touch() {
    this.lastActivity = Date.now();
    this.armIdleShutdown();
  }

  armIdleShutdown() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const mins = Number(this.settings.engine.idleShutdownMinutes) || 0;
    if (mins <= 0) return;
    this.idleTimer = setTimeout(async () => {
      if (this._activeApps.length > 0) { this.armIdleShutdown(); return; }
      const c = this.client();
      const pkgs = await c.runningPackages();
      const ourPkgs = store.getApps().map((a) => a.package);
      const active = pkgs.some((p) => ourPkgs.includes(p));
      if (!active && (this.vmRunning() || this.emulator.running())) {
        this.log('Idle timeout reached with no foreground apps; shutting down built-in VM');
        await this.stop({ graceful: true });
      } else {
        this.armIdleShutdown();
      }
    }, mins * 60 * 1000);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  vmRunning() {
    return Boolean(this.vmProc && this.vmProc.exitCode === null && !this.vmProc.killed);
  }

  anyRunning() {
    return this.vmRunning() || this.emulator.running();
  }

  foregroundPriorityLevel() {
    const mode = this.settings.engine.priorityMode;
    if (mode === 'game') return 'game';
    if (mode === 'performance') return 'normal';
    return 'below';
  }

  async prewarm({ onLog } = {}) {
    if (this.settings.engine.prewarm === false) return { ok: false, skipped: 'disabled' };
    const env = await this.provisioner.checkEnv();
    if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
      return { ok: false, skipped: 'not-provisioned' };
    }
    const r = await this.ensure({ onLog });
    if (r.ok && this._activeApps.length === 0) {
      await this.emulator.setPriority('idle').catch(() => {});
    }
    return r;
  }

  async beginApp(pkg, { onActive } = {}) {
    const wasIdle = this._activeApps.length === 0;
    const state = container.nextSessionState(this._activeApps, 'open', pkg);
    this._activeApps = state.active;
    this.touch();

    const c = this.client();
    await this.emulator.setPriority(this.foregroundPriorityLevel()).catch(() => {});

    try {
      const installed = store.getApps().map((a) => a.package);
      const { commands, stopped } = container.buildSessionCommands({
        pkg,
        installed,
        deep: Boolean(this.settings.engine.deepTrim),
      });
      if (commands.length) {
        await c.shell(commands.join('; '), { timeout: 10000 }).catch(() => {});
        if (stopped.length) this.log(`Container session: foreground=${pkg}, stopped background apps=${stopped.join(',')}`);
      }
    } catch (_) { /* Trimming failures never block app launch */ }

    if (wasIdle && typeof onActive === 'function') {
      try { onActive(true); } catch (_) { /* ignore */ }
    }
    return state;
  }

  async endApp(pkg, { onIdle } = {}) {
    const state = container.nextSessionState(this._activeApps, 'close', pkg);
    this._activeApps = state.active;
    const c = this.client();
    if (pkg) await c.forceStop(pkg);

    if (state.idle) {
      try {
        await c.shell(container.buildIdleCommands().join('; '), { timeout: 8000 });
      } catch (_) { /* ignore */ }
      c.closeInput();
      await this.emulator.setPriority('idle').catch(() => {});
      this.log('Container parked: last app closed; background cleared and VM priority lowered to Idle');
      if (typeof onIdle === 'function') {
        try { onIdle(false); } catch (_) { /* ignore */ }
      }
    }
    this.touch();
    return state;
  }

  async restoreSystemApps() {
    const c = this.client();
    if (!(await c.isOnline())) return { ok: false, offline: true };
    await c.shell(container.buildRestoreCommands().join('; '), { timeout: 15000 }).catch(() => {});
    return { ok: true };
  }

  // ---------------- Legacy QEMU args (fallback) ----------------

  buildArgs({ install = false, headless } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const disk = s.runtime.diskPath || p.diskFile;
    const iso = s.runtime.isoPath || p.isoFile;
    const mem = Number(s.engine.memoryMB) || 3072;
    const cores = Number(s.engine.cores) || 4;
    const useWhpx = Boolean(this._hv && this._hv.whpx);
    const hide = headless ?? s.engine.headless;

    const accel = useWhpx ? 'whpx,kernel-irqchip=off' : 'tcg,thread=multi';
    const cpu = useWhpx ? 'host' : 'max';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', cpu,
      '-smp', String(cores),
      '-m', String(mem),
      '-vga', 'virtio',
      '-display', hide ? 'none' : 'sdl,gl=off',
      '-usb', '-device', 'usb-tablet',
      '-rtc', 'base=localtime',
      '-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`,
      '-netdev', `user,id=net0,hostfwd=tcp:127.0.0.1:${ADB_FORWARD_PORT}-:5555`,
      '-device', 'virtio-net-pci,netdev=net0',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (install) {
      args.push('-cdrom', iso, '-boot', 'order=d,menu=on');
    } else {
      args.push('-boot', 'order=c');
    }
    return args;
  }

  async bootQemu({ install = false, onLog } = {}) {
    if (this.vmRunning()) return;
    const qemu = this.provisioner.findQemu();
    if (!qemu) throw new Error('QEMU executable not found; install it first in Settings -> Runtime.');

    this._hv = await this.provisioner.hypervisor();
    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.diskFile;
    const iso = this.settings.runtime.isoPath || p.isoFile;
    if (!fs.existsSync(disk)) throw new Error('Virtual disk not created yet; create it in Settings -> Runtime.');
    if (install && !fs.existsSync(iso)) throw new Error('Android-x86 ISO not found; download or import it first.');

    fs.mkdirSync(store.LOG_DIR, { recursive: true });
    const args = this.buildArgs({ install, headless: install ? false : this.settings.engine.headless });
    this.log(`Starting QEMU (${install ? 'install' : 'run'}): ${qemu} ${args.join(' ')}`);
    if (onLog) onLog(`Starting virtual machine (${this._hv.whpx ? 'WHPX accelerated' : 'TCG software mode'})...`);

    const out = fs.openSync(this.logFile, 'a');
    try {
      this.vmProc = spawn(qemu, args, {
        detached: false,
        windowsHide: install ? false : Boolean(this.settings.engine.headless),
        stdio: ['ignore', out, out],
        cwd: path.dirname(qemu),
      });
    } finally {
      try { fs.closeSync(out); } catch (_) { /* child inherited handle; close parent copy */ }
    }
    this.vmMode = install ? 'install' : 'run';
    this.vmProc.on('exit', (code) => {
      this.log(`QEMU exited with code=${code}`);
      this.vmProc = null;
      this.vmMode = null;
    });
  }

  async startInstaller({ onLog } = {}) {
    if (this.vmRunning()) await this.stop({ graceful: false });
    await this.bootQemu({ install: true, onLog });
    return { ok: true, mode: 'install' };
  }

  async markInstalled() {
    store.saveSettings({ runtime: { installed: true } });
    if (this.vmRunning() && this.vmMode === 'install') {
      await this.stop({ graceful: false });
    }
    return { ok: true };
  }

  async adoptExisting() {
    const c = this.client('');
    if (!c.hasAdb()) return null;
    try {
      const devs = (await c.devices()).filter((d) => d.state === 'device');
      if (!devs.length) return null;
      const d = devs.find((x) => /^emulator-/.test(x.serial)) || devs[0];
      const adopted = this.client(d.serial);
      const boot = (await adopted.shell('getprop sys.boot_completed', { timeout: 4000 }).catch(() => '')).trim();
      if (boot !== '1') return null;
      const pm = await adopted.shell('pm path android', { timeout: 5000 }).catch(() => '');
      if (!/^package:/m.test(pm)) return null;
      store.saveSettings({ device: d.serial });
      if (/^emulator-/.test(d.serial)) this.emulator.serial = d.serial;
      this.activeEngine = /^emulator-/.test(d.serial) ? 'emulator' : 'external';
      this.log(`Reusing online Android runtime: ${d.serial} (${d.model})`);
      this.touch();
      return { ok: true, client: adopted, serial: d.serial, adopted: true };
    } catch (_) {
      return null;
    }
  }

  ensure({ onLog } = {}) {
    if (this._ensuring) {
      if (onLog) onLog('Android runtime is already booting; joining existing startup...');
      return this._ensuring;
    }
    const p = this._ensureInner({ onLog }).finally(() => { this._ensuring = null; });
    this._ensuring = p;
    return p;
  }

  async _ensureInner({ onLog } = {}) {
    const s = this.settings;
    const c = this.client();

    if (!c.hasAdb()) {
      return {
        ok: false,
        needsSetup: 'provision',
        error: 'Android runtime is not initialized yet. Open Settings -> Runtime and click "Deploy All".',
      };
    }

    if (await c.isOnline()) {
      const ready = await this.waitAndroidReady(c, 8000, onLog);
      if (ready.ok) {
        if (/^emulator-/.test(c.serial)) this.emulator.serial = c.serial;
        this.touch();
        return { ok: true, client: c, engine: this.activeEngine || 'external' };
      }
    }

    const adopted = await this.adoptExisting();
    if (adopted) return adopted;

    if (s.engine.mode === 'attach') {
      const found = await c.probeKnownPorts();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        this.activeEngine = 'external';
        return { ok: true, client: this.client(found[0].serial), engine: 'external' };
      }
      return {
        ok: false,
        error: 'Could not connect to an external Android device. Verify it is running or switch Engine Mode back to "Built-in Runtime".',
      };
    }

    const env = await this.provisioner.checkEnv();
    if (env.emulator.ok && env.sysimg.ok) {
      try {
        const r = await this.emulator.boot({
          adbPath: this.adbPath(),
          headless: s.engine.headless,
          onLog,
        });
        store.saveSettings({ device: r.serial });
        this.activeEngine = 'emulator';
        this.touch();
        return { ok: true, client: r.client, engine: 'emulator', variant: r.variant };
      } catch (e) {
        return {
          ok: false,
          needsSetup: 'boot',
          diagnosis: e.diagnosis,
          error: e.message,
        };
      }
    }

    if (env.emulator.ok && !env.sysimg.ok) {
      return {
        ok: false,
        needsSetup: 'sysimg',
        error: 'Missing the Android 14 system image (~1.5 GB one-time download). Open Settings -> Runtime to complete setup.',
      };
    }

    if (env.qemu.ok && env.disk.ok && s.runtime.installed) {
      if (!this.vmRunning() || this.vmMode === 'install') {
        if (this.vmMode === 'install') await this.stop({ graceful: false });
        await this.bootQemu({ install: false, onLog });
      }
      const serial = `127.0.0.1:${ADB_FORWARD_PORT}`;
      const local = this.client(serial);
      const ready = await this.waitAndroidReady(local, 180000, onLog, serial);
      if (!ready.ok) {
        return { ok: false, error: 'Android boot timed out (~3 min). Export a Diagnostic Report in Settings for details.' };
      }
      store.saveSettings({ device: serial });
      this.activeEngine = 'qemu';
      this.touch();
      return { ok: true, client: local, engine: 'qemu' };
    }

    return {
      ok: false,
      needsSetup: env.emulator.ok ? 'sysimg' : (env.qemu.ok ? 'install' : 'emulator'),
      error: 'Android runtime has not been deployed yet. Open Settings -> Runtime and click "Deploy All".',
    };
  }

  async waitAndroidReady(client, timeoutMs, onLog, connectAddr) {
    const start = Date.now();
    let stage = 'offline';
    while (Date.now() - start < timeoutMs) {
      if (connectAddr) await client.connect(connectAddr);
      if (await client.isOnline()) {
        stage = 'kernel';
        try {
          const boot = (await client.shell('getprop sys.boot_completed', { timeout: 5000 })).trim();
          if (boot === '1') {
            stage = 'services';
            const pm = await client.shell('pm path android', { timeout: 6000 }).catch(() => '');
            if (/^package:/m.test(pm)) return { ok: true, stage: 'ready' };
          }
        } catch (_) { /* Still starting */ }
      }
      if (onLog) {
        const sec = Math.round((Date.now() - start) / 1000);
        const txt = {
          offline: 'Waiting for virtual machine connection',
          kernel: 'Booting Android kernel',
          services: 'Starting Android Package Manager',
        }[stage];
        onLog(`${txt}... (${sec}s)`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage };
  }

  monitorCmd(cmd) {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: MONITOR_PORT }, () => {
        setTimeout(() => {
          sock.write(`${cmd}\r\n`);
          setTimeout(() => { sock.end(); resolve(true); }, 250);
        }, 150);
      });
      sock.on('error', () => resolve(false));
      sock.setTimeout(3000, () => { sock.destroy(); resolve(false); });
    });
  }

  async stop({ graceful = true } = {}) {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    await this.emulator.stop(this.adbPath());

    if (!this.vmRunning()) return;
    if (graceful && this.vmMode === 'run') {
      try { await this.client().shell('reboot -p', { timeout: 4000 }); } catch (_) { /* ignore */ }
      await this.monitorCmd('system_powerdown');
      const ok = await new Promise((res) => {
        const t = setTimeout(() => res(false), 12000);
        this.vmProc.once('exit', () => { clearTimeout(t); res(true); });
      });
      if (ok) return;
    }
    try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
    if (this.vmRunning()) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
    }
    this.vmProc = null;
  }

  async status() {
    const env = await this.provisioner.checkEnv();
    const c = this.client();
    const online = env.adb.ok ? await c.isOnline() : false;
    let freeform = false;
    let android = '';
    if (online) {
      [freeform, android] = await Promise.all([c.supportsFreeform(), c.androidVersion()]);
    }
    const host = doctor.hostInfo();
    const p = this.provisioner.paths();
    const profile = this.emulator.profile || doctor.autoProfile({
      host,
      accel: env.accel,
      emulatorVersion: env.emulator.version || '',
      diskMB: doctor.freeDiskMB(p.avdHome || store.DATA_DIR),
      settings: this.settings,
    });
    const phase = online
      ? 'ready'
      : (this.anyRunning() || this._ensuring) ? 'booting' : 'stopped';
    return {
      adbOk: env.adb.ok,
      adbPath: this.adbPath(),
      deviceOnline: online,
      serial: c.serial,
      android,
      freeform,
      vmRunning: this.anyRunning(),
      vmStarting: Boolean(this._ensuring) && !online,
      phase,
      engine: this.activeEngine || (env.emulator.ok ? 'emulator' : 'none'),
      installing: this.vmMode === 'install',
      installed: env.ready || this.settings.runtime.installed,
      needsSetup: env.needsSetup,
      accel: env.accel,
      autoProfile: doctor.describeProfile(profile),
      diagnosis: this.emulator.lastDiagnosis,
      lastFailure: this.emulator.lastFailure(),
      env,
    };
  }

  async diagnostics() {
    const env = await this.provisioner.checkEnv();
    const host = doctor.hostInfo();
    const p = this.provisioner.paths();
    const profile = this.emulator.profile || doctor.autoProfile({
      host,
      accel: env.accel,
      emulatorVersion: env.emulator.version || '',
      diskMB: doctor.freeDiskMB(p.avdHome || store.DATA_DIR),
      settings: this.settings,
    });
    const persisted = this.emulator.lastFailure();
    const emuTail = this.emulator.tailLog(160);
    const tail = emuTail.length
      ? emuTail
      : ((persisted && persisted.logTail && persisted.logTail.length) ? persisted.logTail : this.bootLog.slice(-120));
    const diagnosis = this.emulator.lastDiagnosis
      || (persisted && persisted.diagnosis)
      || (tail.length ? doctor.diagnose(tail) : null);
    const attempts = this.emulator.attempts.length
      ? this.emulator.attempts
      : ((persisted && persisted.attempts) || []);
    let pkgVersion = '';
    try { pkgVersion = require('../../package.json').version; } catch (_) { /* ignore */ }
    const text = doctor.formatReport({
      appVersion: pkgVersion,
      host,
      env,
      profile,
      diagnosis,
      attempts,
      logTail: tail,
      settings: this.settings,
    });
    fs.mkdirSync(store.LOG_DIR, { recursive: true });
    const file = path.join(store.LOG_DIR, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    fs.writeFileSync(file, text, 'utf8');
    return { file, text, diagnosis, profile };
  }

  usage() {
    const p = this.provisioner.paths();
    return layers.summary(p.root, {
      activeSysImgDir: p.sysImgDir,
      activeAvdName: 'apkstart',
      avdHome: p.avdHome,
    });
  }

  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    if (apply && includeSnapshots && this.anyRunning()) {
      await this.stop({ graceful: false });
    }
    const p = this.provisioner.paths();
    return layers.prune(p.root, {
      apply,
      aggressive,
      includeSnapshots,
      activeSysImgDir: p.sysImgDir,
      activeAvdName: 'apkstart',
      avdHome: p.avdHome,
    });
  }

  async resetAndroidData() {
    await this.stop({ graceful: false });
    const avdDir = this.emulator.avdDir();
    if (!fs.existsSync(avdDir)) return { ok: true, reclaimed: 0, note: 'not-created' };
    const resolved = path.resolve(avdDir);
    const avdHome = path.resolve(this.provisioner.paths().avdHome);
    if (!resolved.startsWith(avdHome + path.sep) && resolved !== avdHome) {
      return { ok: false, error: 'AVD path validation failed; aborting reset.' };
    }
    const before = layers.dirSize(resolved);
    const WIPE = [
      /^userdata(-qemu)?\.img(\.qcow2)?$/i,
      /^sdcard\.img(\.qcow2)?$/i,
      /^cache\.img(\.qcow2)?$/i,
      /^encryptionkey\.img(\.qcow2)?$/i,
      /^snapshots(\.stale-.*)?$/i,
      /\.lock$/i,
      /^emu-launch-params\.txt$/i,
      /^hardware-qemu\.ini$/i,
    ];
    let removed = 0;
    for (const name of fs.readdirSync(resolved)) {
      if (!WIPE.some((r) => r.test(name))) continue;
      try {
        fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
        removed += 1;
      } catch (_) { /* ignore */ }
    }
    try { store.saveApps([]); } catch (_) { /* ignore */ }
    const after = layers.dirSize(resolved);
    const reclaimed = Math.max(0, before - after);
    this.log(`Android /data reset complete: removed ${removed} items, reclaimed ${(reclaimed / 1048576).toFixed(1)} MB`);
    return { ok: true, reclaimed, removed };
  }

  async waitForNetwork({ timeoutMs = 45000, onLog } = {}) {
    return this.emulator.waitForNetwork(this.adbPath(), { timeoutMs, onLog });
  }

  async repairNetwork({ onLog } = {}) {
    const log = (m) => { this.log(m); if (onLog) onLog(m); };
    const adbPath = this.adbPath();

    if (await this.client().isOnline()) {
      const cur = await this.emulator.checkNetwork(adbPath);
      if (cur.ok) {
        log(`Virtual network is already healthy (${cur.ip} -> ${cur.gw})`);
        return { ok: true, network: cur, wiped: false, rebooted: false };
      }
    }

    log('Step 1/2: Cold-booting Android runtime without snapshots to reinitialize virtual Wi-Fi (data preserved)...');
    await this.stop({ graceful: false });
    this.emulator.clearSnapshots();
    try {
      const r1 = await this.emulator.boot({ adbPath, headless: this.settings.engine.headless, onLog });
      store.saveSettings({ device: r1.serial });
      this.activeEngine = 'emulator';
      const net1 = await this.emulator.waitForNetwork(adbPath, { timeoutMs: 45000, onLog });
      if (net1.ok) {
        log(`Network restored via cold boot (${net1.ip} -> ${net1.gw}); saving clean snapshot...`);
        await this.emulator._saveViaAdb(adbPath, r1.serial);
        return { ok: true, network: net1, wiped: false, rebooted: true };
      }
    } catch (e) {
      log(`Cold boot recovery attempt failed (${e.message}); proceeding to Step 2`);
    }

    log('Step 2/2: Cold boot still lacks routing; resetting Android /data (installed apps will auto-reinstall on next launch)...');
    await this.stop({ graceful: false });
    this.emulator.clearSnapshots();
    const r = await this.emulator.boot({
      adbPath,
      headless: this.settings.engine.headless,
      onLog,
      wipe: true,
    });
    store.saveSettings({ device: r.serial });
    this.activeEngine = 'emulator';
    this.touch();
    const netInfo = await this.emulator.waitForNetwork(adbPath, { timeoutMs: 60000, onLog });
    if (netInfo.ok) {
      log(`Virtual network restored (${netInfo.ip} -> ${netInfo.gw}); saving clean snapshot...`);
      await this.emulator._saveViaAdb(adbPath, r.serial);
    } else {
      log('Android booted, but virtual Wi-Fi still has no default route; check Windows Firewall or VPN adapters.');
    }
    return { ok: netInfo.ok, network: netInfo, wiped: true, rebooted: true };
  }

  async probe() {
    const c = this.client('');
    if (!c.hasAdb()) return [];
    return c.probeKnownPorts();
  }

  getClient(serial) { return this.client(serial); }

  isRunning() { return this.anyRunning(); }

  applyPriority(level = this.foregroundPriorityLevel()) {
    const mapped = level === 'game' ? 'game'
      : (level === 'performance' ? 'normal' : (level === 'idle' ? 'idle' : 'below'));
    return this.emulator.setPriority(mapped);
  }

  setAgent(agent) {
    this.agent = agent || null;
    this.emulator.onBeforeSpawn = async () => {
      if (this.agent && typeof this.agent.bootHide === 'function') await this.agent.bootHide(true);
    };
  }

  scheduleSnapshotSave(options = {}) {
    return this.emulator.scheduleSnapshotSave(this.adbPath(), options);
  }

  dispose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try { this.client().closeInput(); } catch (_) { /* ignore */ }
  }
}

module.exports = { Runtime, ADB_FORWARD_PORT, MONITOR_PORT };
