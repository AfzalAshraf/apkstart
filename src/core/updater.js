'use strict';
/**
 * Self-updater (`Updater`): checks GitHub & Gitee Releases, downloads single or split
 * `.part1..N` release payloads with multi-mirror acceleration, and applies in-place updates
 * for both NSIS (`Setup.exe /S`) and Portable (`portable.zip`) installations.
 *
 * Security & reliability invariants:
 *   - Asset filenames are sanitized via `path.basename` before joining local paths;
 *   - `_extract` enforces strict path-boundary containment (`destAbs + path.sep`) against Zip-Slip;
 *   - Portable replacement retries `Copy-Item -ErrorAction Stop` inside `try/catch` so locked
 *     executables/DLLs never cause a half-copied installation to be treated as successful.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadMulti } = require('./download');
const { ZipFile } = require('./zip');
const { cmpVer } = require('./version');
const { Sources, REPOS } = require('./sources');

function psq(s) { return `'${String(s).replace(/'/g, "''")}'`; }

class Updater {
  constructor(opts) {
    this.currentVersion = opts.currentVersion || '0.0.0';
    this.exePath = opts.exePath;
    this.installDir = path.dirname(opts.exePath);
    this.isPackaged = !!opts.isPackaged;
    this.dataDir = opts.dataDir;
    this.onProgress = opts.onProgress || (() => {});
    this.sources = new Sources(opts.settings);
    this._ctrl = null;
    this._lastCheck = null;
    this._connectionsOverride = 0;
  }

  static repoUrl() { return REPOS.github.web; }

  get flavor() {
    if (!this.isPackaged) return 'dev';
    try {
      const un = fs.readdirSync(this.installDir).find((n) => /^Uninstall .*\.exe$/i.test(n));
      if (un) return 'setup';
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  _pickAsset(assets) {
    const appOnly = (assets || []).filter((a) => !/runtime/i.test(a.name));
    const setup = appOnly.find((a) => /Setup\.exe$/i.test(a.name));
    const portable = appOnly.find((a) => /portable.*\.zip$/i.test(a.name))
      || appOnly.find((a) => /\.zip$/i.test(a.name));
    return this.flavor === 'setup' ? (setup || portable) : (portable || setup);
  }

  async check({ force = false } = {}) {
    const merged = await this.sources.latest({ force });
    const hasUpdate = cmpVer(merged.version, this.currentVersion) > 0;
    const chosen = this._pickAsset(merged.assets);

    let asset = null;
    if (chosen) {
      const fullSize = (chosen.sizes && chosen.url && chosen.sizes[chosen.url]) || chosen.size || 0;
      asset = {
        name: path.basename(chosen.name),
        size: fullSize,
        sizes: chosen.sizes || {},
        url: chosen.url,
        urls: chosen.urls || [],
        parts: chosen.parts || null,
        sources: chosen.sources || [],
      };
    }

    const playable = !!(asset && ((asset.urls && asset.urls.length) || asset.url || asset.parts));
    const info = {
      current: this.currentVersion,
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      hasUpdate,
      flavor: this.flavor,
      sources: merged.sources,
      unreachable: merged.unreachable,
      stale: !!merged.stale,
      canAutoApply: this.isPackaged && playable,
      asset,
    };
    this._lastCheck = info;
    return info;
  }

  async download(asset, options = {}) {
    this.onProgress = options.onProgress || this.onProgress;
    const requestedConnections = Number(options.connections);
    this._connectionsOverride = Number.isFinite(requestedConnections) && requestedConnections > 0
      ? Math.max(1, Math.min(16, requestedConnections))
      : 0;
    const info = asset && asset.asset
      ? asset
      : {
        version: (asset && (asset.version || asset.tag)) || 'latest',
        hasUpdate: true,
        asset,
      };
    try {
      return await this.prepare(info, { signal: options.signal });
    } finally {
      this._connectionsOverride = 0;
    }
  }

  cancel() {
    if (this._ctrl) { this._ctrl.abort(); this._ctrl = null; }
  }

  _connections() {
    if (this._connectionsOverride) return this._connectionsOverride;
    const s = (this.sources.getSettings() || {}).runtime || {};
    return Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));
  }

  async prepare(info, { signal } = {}) {
    const it = info || this._lastCheck || (await this.check());
    if (!it.hasUpdate) throw new Error('ApkStart is already up to date');
    if (!it.asset) throw new Error('No automatic installer asset is attached to this release; please download manually.');

    const dir = path.join(this.dataDir, 'update', it.version);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const safeAssetName = path.basename(it.asset.name);
    const file = path.join(dir, safeAssetName);

    this._ctrl = new AbortController();
    if (signal) {
      if (signal.aborted) this._ctrl.abort();
      else signal.addEventListener('abort', () => this._ctrl && this._ctrl.abort(), { once: true });
    }
    const conns = this._connections();
    const totalHint = it.asset.size || 0;

    if ((it.asset.urls && it.asset.urls.length) || it.asset.url) {
      this.onProgress({ stage: 'probe', percent: 0, message: 'Benchmarking fastest download mirror...' });
      const ranked = await this.sources.rank(this.sources.candidates(it.asset));
      if (!ranked.length) throw new Error('No reachable download URLs available');
      const expectSize = (it.asset.sizes && it.asset.sizes[ranked[0]]) || 0;

      await downloadMulti(ranked, file, {
        connections: conns,
        signal: this._ctrl.signal,
        onProgress: (p) => this.onProgress({
          stage: 'download',
          percent: p.percent ?? (totalHint ? Math.min(99, Math.round((p.received / totalHint) * 100)) : 0),
          received: p.received,
          total: p.total || totalHint,
          speed: p.speed,
          connections: p.connections,
          sources: p.sources,
          message: `Downloading update (${p.sources > 1 ? `${p.sources} mirrors · ` : ''}${p.connections || 1} threads)...`,
        }),
      });
      if (expectSize > 0 && fs.statSync(file).size !== expectSize) {
        throw new Error('Downloaded update archive is incomplete; please check your connection and retry.');
      }
    } else if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, totalHint);
    } else {
      throw new Error('Release asset has no valid download URL');
    }
    this._ctrl = null;

    if (/\.exe$/i.test(safeAssetName)) {
      return { mode: 'setup', installer: file, version: it.version };
    }

    this.onProgress({ stage: 'extract', percent: 100, message: 'Extracting update package...' });
    const extracted = path.join(dir, 'payload');
    await this._extract(file, extracted);
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }

    const root = this._locatePayloadRoot(extracted);
    if (!fs.existsSync(path.join(root, 'ApkStart.exe'))) {
      throw new Error('Extracted update package does not contain ApkStart.exe; aborting replacement.');
    }
    return { mode: 'portable', payloadDir: root, workDir: dir, version: it.version };
  }

  async _downloadParts(asset, outFile, conns, totalHint) {
    const parts = asset.parts;
    const tmpDir = `${outFile}.parts`;
    fs.mkdirSync(tmpDir, { recursive: true });
    let doneBytes = 0;

    const firstRanked = await this.sources.rank(this.sources.candidates({ urls: parts[0].urls }));
    const order = (urls) => {
      const cands = this.sources.candidates({ urls });
      if (!firstRanked.length) return cands;
      let winnerOrigin = '';
      try { winnerOrigin = new URL(firstRanked[0]).origin; } catch (_) { /* ignore */ }
      return cands.sort((a, b) => {
        const wa = winnerOrigin && a.startsWith(winnerOrigin) ? 0 : 1;
        const wb = winnerOrigin && b.startsWith(winnerOrigin) ? 0 : 1;
        return wa - wb;
      });
    };

    const partFiles = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const pf = path.join(tmpDir, `part${p.index}`);
      const urls = i === 0 ? firstRanked : order(p.urls);
      // eslint-disable-next-line no-await-in-loop
      await downloadMulti(urls, pf, {
        connections: conns,
        signal: this._ctrl ? this._ctrl.signal : undefined,
        onProgress: (pr) => {
          const cur = doneBytes + (pr.received || 0);
          const pct = totalHint
            ? Math.min(99, Math.round((cur / totalHint) * 100))
            : Math.min(99, Math.round(((i + (pr.percent || 0) / 100) / parts.length) * 100));
          this.onProgress({
            stage: 'download',
            percent: pct,
            received: cur,
            total: totalHint,
            speed: pr.speed,
            message: `Downloading part ${i + 1}/${parts.length}...`,
          });
        },
      });
      const got = fs.statSync(pf).size;
      if (p.size && got !== p.size) {
        throw new Error(`Part ${i + 1} size mismatch (${got}/${p.size})`);
      }
      doneBytes += got;
      partFiles.push(pf);
    }

    this.onProgress({ stage: 'extract', percent: 99, message: 'Joining split archive parts...' });
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(outFile);
      out.on('error', reject);
      out.on('finish', resolve);
      (async () => {
        for (const pf of partFiles) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((res, rej) => {
            const r = fs.createReadStream(pf);
            r.on('error', rej);
            r.on('end', res);
            r.pipe(out, { end: false });
          });
          try { fs.unlinkSync(pf); } catch (_) { /* ignore */ }
        }
        out.end();
      })().catch((e) => { out.destroy(); reject(e); });
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (asset.size && fs.statSync(outFile).size !== asset.size) {
      throw new Error('Assembled archive size does not match manifest');
    }
  }

  async _extract(zipPath, dest) {
    const destAbs = path.resolve(dest);
    fs.mkdirSync(destAbs, { recursive: true });
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names();
      for (let i = 0; i < names.length; i++) {
        const n = names[i];
        if (!n || n.endsWith('/')) continue;
        const target = path.resolve(destAbs, n.replace(/\\/g, '/'));
        if (target !== destAbs && !target.startsWith(destAbs + path.sep)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await zf.pipeTo(n, fs.createWriteStream(target));
      }
    } finally {
      zf.close();
    }
  }

  _locatePayloadRoot(dir) {
    if (fs.existsSync(path.join(dir, 'ApkStart.exe'))) return dir;
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub);
      try {
        if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'ApkStart.exe'))) return p;
      } catch (_) { /* ignore */ }
    }
    return dir;
  }

  applyAndRestart(job, onRestart) {
    const result = this.apply(job);
    if (typeof onRestart === 'function') setTimeout(onRestart, 250).unref?.();
    return result;
  }

  apply(job) {
    const log = path.join(this.dataDir, 'logs', 'updater.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const script = path.join(this.dataDir, 'update', 'apply.ps1');
    fs.mkdirSync(path.dirname(script), { recursive: true });

    const header = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `$pid0 = ${process.pid}`,
      `$exe  = ${psq(this.exePath)}`,
      `$dst  = ${psq(this.installDir)}`,
      `$log  = ${psq(log)}`,
      'function Note($m) { Add-Content -LiteralPath $log -Value ("[" + (Get-Date -Format o) + "] " + $m) }',
      'Note "waiting for main process $pid0"',
      'for ($i = 0; $i -lt 90; $i++) {',
      '  if (-not (Get-Process -Id $pid0 -ErrorAction SilentlyContinue)) { break }',
      '  Start-Sleep -Milliseconds 500',
      '}',
      'Start-Sleep -Milliseconds 600',
    ];

    const body = job.mode === 'setup'
      ? [
        `$inst = ${psq(job.installer)}`,
        'Note "running NSIS installer $inst"',
        `$p = Start-Process -FilePath $inst -ArgumentList '/S', ('/D=' + $dst) -Wait -PassThru`,
        'Note ("installer exit=" + $p.ExitCode)',
        'Remove-Item -LiteralPath $inst -Force',
        'Start-Process -FilePath $exe',
      ]
      : [
        `$src  = ${psq(job.payloadDir)}`,
        `$work = ${psq(job.workDir)}`,
        'Note "copying portable payload $src -> $dst"',
        '$ok = $false',
        'for ($i = 1; $i -le 15; $i++) {',
        '  try {',
        '    Copy-Item -Path (Join-Path $src "*") -Destination $dst -Recurse -Force -ErrorAction Stop',
        '    $ok = $true; Note "copy pass $i ok"; break',
        '  } catch {',
        '    Note ("copy pass $i locked/failed: " + $_.Exception.Message)',
        '    Start-Sleep -Milliseconds 700',
        '  }',
        '}',
        'if ($ok) { Remove-Item -LiteralPath $work -Recurse -Force }',
        'Start-Process -FilePath $exe',
      ];

    fs.writeFileSync(script, '\ufeff' + [...header, ...body, 'Note "done"', ''].join('\r\n'), 'utf8');

    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-File', script,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, script, log };
  }
}

module.exports = { Updater, cmpVer };
