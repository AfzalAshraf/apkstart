'use strict';
/**
 * Runtime storage accounting & safe pruning (`layers.js`).
 *
 * Layered directory model:
 *  Layer 0 — `app/`              UI + Node core (read-only)
 *  Layer 1 — `platform-tools/`   ADB toolchain (~15 MB)
 *  Layer 2 — `emulator/`         QEMU2 + Ranchu engine (~450 MB)
 *  Layer 3 — `system-images/`    Read-only Android base image (~1.5 GB)
 *  Layer 4 — `avd/apkstart.avd/` Mutable `/data` overlay + quickboot snapshots (may live outside `root`!)
 *  Layer 5 — `_dl/`              Temporary download staging (safe to delete anytime)
 */
const fs = require('fs');
const path = require('path');

function dirSize(p) {
  if (!p || !fs.existsSync(p)) return 0;
  let st;
  try { st = fs.statSync(p); } catch (_) { return 0; }
  if (st.isFile()) return st.size;
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += dirSize(full);
    else if (e.isFile()) {
      try { total += fs.statSync(full).size; } catch (_) { /* ignore */ }
    }
  }
  return total;
}

function fmtBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function isInside(child, parent) {
  if (!child || !parent) return false;
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

/**
 * Scan runtime directories and return layer sizes + reclaimable cleanup candidates.
 * @param {string} root runtime root directory
 * @param {object} opts { activeSysImgDir, activeAvdName, avdHome, aggressive, includeSnapshots }
 */
function analyze(root, opts = {}) {
  const activeAvd = opts.activeAvdName || 'apkstart';
  const activeImg = opts.activeSysImgDir ? path.resolve(opts.activeSysImgDir) : null;
  const resolvedAvdHome = opts.avdHome ? path.resolve(opts.avdHome) : path.join(root, 'avd');
  const avdInsideRoot = isInside(resolvedAvdHome, root);

  const layers = [
    { id: 'platform-tools', name: 'ADB Toolchain', path: path.join(root, 'platform-tools') },
    { id: 'emulator', name: 'Emulator Engine', path: path.join(root, 'emulator') },
    { id: 'system-images', name: 'Android System Images', path: path.join(root, 'system-images') },
    { id: 'avd', name: 'User Data & Snapshots', path: resolvedAvdHome },
    { id: 'qemu', name: 'Standalone QEMU (Optional)', path: path.join(root, 'qemu') },
    { id: '_dl', name: 'Download Cache', path: path.join(root, '_dl') },
  ].map((l) => ({ ...l, size: dirSize(l.path) }));

  const seenPaths = new Set();
  const candidates = [];
  const addCandidate = (kind, p, reason) => {
    const key = path.resolve(p).toLowerCase();
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    candidates.push({ kind, path: p, size: dirSize(p), reason });
  };

  // 1) Temporary download cache `_dl`
  const dl = path.join(root, '_dl');
  if (fs.existsSync(dl)) {
    for (const f of fs.readdirSync(dl)) {
      addCandidate('dl-cache', path.join(dl, f), 'Completed or interrupted temporary download');
    }
  }

  // 2) Inactive system images (when multiple API levels/tags are installed).
  // If the caller did not provide the active image, preserve the newest image and
  // offer older/sibling images as reclaimable rather than silently keeping all of them.
  const sysRoot = path.join(root, 'system-images');
  if (fs.existsSync(sysRoot)) {
    const images = [];
    for (const api of fs.readdirSync(sysRoot)) {
      const apiDir = path.join(sysRoot, api);
      if (!fs.statSync(apiDir).isDirectory()) continue;
      for (const tag of fs.readdirSync(apiDir)) {
        const tagDir = path.join(apiDir, tag);
        if (!fs.statSync(tagDir).isDirectory()) continue;
        for (const abi of fs.readdirSync(tagDir)) {
          const full = path.resolve(path.join(tagDir, abi));
          if (!fs.existsSync(full)) continue;
          const apiNumber = Number((/\d+/.exec(api) || [0])[0]);
          const tagWeight = /playstore/i.test(tag) ? 300 : (/google_apis/i.test(tag) ? 200 : 100);
          images.push({ full, api, tag, abi, rank: apiNumber * 1000 + tagWeight });
        }
      }
    }
    const inferredActive = activeImg || (images.slice().sort((a, b) => b.rank - a.rank)[0] || {}).full;
    for (const image of images) {
      if (image.full !== inferredActive) {
        addCandidate('unused-sysimg', image.full, `Unused system image (${image.api}/${image.tag}/${image.abi})`);
      }
    }
  }

  // 3) AVD lock files, inactive AVDs, legacy `default_boot`, `*.stale-*`, and optional active snapshots
  const avdRoots = avdInsideRoot ? [resolvedAvdHome] : [resolvedAvdHome, path.join(root, 'avd')];
  for (const avdRoot of avdRoots) {
    if (!avdRoot || !fs.existsSync(avdRoot)) continue;
    for (const entry of fs.readdirSync(avdRoot)) {
      const full = path.join(avdRoot, entry);
      if (/\.lock$/i.test(entry)) {
        addCandidate('lock', full, 'Stale AVD lock file');
        continue;
      }
      if (!entry.endsWith('.avd')) continue;
      const name = entry.slice(0, -4);
      if (name !== activeAvd) {
        addCandidate('unused-avd', full, `Inactive virtual device (${name})`);
        continue;
      }
      for (const sub of fs.readdirSync(full)) {
        const sp = path.join(full, sub);
        if (/\.lock$/i.test(sub)) {
          addCandidate('lock', sp, 'Stale AVD lock file');
        } else if (/^cache\.img(\.qcow2)?$/i.test(sub)) {
          addCandidate('avd-cache', sp, 'Android /cache partition (regenerated automatically)');
        } else if (/^snapshots\.stale-/i.test(sub)) {
          addCandidate('snapshot', sp, 'Stale renamed snapshot directory');
        } else if (sub === 'snapshots') {
          if (opts.includeSnapshots) {
            addCandidate('snapshot', sp, 'Quickboot snapshots (saved RAM state; apps & data are preserved)');
          } else {
            try {
              for (const snap of fs.readdirSync(sp)) {
                if (snap !== 'apkstart') {
                  addCandidate('snapshot', path.join(sp, snap), `Legacy unused snapshot (${snap})`);
                }
              }
            } catch (_) { /* ignore */ }
          }
        }
      }
    }
  }

  // Non-x86_64 Windows QEMU binaries are not used by ApkStart and can be reclaimed.
  const windowsQemu = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (fs.existsSync(windowsQemu)) {
    for (const entry of fs.readdirSync(windowsQemu)) {
      if (/^qemu-system-(?!x86_64\.exe$)[^.]+.*\.exe$/i.test(entry)) {
        addCandidate('emu-trim', path.join(windowsQemu, entry), 'Unused non-x86_64 QEMU executable');
      }
    }
  }

  // 4) Optional emulator trimmings in aggressive mode
  if (opts.aggressive) {
    const emu = path.join(root, 'emulator');
    for (const rel of [
      ['qemu', 'linux-x86_64'],
      ['qemu', 'darwin-x86_64'],
      ['qemu', 'darwin-aarch64'],
      ['lib64', 'qt', 'translations'],
      ['resources', 'Toren1BD.pt'],
    ]) {
      const p = path.join(emu, ...rel);
      if (fs.existsSync(p)) {
        addCandidate('emu-trim', p, `Unused cross-platform emulator asset (${rel.join('/')})`);
      }
    }
  }

  const total = layers.reduce((s, l) => s + l.size, 0);
  const reclaimable = candidates.reduce((s, c) => s + c.size, 0);
  return { layers, candidates, total, reclaimable, fmtBytes };
}

/**
 * Execute pruning (`apply=false` performs a dry-run preview).
 * Allows paths inside `root` OR inside `opts.avdHome`.
 */
function prune(root, opts = {}) {
  const plan = analyze(root, opts);
  if (!opts.apply) return { ...plan, removed: [], saved: 0, dryRun: true };

  const resolvedRoot = path.resolve(root);
  const resolvedAvd = opts.avdHome ? path.resolve(opts.avdHome) : null;
  const removed = [];
  let saved = 0;

  for (const c of plan.candidates) {
    const target = path.resolve(c.path);
    const allowedInRoot = target !== resolvedRoot && isInside(target, resolvedRoot);
    const allowedInAvd = resolvedAvd && target !== resolvedAvd && isInside(target, resolvedAvd);
    if (!allowedInRoot && !allowedInAvd) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      if (c.kind === 'unused-avd') {
        const ini = target.replace(/\.avd$/i, '.ini');
        if (fs.existsSync(ini)) fs.rmSync(ini, { force: true });
      }
      removed.push(c);
      saved += c.size;
    } catch (_) { /* Locked by live process; skip safely */ }
  }
  return { ...plan, removed, saved, dryRun: false };
}

