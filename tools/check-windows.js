'use strict';
/**
 * Window visibility check: launch emulator as the main process does and verify that no extra desktop windows appear.
 *
 * Watch for two kinds of windows:
 *   1. "Android Emulator - apkstart5554"(QWindowIcon, the emulator’s main window)
 *      Normally this should appear only as a child of our window after embedding, never as a separate desktop window.
 *   2. Console windows (conhost ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS)
 *      QEMU and netsimd may each create one; the title is the path of the executable.
 *
 * Usage: node tools/check-windows.js [runtimeRoot]
 *   By default, runtimeRoot is the repository engine/ directory (a locally downloaded runtime); you can also pass the installed app’s
 *   resources/runtime.
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

// Runtime directory precedence: argument > environment variable > repository engine/.
const ROOT = path.resolve(process.argv[2] || process.env.APKSTART_RUNTIME || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
// The AVD may be on another drive (runtime.avdDir in Settings); allow an explicit path here too.
const AVD_HOME = process.env.APKSTART_AVD_HOME
  || path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('Agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  // The agent only handles windows owned by runtime processes; declare the scope before hiding anything.
  await agent.scope([ROOT]);
  await agent.bootHide();
  console.log('Persistent window hiding enabled');

  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Visible unexpected windows:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('Probe (hidden windows should still be discoverable):', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('Unexpected windows still visible at the end:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // A window may briefly appear before being hidden; the final visible count must be zero.
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`Result: ${ok ? 'PASS' : 'FAIL'} (${leaked} unexpected visible-window observations; ${left.length} remain)`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
