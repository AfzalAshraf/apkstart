'use strict';
/**
 * End-to-end check that launching the app shows only the ApkStart UI:
 *   1) Start ApkStart with a sandbox APPDATA directory (--smoke exits cleanly after 6.5 seconds).
 *   2) Add a dummy app record to trigger startup prewarming; the emulator cold-boots in the background.
 *   3) Watch visible windows throughout; the emulator, QEMU console, and netsim console must remain hidden.
 *   4) Keep watching for 8 seconds after ApkStart exits to ensure no Android Emulator window is left behind.
 *
 * Usage: node tools/check-quit-clean.js
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Users may move the runtime and Android data directory to another drive; point the test there with environment variables,
// to avoid downloading a 1.4 GB runtime or creating another empty AVD.
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const sandbox = path.join(require('os').tmpdir(), `apk-quit-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'apps.json'), JSON.stringify({
    apps: [{ package: 'com.example.demo', label: 'Demo', installedAt: Date.now() }],
  }));
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR },
    engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);
  console.log('Agent ready, port=', agent.port);

  // This environment sets ELECTRON_RUN_AS_NODE=1 globally (which makes Electron behave like plain Node);
  // remove the variable entirely; an empty value still counts as set and prevents Electron from starting.
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;

  const proc = spawn(ELECTRON, ['.', '--smoke', path.join(sandbox, 'smoke.png')], {
    cwd: ROOT,
    env,
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; });
  proc.stderr.on('data', (c) => { out += c; });

  let leaked = 0;
  let exitedAt = 0;
  for (let i = 0; i < 70; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const hit = ((r && r.list) || []).filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Visible unexpected windows:`, JSON.stringify(hit));
    }
    if (!exitedAt && proc.exitCode !== null) {
      exitedAt = i;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] ApkStart exited; continue watching for 8 seconds...`);
    }
    if (exitedAt && i - exitedAt >= 16) break;
  }

  const after = ((await agent.call({ cmd: 'windows' }, 5000).catch(() => null)) || {}).list || [];
  const left = after.filter(bad);
  console.log('Unexpected windows still visible after exit:', JSON.stringify(left));
  console.log('');
  const ok = leaked === 0 && left.length === 0;
  console.log(`Result: ${ok ? 'PASS (no unexpected visible windows)' : 'FAIL'}`);
  if (out) console.log('--- App output ---\n' + out.trim().split('\n').slice(-6).join('\n'));

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  // The sandbox AVD can be several gigabytes; remove it after the test (ignore errors if the emulator still holds files).
  try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
