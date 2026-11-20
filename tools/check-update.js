'use strict';
/**
 * Update-flow self-test (does not publish a release or modify the current installation).
 *
 * 1) Read the latest GitHub release and select the right asset for the installed app type.
 * 2) Compare versions correctly.
 * 3) Execute the extract, replace, and restart script against a disposable fake installation.
 *
 * Usage: node tools/check-update.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Updater, cmpVer } = require('../src/core/updater');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`);

(async () => {
  let pass = true;
  const check = (c, m) => { ok(c, m); if (!c) pass = false; };

  // ---- 1. Version comparison ----
  check(cmpVer('v0.3.2', '0.3.1') === 1, 'v0.3.2 > 0.3.1');
  check(cmpVer('0.3.1', 'v0.3.1') === 0, 'A v prefix does not affect equality');
  check(cmpVer('v0.10.0', '0.9.9') === 1, '0.10.0 > 0.9.9 (numeric comparison, not string comparison)');
  check(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 < 1.0.1');

  // ---- 2. GitHub release ----
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upd-'));
  const install = path.join(sandbox, 'install');
  fs.mkdirSync(install, { recursive: true });

  const u = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  let info = null;
  try {
    info = await u.check();
    check(!!info && !!info.version, `Latest release found: ${info && info.tag}`);
    check(info.hasUpdate === true, 'Version 0.0.0 is reported as having an update');
    check(!!info.asset && /\.(zip|exe)$/i.test(info.asset.name), `Portable install selected asset ${info.asset && info.asset.name}`);
  } catch (e) {
    check(false, `GitHub check failed: ${e.message}`);
  }

  // An installed setup (with an uninstaller) should select Setup.exe.
  fs.writeFileSync(path.join(install, 'Uninstall ApkStart.exe'), 'stub');
  const u2 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  check(u2.flavor === 'setup', 'Detected setup install (Uninstall ApkStart.exe exists)');

  // ---- 3. Verify the update script can replace files ----
  const payload = path.join(sandbox, 'payload');
  fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload, 'resources', 'app', 'main.js'), 'new-main');
  fs.writeFileSync(path.join(install, 'ApkStart.exe'), 'old-exe');

  // Use a short-lived process as the old process to wait for.
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });

  const script = u.apply(
    { mode: 'zip', payload, version: '9.9.9' },
    { waitPid: decoy.pid, spawn: false },
  );
  check(/Copy-Item/.test(script) && /Wait-Process/.test(script), 'Script contains process-wait and file-replacement steps');

  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Do not Start-Process the fake ApkStart.exe; verify file replacement only.
  const body = script.replace(/if \(Test-Path[^\r\n]*relaunched' \}/, "'skipped relaunch'");
  const b64 = Buffer.from(body, 'utf16le').toString('base64');
  try {
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      stdio: 'ignore', timeout: 60000, windowsHide: true,
    });
  } catch (e) {
    check(false, `Update script execution failed: ${e.message}`);
  }
  await sleep(600);
  const newExe = fs.readFileSync(path.join(install, 'ApkStart.exe'), 'utf8');
  const newMain = fs.readFileSync(path.join(install, 'resources', 'app', 'main.js'), 'utf8');
  check(newExe === 'new-exe', 'ApkStart.exe in the install directory was replaced');
  check(newMain === 'new-main', 'Files in subdirectories were also replaced');

  // ---- 4. apply() starts a process to replace files (async path, no network) ----
  const install2 = path.join(sandbox, 'install2');
  const payload2 = path.join(sandbox, 'payload2');
  fs.mkdirSync(install2, { recursive: true });
  fs.mkdirSync(payload2, { recursive: true });
  fs.writeFileSync(path.join(install2, 'ApkStart.exe'), 'old-exe');
  fs.writeFileSync(path.join(install2, 'marker.txt'), 'old');
  fs.writeFileSync(path.join(payload2, 'ApkStart.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload2, 'marker.txt'), 'new');

  const u3 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install2, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  const decoy2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { stdio: 'ignore' });
  u3.apply({ mode: 'zip', payload: payload2, version: '9.9.8' }, { waitPid: decoy2.pid });
  let asyncOk = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      if (fs.readFileSync(path.join(install2, 'marker.txt'), 'utf8') === 'new') { asyncOk = true; break; }
    } catch (_) { /* Replacement is still in progress. */ }
  }
  check(asyncOk, 'apply() replaced files in a background process (async path works)');

  try { decoy.kill(); } catch (_) { /* ignore */ }
  try { decoy2.kill(); } catch (_) { /* ignore */ }
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log('');
  console.log(pass ? 'Result: PASS' : 'Result: one or more checks failed');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