function summary(root, opts = {}) {
  const r = analyze(root, opts);
  return {
    total: r.total,
    totalText: fmtBytes(r.total),
    reclaimable: r.reclaimable,
    reclaimableText: fmtBytes(r.reclaimable),
    layers: r.layers.map((l) => ({ ...l, sizeText: fmtBytes(l.size) })),
    count: r.candidates.length,
  };
}

function verifyPreserved(root) {
  const missing = [];
  for (const rel of ['platform-tools/adb.exe', 'emulator/emulator.exe']) {
    if (!fs.existsSync(path.join(root, rel))) missing.push(rel);
  }
  const images = path.join(root, 'system-images');
  let imageFound = false;
  const walk = (dir, depth = 0) => {
    if (imageFound || depth > 5 || !fs.existsSync(dir)) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if ((files.has('kernel-ranchu') || files.has('kernel-ranchu-64'))
        && ['system.img', 'system.img.gz', 'system.img.xz'].some((name) => files.has(name))) {
      imageFound = true;
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
  };
  walk(images);
  if (!imageFound) missing.push('system-images/*/*/*/{kernel-ranchu,system.img}');
  return { ok: missing.length === 0, missing };
}

module.exports = { analyze, prune, summary, verifyPreserved, dirSize, fmtBytes };
