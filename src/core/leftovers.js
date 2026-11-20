'use strict';
/**
 * Provably safe cleanup of leftover artifacts from older ApkStart versions:
 *   - Old `ApkStart*` directories containing `ApkStart.exe` (never touching the running `installDir`)
 *   - Dead Windows Uninstall registry entries whose `InstallLocation` or uninstaller no longer exists
 *   - Temporary update archives in `%APPDATA%\apkstart\update` and `%TEMP%`
 *   - Legacy `default_boot` and `*.stale-*` quickboot snapshots (never touching active `apkstart` snapshot)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* Locked or inaccessible; skip */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

function candidateRoots(installDir) {
  const roots = new Set();
  const parent = path.dirname(installDir);
  if (parent) roots.add(parent);
  const local = process.env.LOCALAPPDATA;
  if (local) roots.add(path.join(local, 'Programs'));
  const pf = process.env.ProgramFiles;
  if (pf) roots.add(pf);
  return [...roots];
}

function scanDirs(installDir) {
  const out = [];
  const cur = norm(installDir);
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      const full = path.join(root, e.name);
      if (norm(full) === cur) continue;
      if (!fs.existsSync(path.join(full, EXE))) continue;
      out.push({
        kind: 'dir',
        subkind: 'app-dir',
        path: full,
        size: dirSize(full),
        note: `Old ApkStart installation directory (contains ${EXE})`,
      });
    }
  }
  return out;
}

function scanRegistry() {
  if (process.platform !== 'win32') return [];
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `Orphaned Uninstall registry entry${disp ? `: ${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'Temporary update package' });
    }
  }
  return out;
}

function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'snapshot',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot')
        ? 'Legacy default_boot quickboot snapshot'
        : 'Obsolete snapshot remnant',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir, avdHome } = {}) {
  const cur = norm(installDir || '');
  const snapRoot = avdHome ? norm(path.join(avdHome, 'apkstart.avd', 'snapshots')) : '';
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'Cannot delete the currently running version' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: `Directory does not contain ${EXE}` }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Files are in use by another process' });
      } else if (it.kind === 'snapshot') {
        const target = norm(it.path);
        if (path.basename(target) === 'apkstart') {
          failed.push({ path: it.path, reason: 'Active apkstart snapshot is protected' });
          continue;
        }
        if (snapRoot && !target.startsWith(snapRoot + path.sep)) {
          failed.push({ path: it.path, reason: 'Snapshot path outside AVD directory' });
          continue;
        }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'Snapshot files are locked by running VM' });
      } else if (it.kind === 'registry') {
        execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'File is currently locked' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Failed to remove shortcut' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
