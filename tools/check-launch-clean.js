'use strict';
/**
 * End-to-end check that launching an Android app shows only its app window:
 *   1) Start ApkStart with a sandbox APPDATA directory and install a test APK with `--apk` (this starts the emulator).
 *   2) Launch the app with `--launch <package-name>`.
 *   3) Enumerate visible top-level windows throughout; the emulator window (Android Emulator - ...) and QEMU / netsimd
 *      console windows must not appear. The app window must appear, confirming that embedding succeeded.
 *
 * Usage: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Like the other window checks, allow an external runtime/data path (users often keep the runtime on another drive).
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`Test APK not found: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) Install ----
  console.log('— Installing APK (the first cold boot takes about 40–90 seconds)...');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* The file has not been written yet. */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `Installed package: ${pkg || '(timed out)'}`);
  // Wait for the first instance to exit fully before launching another; otherwise the single-instance lock makes the second exit immediately,
  // which looks like a missing window rather than a startup failure.
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\nResult: FAIL (no app was installed; skipping the remaining checks)');
    process.exit(1);
  }

  // ---- 2) Launch the app ----
  console.log('— Launching the app...');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // Allow 120 seconds for a 23-second cold boot plus an approximately 17-second app launch; 60 seconds caused false failures on slower machines.
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Visible unexpected windows:`, JSON.stringify(hit));
    }
    // Treat a titled, non-emulator, non-console top-level window as the app window.
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/ApkStart|WorkBuddy|Microsoft|Program Manager|Settings|Edge|\u8F93\u5165\u4F53\u9A8C/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)}s] App window appeared`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `Emulator/console windows remained hidden (${leaked} observations)`);
  check(sawAppWin, `The app window appeared (the app is embedded rather than shown in a separate emulator window)`);
  console.log('  Visible window titles:', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- End of app.log ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(app.log not found)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  Sandbox retained at:${sandbox}`);
  }
  console.log('');
  console.log(`Result: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
