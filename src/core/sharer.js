'use strict';
/**
 * Bidirectional PC <-> Android folder synchronization.
 *
 * Syncs `settings.sharedDir` on Windows with `/sdcard/ApkStartShared` inside Android
 * over ADB (`push` / `pull`) whenever at least one Android app window is active.
 *
 * Security invariants:
 *   - Relative paths returned by the Android guest are treated as untrusted input:
 *     any segment containing `..`, `\`, drive prefixes, or NUL bytes is rejected
 *     before constructing a host path (`resolveSafeLocalPath`), preventing guest-to-host
 *     path traversal on Windows.
 *   - Remote shell paths are escaped with POSIX `shQuote` rather than interpolated.
 *   - Files larger than `MAX_SYNC_BYTES` (512 MB) are skipped to protect host disk space.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { shQuote } = require('./adb');

const MAX_SYNC_BYTES = 512 * 1024 * 1024;
const SKIP_NAMES = /^\.|^desktop\.ini$|^thumbs\.db$|\.part$|\.crdownload$|\.tmp$/i;

function isSafeRel(rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return false;
  if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel)) return false;
  const parts = rel.split(/[\\/]/);
  if (!parts.length) return false;
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..') return false;
    // Reject Windows invalid filename characters in individual segments (prevents ADS `:` tricks too)
    if (/[<>:"|?*]/.test(seg)) return false;
  }
  return true;
}

function resolveSafeLocalPath(baseDir, rel) {
  if (!isSafeRel(rel)) return null;
  const normalizedRel = rel.split(/[\\/]/).join(path.sep);
  const root = path.resolve(baseDir);
  const full = path.resolve(root, normalizedRel);
  if (full === root || !full.startsWith(root + path.sep)) return null;
  return full;
}

class Sharer {
  constructor(runtime) {
    this.runtime = runtime;
    this.timer = null;
    this.busy = false;
    this.stateFile = path.join(store.DATA_DIR, 'shared-state.json');
  }

  get localDir() { return store.getSettings().sharedDir; }
  get remoteDir() { return store.getSettings().deviceSharedDir || '/sdcard/ApkStartShared'; }

  loadState() {
    try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch (_) { return {}; }
  }

  saveState(s) {
    const tmp = `${this.stateFile}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
      fs.renameSync(tmp, this.stateFile);
    } catch (_) {
      try { fs.rmSync(tmp, { force: true }); } catch (__) { /* ignore */ }
    }
  }

  walkLocal(dir, base = dir, depth = 0) {
    const out = [];
    if (depth > 4 || !fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_NAMES.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...this.walkLocal(full, base, depth + 1));
      } else if (ent.isFile()) {
        const st = fs.statSync(full);
        const rel = path.relative(base, full).replace(/\\/g, '/');
        out.push({ rel, full, size: st.size, mtime: Math.floor(st.mtimeMs) });
      }
    }
    return out;
  }

  async listRemoteRecursive(client, base) {
    try {
      const q = shQuote(base);
      const out = await client.shell(
        `cd ${q} 2>/dev/null && find . -maxdepth 4 -type f -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`,
        { timeout: 15000 },
      );
      const list = [];
      for (const line of out.split('\n')) {
        const m = /^(\d+)\|(\d+)\|\.?\/?(.+)$/.exec(line.trim());
        if (!m) continue;
        const rel = m[3];
        if (!isSafeRel(rel)) continue;
        const baseName = rel.split('/').pop();
        if (SKIP_NAMES.test(baseName)) continue;
        list.push({ rel, size: Number(m[1]), mtime: Number(m[2]) * 1000 });
      }
      if (list.length) return list;
    } catch (_) { /* Fallback when toybox find/stat behaves differently */ }

    const items = await client.listRemote(base);
    return items
      .filter((x) => !x.isDir && isSafeRel(x.name) && !SKIP_NAMES.test(x.name))
      .map((x) => ({ rel: x.name, size: x.size, mtime: 0 }));
  }

  async sync({ onLog } = {}) {
    if (this.busy) return { skipped: true };
    const c = this.runtime.client();
    if (!(await c.isOnline())) return { offline: true };

    this.busy = true;
    const log = (m) => onLog && onLog(m);
    const pushed = [];
    const pulled = [];

    try {
      fs.mkdirSync(this.localDir, { recursive: true });
      await c.shellMkdir(this.remoteDir);

      const state = this.loadState();
      const localFiles = this.walkLocal(this.localDir);
      const localMap = new Map(localFiles.map((f) => [f.rel, f]));

      const rawRemote = (await c.listRemoteStat(this.remoteDir))
        || (await this.listRemoteRecursive(c, this.remoteDir));
      const remoteFiles = [];
      for (const r of rawRemote) {
        if (!isSafeRel(r.rel)) {
          log(`Blocked unsafe guest relative path: ${r.rel}`);
          continue;
        }
        remoteFiles.push(r);
      }
      const remoteMap = new Map(remoteFiles.map((f) => [f.rel, f]));

      // 1) Host -> Android: new or modified local files
      for (const f of localFiles) {
        if (f.size > MAX_SYNC_BYTES) continue;
        const prev = state[f.rel];
        const rem = remoteMap.get(f.rel);
        const changedLocal = !prev || prev.mtime !== f.mtime || prev.size !== f.size;
        if (!rem || (changedLocal && (!rem.mtime || f.mtime > rem.mtime + 1500))) {
          const remote = path.posix.join(this.remoteDir, f.rel);
          const remoteParent = path.posix.dirname(remote);
          await c.shell(`mkdir -p ${shQuote(remoteParent)}`);
          await c.push(f.full, remote);
          state[f.rel] = { size: f.size, mtime: f.mtime, remoteMtime: null, dir: 'up' };
          pushed.push(f.rel);
          log(`↑ Synced to Android: ${f.rel}`);
        }
      }

      // 2) Android -> Host: new or modified guest files
      for (const r of remoteFiles) {
        if (SKIP_NAMES.test(r.rel.split('/').pop())) continue;
        if (r.size > MAX_SYNC_BYTES) continue;
        if (pushed.includes(r.rel)) continue;
        const loc = localMap.get(r.rel);
        const prev = state[r.rel];

        // Baseline remoteMtime on the first observation after a host upload so
        // identical uploads are not bounced back, while later guest edits (even of equal size) DO sync.
        if (loc && prev && prev.dir === 'up' && prev.size === r.size && prev.remoteMtime == null) {
          prev.remoteMtime = r.mtime || 0;
          continue;
        }

        const remoteNewer = !loc
          || (!prev && r.size !== loc.size)
          || (prev && (
            r.size !== prev.size
            || (r.mtime > 0 && prev.dir === 'up' && prev.remoteMtime != null && r.mtime > prev.remoteMtime + 2000)
            || (r.mtime > 0 && prev.dir !== 'up' && r.mtime > (prev.remoteMtime ?? prev.mtime) + 2000)
          ));
        if (!remoteNewer) continue;

        const dest = resolveSafeLocalPath(this.localDir, r.rel);
        if (!dest) {
          log(`Skipped unsafe destination path for ${r.rel}`);
          continue;
        }
        await c.pull(path.posix.join(this.remoteDir, r.rel), dest);
        const st = fs.statSync(dest);
        state[r.rel] = { size: st.size, mtime: Math.floor(st.mtimeMs), remoteMtime: r.mtime, dir: 'down' };
        pulled.push(r.rel);
        log(`↓ Pulled from Android: ${r.rel}`);
      }

      this.saveState(state);
      return { ok: true, pushed, pulled };
    } finally {
      this.busy = false;
    }
  }

  syncOnce(options = {}) { return this.sync(options); }

  async pushFileNow(filePath) {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error('Select an existing file to send to Android.');
    }
    const client = this.runtime.client();
    if (!(await client.isOnline())) throw new Error('Android runtime is not online.');
    await client.shellMkdir(this.remoteDir);
    const name = path.basename(filePath);
    const remote = path.posix.join(this.remoteDir, name);
    await client.push(filePath, remote);
    return { local: filePath, remote, name };
  }

  start(intervalMs = 8000) {
    this.stop();
    this.timer = setInterval(() => {
      this.sync().catch(() => { /* Runtime offline or restarting; retry next tick */ });
    }, intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Sharer, isSafeRel, resolveSafeLocalPath, MAX_SYNC_BYTES };
