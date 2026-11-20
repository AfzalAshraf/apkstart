'use strict';
/**
 * Self-adaptive environment probing, hardware profiling, failure diagnosis,
 * and self-healing retry variant planning.
 *
 * Responsibilities:
 *  1) Probe host capabilities (RAM, CPU cores, free disk, path ASCII safety,
 *     RDP session, emulator version, hypervisor acceleration);
 *  2) Compute optimal zero-config runtime parameters (autoProfile);
 *  3) Generate deduplicated fallback boot variants from fast to conservative (planVariants);
 *  4) Classify crash/boot failure logs into actionable root causes (diagnose);
 *  5) Export structured plain-text diagnostic reports (formatReport).
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFileSync } = require('child_process');

/** Pure ASCII printable path check (Android Emulator / QEMU are sensitive to non-ASCII paths on Windows) */
function isAsciiPath(p) {
  return typeof p === 'string' && /^[\x20-\x7E]+$/.test(p);
}

/**
 * Convert a non-ASCII Windows directory path into its 8.3 short path (e.g. C:\Users\ADMINI~1\...),
 * passing the target path via environment variable so special characters (%, ", &, ') cannot break parsing.
 */
function shortPath(p) {
  if (!p || process.platform !== 'win32' || isAsciiPath(p)) return p;
  try {
    fs.mkdirSync(p, { recursive: true });
    const cmd = 'for %I in ("%APKSTART_TARGET%") do @echo %~sI';
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', cmd], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      env: { ...process.env, APKSTART_TARGET: p },
    }).trim();
    if (out && fs.existsSync(out) && isAsciiPath(out)) return out;
  } catch (_) { /* 8.3 short names may be disabled on some volumes; fall back to original path */ }
  return p;
}

/** Free disk space (MB) on the volume hosting `dir`; returns 0 if unavailable */
function freeDiskMB(dir) {
  try {
    const target = fs.existsSync(dir) ? dir : path.dirname(dir);
    if (typeof fs.statfsSync === 'function') {
      const s = fs.statfsSync(target);
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1048576);
    }
  } catch (_) { /* fall through */ }
  if (process.platform === 'win32') {
    try {
      const drive = path.parse(path.resolve(dir)).root.replace(/\\+$/, '');
      if (!/^[A-Za-z]:$/.test(drive)) return 0;
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-PSDrive -Name '${drive[0]}').Free`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
      const n = Number(out);
      if (Number.isFinite(n) && n > 0) return Math.floor(n / 1048576);
    } catch (_) { /* ignore */ }
  }
  return 0;
}

/** Detect Remote Desktop (RDP) session where hardware OpenGL/Vulkan often fails */
function isRemoteSession() {
  const s = String(process.env.SESSIONNAME || '');
  return /^rdp/i.test(s);
}

/**
 * Verify Microsoft Visual C++ 2015-2022 Redistributable (x64) presence.
 * Android Emulator (Qt6) and QEMU link against vcruntime140 / vcruntime140_1 / msvcp140;
 * missing DLLs cause immediate 0xC0000135 startup failure on clean Windows installations.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const need = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
  return need.every((dll) => fs.existsSync(path.join(sys, dll)));
}

function hostInfo() {
  const totalMB = Math.floor(os.totalmem() / 1048576);
  const freeMB = Math.floor(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length);
  const home = os.homedir();
  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: isRemoteSession(),
  };
}

/** Emulator version helpers. */
function versionNumbers(version) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

function parseEmulatorMajor(version) {
  return versionNumbers(version)[0];
}

/**
 * Available graphics backends, ordered from the fastest to the safest.
 * Emulator 36.4.9 and newer use `software`; older releases still require
 * `swiftshader_indirect`. Modern releases should not be offered the deprecated flag.
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
}

function softwareGpuMode(emulatorVersion) {
  const version = typeof emulatorVersion === 'string'
    ? emulatorVersion
    : `${Number(emulatorVersion) || 0}.0.0`;
  const candidates = gpuCandidates(version);
  return candidates.find((mode) => /^(software|swiftshader)/.test(mode)) || 'software';
}

/**
 * Lightweight container vCPU quota:
 *  - save:     fixed 2 vCPUs (lowest host CPU footprint)
 *  - balanced: half of logical cores, clamped to 2..4
 *  - smooth:   liteMode=false, returns null (uses standard autoProfile core allocation)
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine.liteMode === false) return null;
  if (engine.resourceMode === 'save') {
    return { cores: Math.min(2, Math.max(1, host.cores)), priority: 'below' };
  }
  const half = Math.floor(host.cores / 2);
  const cores = Math.max(2, Math.min(4, half));
  return {
    cores: Math.min(cores, host.cores),
    priority: 'below',
  };
}

/**
 * Guest physical LCD panel dimensions (`hw.lcd.width/height` + `-skin WxH`).
 */
const RENDER_PRESETS = {
  '540x960': { w: 540, h: 960, dpi: 240 },
  '720x1280': { w: 720, h: 1280, dpi: 320 },
  '1080x1920': { w: 1080, h: 1920, dpi: 420 },
};

function lcdFor({ renderSize = 'auto', accelOk = false, landscape = false } = {}) {
  const picked = RENDER_PRESETS[renderSize];
  const base = picked || (accelOk ? RENDER_PRESETS['720x1280'] : RENDER_PRESETS['540x960']);
  if (!landscape) return { ...base };
  return { w: base.h, h: base.w, dpi: base.dpi };
}

/** Convert saved advanced options into explicit overrides. */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/** Compute a repeatable hardware profile and its safe fallback parameters. */
function chooseProfile({
  host = hostInfo(), accel = { ok: false }, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = Boolean(accel && accel.ok);
  const [major] = versionNumbers(emulatorVersion);
  let memoryMB = Math.max(2048, Math.min(3072, Math.floor((Number(host.totalMB) * 0.22) / 256) * 256));
  if (host.freeMB > 0 && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (Number(overrides.memoryMB) > 0) {
    memoryMB = Math.max(1536, Math.min(8192, Number(overrides.memoryMB)));
  }

  let cores = Math.max(2, Math.min(4, Math.floor((Number(host.cores) || 2) / 2)));
  if (Number(overrides.cores) > 0) cores = Math.max(1, Math.min(8, Number(overrides.cores)));
  const engineSettings = settings && settings.engine ? settings.engine : {};
  const lite = settings ? liteProfile({ host, engine: engineSettings }) : null;
  if (lite && !Number(overrides.cores)) cores = Math.min(cores, lite.cores);

  const availableMB = Number(diskMB) || freeDiskMB(host.tmp || os.tmpdir());
  const requestedGB = Number(engineSettings.dataPartitionGB) || 0;
  const dataMB = requestedGB > 0
    ? Math.max(2048, Math.min(65536, Math.round(requestedGB * 1024)))
    : (availableMB > 0 && availableMB < 12288 ? 4096 : 6144);

  const gpus = gpuCandidates(emulatorVersion);
  const manualGpu = overrides.gpuMode && overrides.gpuMode !== 'auto' ? overrides.gpuMode : '';
  const gpu = manualGpu && gpus.includes(manualGpu) ? manualGpu : gpus[0];
  const softGpu = gpus.find((mode) => /^(software|swiftshader)/.test(mode)) || 'software';
  const displaySettings = settings && settings.display ? settings.display : {};
  const lcd = lcdFor({
    renderSize: engineSettings.renderSize || 'auto',
    accelOk,
    landscape: Boolean(displaySettings.landscape),
  });
  const profile = {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    softGpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    accelDriver: (accel && accel.driver) || (accelOk ? 'whpx/aehd' : 'tcg'),
    port,
    adbPort,
    snapshot: true,
    wipe: false,
    lite: Boolean(lite),
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorMajor: major,
    emulatorVersion,
    host,
  };
  profile.reasons = [
    `RAM ${host.totalMB} MB (free ${host.freeMB} MB) -> ${memoryMB} MB`,
    `${host.cores} logical cores -> ${cores} vCPUs${profile.lite ? ' (lite container)' : ''}`,
    accelOk ? `Hardware acceleration (${profile.accelDriver})` : 'No hypervisor -> TCG software emulation',
    `GPU=${gpu}${host.rdp ? ' (RDP session -> software fallback)' : ''}`,
    `Panel ${lcd.w}x${lcd.h}@${lcd.dpi}dpi`,
    availableMB ? `Free disk ${(availableMB / 1024).toFixed(1)} GB -> data partition ${dataMB} MB` : `Data partition ${dataMB} MB`,
  ];
  return profile;
}

/**
 * Settings-page profile preview. It intentionally shares the exact calculation
 * used by the runtime launcher so displayed and applied values cannot drift.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044, host = hostInfo() } = {}) {
  const eng = settings && settings.engine ? settings.engine : {};
  return chooseProfile({
    host,
    accel: accel || { ok: false },
    emulatorVersion,
    diskMB,
    port,
    adbPort,
    settings,
    overrides: overridesFromSettings(eng),
  });
}

/**
 * Deduplicated boot fallback variants ordered from fastest to most conservative:
 *  1) Default auto profile (e.g. host GPU + hypervisor + quickboot snapshot)
 *  2) Software GPU + hypervisor (bypasses faulty host Vulkan/OpenGL drivers)
 *  3) Software GPU + TCG software CPU (bypasses broken WHPX/Hyper-V/AEHD state)
 *  4) Minimal 2 GB RAM + cold boot + software CPU (last-resort rescue mode)
 *
 * Variants with identical effective `(gpu, accel, memoryMB, snapshot)` parameters are
 * strictly deduplicated so 8 GB hosts never repeat a 10-minute TCG cold boot twice.
 */
function planVariants(profile) {
  const soft = profile.softGpu || 'software';
  const list = [];
  list.push({ ...profile, wipe: false, label: `${profile.gpu} / ${profile.accel === 'off' ? 'Software emulation' : 'Hardware acceleration'}` });
  if (profile.gpu !== soft) {
    list.push({ ...profile, gpu: soft, wipe: false, label: `${soft} / Software rendering` });
  }
  if (profile.accel === 'auto') {
    list.push({ ...profile, gpu: soft, accel: 'off', snapshot: false, wipe: false, label: `${soft} / Software emulation (bypass hypervisor)` });
  }
  list.push({
    ...profile,
    gpu: soft,
    accel: 'off',
    memoryMB: Math.min(2048, profile.memoryMB),
    snapshot: false,
    wipe: false,
    lastResort: true,
    label: 'Minimal safe mode (2 GB / cold boot / software)',
  });

  const seen = new Map();
  const out = [];
  for (const variant of list) {
    const key = `${variant.gpu}|${variant.accel}|${variant.wipe}|${variant.memoryMB}|${variant.snapshot !== false}`;
    if (seen.has(key)) {
      if (variant.lastResort) out[seen.get(key)].lastResort = true;
      continue;
    }
    seen.set(key, out.length);
    out.push(variant);
  }
  return out;
}

/** Stable image identity, independent of drive letter or install root. */
function imageIdentity(dir) {
  const parts = String(dir || '')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
    .split('/')
    .filter(Boolean);
  const root = parts.lastIndexOf('system-images');
  const identity = root >= 0 ? parts.slice(root + 1, root + 4) : parts.slice(-3);
  return identity.map((part) => part.toLowerCase()).join('/');
}

/**
 * Snapshot compatibility fingerprint.
 * Excludes dataMB and the absolute installation root so in-place expansion or moving
 * the same system image to another drive never discards quickboot state.
 */
function snapshotKey(meta = {}, sysImgDir = '') {
  const raw = JSON.stringify({
    emu: meta.emulatorVersion || '',
    img: imageIdentity(sysImgDir),
    api: meta.api || '',
    tag: meta.tag || '',
  });
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  let port = Math.max(1024, Math.floor(Number(start) || 5554));
  if (port % 2) port += 1;
  for (; port < 65534; port += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await portIsFree(port) && await portIsFree(port + 1)) return port;
  }
  throw new Error('No free adjacent TCP port pair is available');
}

async function freeAdbPort(start = 5044) {
  let port = Math.max(1024, Math.floor(Number(start) || 5044));
  if (port % 2) port += 1;
  for (; port < 65535; port += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await portIsFree(port)) return port;
  }
  throw new Error('No free even TCP port is available');
}

// ---------------- Failure classification ----------------

const RULES = [
  {
    code: 'DISK_FULL',
    re: /No space left on device|ENOSPC|not enough space|disk full|userdata-qemu\.img.*failed/i,
    title: 'Insufficient disk space',
    hint: 'Android runtime and data images require at least 6 GB of free disk space. Free up space or relocate the Runtime Data Directory in Settings -> System Integration.',
    fatal: true,
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|WHPX.*failed|Failed to initialize WHPX|AEHD.*failed|HAXM.*not working|Hypervisor.*unavailable|uguest|WHvCreatePartition/i,
    title: 'Hypervisor initialization failed (WHPX / AEHD conflict)',
    hint: 'Automatically falling back to software emulation. For full speed, enable "Virtual Machine Platform" in Windows Features and reboot.',
    retryable: true,
  },
  {
    code: 'GPU_INIT',
    re: /Failed to initialize GL emulation|gfxstream|ANGLE|eglInitialize|OpenGL|vkCreateInstance|Vulkan.*failed|emuglConfig|Failed to create context/i,
    title: 'Graphics driver failed to initialize hardware rendering',
    hint: 'Automatically falling back to built-in software rendering (SwiftShader). Updating your GPU driver restores hardware acceleration.',
    retryable: true,
  },
  {
    code: 'SNAPSHOT_CORRUPT',
    re: /snapshot.*(corrupt|invalid|mismatch|load.*fail|incompatible)|Failed to load snapshot/i,
    title: 'Quickboot snapshot is corrupted or incompatible',
    hint: 'Corrupted snapshot was discarded automatically; cold-booting a clean session now.',
    clearSnapshot: true,
    retryable: true,
  },
  {
    code: 'AVD_LOCK',
    re: /already running|locking.*\.lock|hardware-qemu\.ini\.lock|multiinstance\.lock/i,
    title: 'Runtime lock left behind by a previous session',
    hint: 'Stale AVD lock files will be cleared automatically before retrying.',
    clearLocks: true,
    retryable: true,
  },
  {
    code: 'NON_ASCII',
    re: /cannot open.*\\Users\\[^\x00-\x7F]+|non-ASCII|Invalid INI|Could not open INI file/i,
    title: 'Windows user path contains non-ASCII characters',
    hint: 'ApkStart attempts 8.3 short-path conversion automatically. If disabled on this drive, set an ASCII Runtime Data Directory (e.g. C:\\ApkStartData) in Settings.',
    retryable: true,
  },
  {
    code: 'MEMORY',
    re: /Failed to allocate memory|Cannot allocate.*memory|Could not allocate.*RAM|out of memory|ENOMEM/i,
    title: 'Insufficient available host RAM for guest VM',
    hint: 'Close memory-heavy apps and retry; ApkStart will automatically step down guest RAM to 2 GB.',
    retryable: true,
  },
  {
    code: 'MISSING_DLL',
    re: /0xc0000135|3221225781|VCRUNTIME140|MSVCP140|api-ms-win-crt/i,
    title: 'Missing Microsoft Visual C++ Redistributable (x64)',
    hint: 'Install Microsoft Visual C++ 2015-2022 Redistributable (x64) via Settings -> Runtime Self-Check.',
    fatal: true,
  },
  {
    code: 'ACCESS_VIOLATION',
    re: /0xc0000005|3221225477|EXCEPTION_ACCESS_VIOLATION|Segmentation fault/i,
    title: 'Emulator process crashed (0xC0000005 Access Violation)',
    hint: 'Commonly caused by GPU driver Vulkan/OpenGL bugs or third-party antivirus hooks. Automatically retrying with software rendering.',
    retryable: true,
  },
  {
    code: 'PORT_BUSY',
    re: /Address already in use|cannot bind.*555[45]|ports are all in use/i,
    title: 'Emulator / ADB local TCP port is already in use',
    hint: 'Another Android emulator may be occupying port 5554/5555. Close conflicting emulators and retry.',
    retryable: true,
  },
];

/** Match emulator/boot log tail against known failure signatures */
function diagnose(logLines) {
  const text = (Array.isArray(logLines) ? logLines.join('\n') : String(logLines || '')).slice(-24000);
  // A process-level access violation is more actionable than nearby GPU setup
  // chatter, so classify it before the broader rendering rules below.
  const accessViolation = RULES.find((rule) => rule.code === 'ACCESS_VIOLATION');
  const crash = accessViolation && accessViolation.re.exec(text);
  if (crash) {
    return {
      code: accessViolation.code,
      title: accessViolation.title,
      hint: accessViolation.hint,
      matched: crash[0],
      fatal: Boolean(accessViolation.fatal),
      retryable: Boolean(accessViolation.retryable),
      clearSnapshot: Boolean(accessViolation.clearSnapshot),
      clearLocks: Boolean(accessViolation.clearLocks),
    };
  }
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) {
      return {
        code: r.code,
        title: r.title,
        hint: r.hint,
        matched: m[0],
        fatal: !!r.fatal,
        retryable: !!r.retryable,
        clearSnapshot: !!r.clearSnapshot,
        clearLocks: !!r.clearLocks,
      };
    }
  }
  return {
    code: 'UNKNOWN',
    title: 'Android runtime failed to finish booting in time',
    hint: 'First cold boot under software emulation can take 5-10 minutes. If repeated retries fail, export a Diagnostic Report from Settings.',
    matched: '',
    fatal: false,
    retryable: true,
  };
}

/** Human-readable one-line summary of the active runtime profile */
function describeProfile(p) {
  if (!p) return 'Auto';
  const acc = p.accel === 'off' ? 'Software emulation' : `Hardware acceleration (${p.accelDriver || 'enabled'})`;
  const gpu = p.gpu === 'host' ? 'Host GPU' : `Software GPU (${p.gpu || 'auto'})`;
  const lite = p.lite ? ' · Lite container' : '';
  const lcd = p.lcd ? ` · ${p.lcd.w}x${p.lcd.h}` : '';
  const port = p.port ? ` · Port ${p.port}` : '';
  return `${p.memoryMB} MB · ${p.cores} vCPUs · ${acc} · ${gpu}${lcd}${lite}${port}`;
}

function check(ctx = {}) {
  const env = ctx.provisionStatus || {};
  const items = [];
  const add = (id, title, ok, detail, levelIfMissing = 'warn') => items.push({
    id,
    title,
    level: ok ? 'ok' : levelIfMissing,
    detail: detail || (ok ? 'Ready' : 'Not detected'),
  });
  add('adb', 'ADB platform-tools', Boolean(env.adb && env.adb.ok), env.adb && env.adb.path);
  add('emulator', 'Android Emulator', Boolean(env.emulator && env.emulator.ok), env.emulator && env.emulator.version);
  add('sysimg', 'Android system image', Boolean(env.sysimg && env.sysimg.ok),
    env.sysimg && env.sysimg.api ? `API ${env.sysimg.api} · ${env.sysimg.tag || 'default'}` : 'No system image found');
  add('hypervisor', 'Hardware virtualization', Boolean(env.accel && env.accel.ok),
    env.accel && env.accel.note ? env.accel.note : 'Software emulation remains available', 'info');
  if (ctx.runtimeDir) add('runtime-dir', 'Runtime directory', fs.existsSync(ctx.runtimeDir), ctx.runtimeDir);
  return { items };
}

async function collectFullReport(ctx = {}) {
  const env = ctx.provisionStatus || {};
  const settings = ctx.settings || {};
  const host = hostInfo();
  const profile = autoProfile({
    host,
    settings,
    accel: env.accel || { ok: false },
    emulatorVersion: (env.emulator && env.emulator.version) || '',
  });
  return {
    appVersion: ctx.appVersion,
    host,
    env,
    profile,
    diagnosis: ctx.diagnosis || null,
    attempts: ctx.attempts || [],
    logTail: ctx.logTail || [],
    settings,
    extras: ctx.extras || {},
  };
}

function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir || require('./store').DATA_DIR, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const report = {
    appVersion: require('../../package.json').version,
    host: hostInfo(),
    profile: profile || null,
    diagnosis: diagnose(logLines),
    logTail: Array.isArray(logLines) ? logLines.slice(-120) : String(logLines || '').split(/\r?\n/).slice(-120),
    extras: extra,
  };
  fs.writeFileSync(file, formatReport(report), 'utf8');
  return { file, diagnosis: report.diagnosis };
}

/** Format a plain-text diagnostic report without sensitive tokens or personal data */
function formatReport({ appVersion, host, env, profile, diagnosis, attempts, logTail, settings, extras }) {
  const lines = [];
  lines.push(`=== ApkStart Diagnostic Report (${new Date().toISOString()}) ===`);
  lines.push(`App Version: ${appVersion || 'unknown'}`);
  if (host) {
    lines.push(`Host OS: ${host.platform} ${host.release} (${host.arch}) | RAM ${host.totalMB} MB (free ${host.freeMB} MB) | ${host.cores} cores | ASCII home=${host.homeAscii} | RDP=${host.rdp}`);
  }
  if (env) {
    lines.push(`Components: adb=${env.adb?.ok} (${env.adb?.path || '-'}) | emulator=${env.emulator?.ok} (${env.emulator?.version || '-'}) | sysimg=${env.sysimg?.ok} (API ${env.sysimg?.api || '-'} ${env.sysimg?.tag || ''})`);
    lines.push(`Hypervisor: ok=${env.accel?.ok} driver=${env.accel?.driver || '-'} | whpx=${env.hypervisor?.whpx} | note=${(env.accel?.note || '').replace(/\s+/g, ' ')}`);
  }
  if (profile) {
    lines.push(`Auto Profile: ${describeProfile(profile)} | data=${profile.dataMB} MB | snapshot=${profile.snapshot}`);
    for (const r of profile.reasons || []) lines.push(`  - ${r}`);
  }
  if (settings) {
    const safeSettings = {
      engine: settings.engine,
      display: settings.display,
      runtime: { ...settings.runtime, giteeToken: settings.runtime?.giteeToken ? '[REDACTED]' : '' },
    };
    lines.push(`Settings: ${JSON.stringify(safeSettings)}`);
  }
  if (diagnosis) {
    lines.push(`Diagnosis: [${diagnosis.code}] ${diagnosis.title} (matched: ${diagnosis.matched || '-'})`);
    lines.push(`Suggested Action: ${diagnosis.hint}`);
  }
  if (attempts && attempts.length) {
    lines.push('Boot Attempts:');
    attempts.forEach((a, i) => lines.push(`  #${i + 1} ${a.label} -> ${a.outcome} (${a.ms}ms${a.code ? `, ${a.code}` : ''})`));
  }
  if (extras && Object.keys(extras).length) {
    lines.push(`Additional Diagnostics: ${JSON.stringify(extras)}`);
  }
  lines.push('--- Recent Runtime Log (last 120 lines) ---');
  for (const l of (logTail || []).slice(-120)) lines.push(l);
  return lines.join('\n') + '\n';
}

module.exports = {
  isAsciiPath,
  shortPath,
  freeDiskMB,
  isRemoteSession,
  vcRedistOk,
  hostInfo,
  versionNumbers,
  parseEmulatorMajor,
  gpuCandidates,
  softwareGpuMode,
  liteProfile,
  lcdFor,
  RENDER_PRESETS,
  chooseProfile,
  overridesFromSettings,
  autoProfile,
  planVariants,
  imageIdentity,
  snapshotKey,
  freePortPair,
  freeAdbPort,
  diagnose,
  check,
  collectFullReport,
  describeProfile,
  writeReport,
  formatReport,
};
