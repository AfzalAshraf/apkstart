'use strict';
/**
 * Zero-dependency HTTP/HTTPS downloader with redirect following, Range resume,
 * multi-connection chunked downloads (`downloadParallel`), multi-origin stripe/failover
 * downloads (`downloadMulti`), stall/slow-source rotation, and SHA-256 verification.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const UA = 'ApkStart/0.4 (+https://github.com/RoutineMiku/apkstart)';

function client(url) {
  return url.startsWith('https:') ? https : http;
}

function resolveRedirect(base, location) {
  try { return new URL(location, base).toString(); } catch (_) { return location; }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function verifyChecksum(dest, expectSha256) {
  if (!expectSha256) return;
  const got = await sha256File(dest);
  if (got.toLowerCase() !== expectSha256.toLowerCase()) {
    try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
    throw new Error(`Checksum mismatch (expected ${expectSha256.slice(0, 12)}..., got ${got.slice(0, 12)}...)`);
  }
}

/**
 * Single-stream HTTP/HTTPS download with `.part` resume and redirect handling.
 */
async function download(url, dest, opts = {}) {
  const part = `${dest}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (fs.existsSync(dest) && opts.expectSha256) {
    const got = await sha256File(dest);
    if (got.toLowerCase() === opts.expectSha256.toLowerCase()) return dest;
    fs.unlinkSync(dest);
  }

  let startAt = fs.existsSync(part) ? fs.statSync(part).size : 0;

  const fetchOnce = (currentUrl, hops = 0) => new Promise((resolve, reject) => {
    if (hops > 8) return reject(new Error('Too many HTTP redirects'));
    if (opts.signal?.aborted) return reject(new Error('Download cancelled'));

    const headers = { 'User-Agent': UA };
    if (startAt > 0) headers.Range = `bytes=${startAt}-`;

    const req = client(currentUrl).get(currentUrl, { headers, timeout: 30000 }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        cleanupAbort();
        return resolve(fetchOnce(resolveRedirect(currentUrl, res.headers.location), hops + 1));
      }

      if (code === 416) {
        res.resume();
        cleanupAbort();
        return resolve('done');
      }

      if (startAt > 0 && code === 200) {
        startAt = 0;
      } else if (code !== 200 && code !== 206) {
        res.resume();
        cleanupAbort();
        return reject(new Error(`Download failed: HTTP ${code}`));
      }

      const contentLen = Number(res.headers['content-length'] || 0);
      const total = contentLen ? startAt + contentLen : 0;
      let received = startAt;
      let lastTick = Date.now();
      let lastBytes = received;

      const out = fs.createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' });
      res.on('data', (chunk) => {
        received += chunk.length;
        const now = Date.now();
        if (opts.onProgress && now - lastTick >= 180) {
          const dt = (now - lastTick) / 1000;
          const speed = dt > 0 ? (received - lastBytes) / dt : 0;
          lastTick = now;
          lastBytes = received;
          opts.onProgress({
            received,
            total,
            percent: total ? Math.min(99, Math.round((received / total) * 100)) : null,
            speed,
          });
        }
      });
      res.pipe(out);
      out.on('finish', () => { cleanupAbort(); out.close(() => resolve('ok')); });
      const onErr = (err) => { cleanupAbort(); out.destroy(); reject(err); };
      res.on('error', onErr);
      out.on('error', onErr);
    });

    const onAbort = () => req.destroy(new Error('Download cancelled'));
    const cleanupAbort = () => {
      if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    req.on('timeout', () => { cleanupAbort(); req.destroy(new Error('Connection timed out')); });
    req.on('error', (err) => { cleanupAbort(); reject(err); });
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
  });

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await fetchOnce(url);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      startAt = fs.existsSync(part) ? fs.statSync(part).size : 0;
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }
  if (lastErr) throw lastErr;

  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(part, dest);
  await verifyChecksum(dest, opts.expectSha256);

  if (opts.onProgress) {
    const sz = fs.statSync(dest).size;
    opts.onProgress({ received: sz, total: sz, percent: 100, speed: 0 });
  }
  return dest;
}

function head(url, hops = 0) {
  return new Promise((resolve) => {
    if (hops > 6) return resolve({ size: 0, finalUrl: url, acceptRanges: false });
    const req = client(url).request(url, { method: 'HEAD', headers: { 'User-Agent': UA }, timeout: 10000 }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        return resolve(head(resolveRedirect(url, res.headers.location), hops + 1));
      }
      const size = Number(res.headers['content-length'] || 0);
      const acceptRanges = /bytes/i.test(String(res.headers['accept-ranges'] || ''));
      res.resume();
      resolve({ size: code === 200 ? size : 0, finalUrl: url, acceptRanges });
    });
    req.on('error', () => resolve({ size: 0, finalUrl: url, acceptRanges: false }));
    req.on('timeout', () => { req.destroy(); resolve({ size: 0, finalUrl: url, acceptRanges: false }); });
    req.end();
  });
}

function probeRange(url, hops = 0) {
  return new Promise((resolve) => {
    if (hops > 6) return resolve({ ok: false, size: 0, finalUrl: url });
    const req = client(url).get(url, {
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
      timeout: 12000,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        return resolve(probeRange(resolveRedirect(url, res.headers.location), hops + 1));
      }
      const cr = String(res.headers['content-range'] || '');
      const m = /bytes\s+0-0\/(\d+)/i.exec(cr);
      res.destroy();
      if (code === 206 && m) {
        return resolve({ ok: true, size: Number(m[1]), finalUrl: url });
      }
      resolve({ ok: false, size: 0, finalUrl: url });
    });
    req.on('error', () => resolve({ ok: false, size: 0, finalUrl: url }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, size: 0, finalUrl: url }); });
  });
}

function fetchRange(url, fd, start, end, onBytes, {
  hops = 0,
  idleMs = 15000,
  slowAfterMs = 0,
  slowBps = 48 * 1024,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    if (hops > 6) return reject(new Error('Too many redirects'));
    if (signal?.aborted) return reject(new Error('Download cancelled'));
    const expect = end - start + 1;
    let pos = start;
    const t0 = Date.now();
    let lastDataAt = t0;

    const req = client(url).get(url, {
      headers: { 'User-Agent': UA, Range: `bytes=${start}-${end}` },
      timeout: idleMs,
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        clearWatch();
        return resolve(fetchRange(resolveRedirect(url, res.headers.location), fd, start, end, onBytes, {
          hops: hops + 1, idleMs, slowAfterMs, slowBps, signal,
        }));
      }
      if (code !== 206) {
        res.resume();
        clearWatch();
        return reject(new Error(`Server did not return 206 Partial Content (HTTP ${code})`));
      }
      res.on('data', (chunk) => {
        lastDataAt = Date.now();
        try {
          fs.writeSync(fd, chunk, 0, chunk.length, pos);
          pos += chunk.length;
          if (onBytes) onBytes(chunk.length);
        } catch (e) {
          clearWatch();
          req.destroy(e);
        }
      });
      res.on('end', () => {
        clearWatch();
        if (pos - start !== expect) {
          return reject(new Error(`Incomplete range chunk (${pos - start}/${expect})`));
        }
        resolve();
      });
      res.on('error', (e) => { clearWatch(); reject(e); });
    });

    const onAbort = () => req.destroy(new Error('Download cancelled'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    const watch = setInterval(() => {
      const now = Date.now();
      if (now - lastDataAt > idleMs) {
        req.destroy(new Error(`Chunk stalled (${Math.round((now - lastDataAt) / 1000)}s without data)`));
        return;
      }
      if (slowAfterMs > 0 && now - t0 > slowAfterMs) {
        const bps = ((pos - start) * 1000) / Math.max(1, now - t0);
        if (bps < slowBps) {
          req.destroy(new Error(`Throughput too low (${Math.round(bps / 1024)} KB/s)`));
        }
      }
    }, Math.min(2000, Math.max(250, Math.floor(idleMs / 3))));
    if (watch.unref) watch.unref();
    const clearWatch = () => {
      clearInterval(watch);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };

    req.on('timeout', () => { clearWatch(); req.destroy(new Error('Chunk request timed out')); });
    req.on('error', (e) => { clearWatch(); reject(e); });
  });
}

/**
 * Multi-connection chunked Range download (falls back to single-stream `download()`
 * automatically if the server ignores Range or the payload is small).
 */
async function downloadParallel(url, dest, opts = {}) {
  const conns = Math.max(1, Math.min(16, Number(opts.connections) || 8));
  const minChunk = opts.minChunk || 2 * 1024 * 1024;
  if (conns <= 1) return download(url, dest, opts);

  if (fs.existsSync(dest) && opts.expectSha256) {
    const got = await sha256File(dest);
    if (got.toLowerCase() === opts.expectSha256.toLowerCase()) return { dest, parallel: 0, cached: true };
    fs.unlinkSync(dest);
  }

  const probe = await probeRange(url);
  if (!probe.ok || probe.size < minChunk * 2) {
    return download(url, dest, opts);
  }

  const total = probe.size;
  const finalUrl = probe.finalUrl;
  const n = Math.min(conns, Math.max(2, Math.floor(total / minChunk)));
  const per = Math.ceil(total / n);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const fd = fs.openSync(part, 'w');
  fs.ftruncateSync(fd, total);

  let received = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const report = (delta) => {
    received += delta;
    const now = Date.now();
    if (opts.onProgress && now - lastTick >= 160) {
      const dt = (now - lastTick) / 1000;
      const speed = dt > 0 ? (received - lastBytes) / dt : 0;
      lastTick = now;
      lastBytes = received;
      opts.onProgress({
        received,
        total,
        percent: Math.min(99, Math.round((received / total) * 100)),
        speed,
        connections: n,
      });
    }
  };

  try {
    const tasks = [];
    for (let i = 0; i < n; i++) {
      const s = i * per;
      const e = Math.min(total - 1, s + per - 1);
      if (s > e) break;
      tasks.push((async () => {
        let lastErr;
        for (let a = 1; a <= 4; a++) {
          if (opts.signal?.aborted) throw new Error('Download cancelled');
          let chunkGot = 0;
          try {
            await fetchRange(finalUrl, fd, s, e, (b) => { chunkGot += b; report(b); }, {
              signal: opts.signal,
            });
            return;
          } catch (err) {
            lastErr = err;
            received = Math.max(0, received - chunkGot);
            if (opts.signal?.aborted) throw err;
            await new Promise((r) => setTimeout(r, 600 * a));
          }
        }
        throw lastErr;
      })());
    }
    await Promise.all(tasks);
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(part); } catch (_) { /* ignore */ }
    if (opts.signal?.aborted) throw e;
    return download(url, dest, opts);
  }

  fs.closeSync(fd);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  fs.renameSync(part, dest);
  await verifyChecksum(dest, opts.expectSha256);

  if (opts.onProgress) {
    opts.onProgress({ received: total, total, percent: 100, speed: 0, connections: n });
  }
  return { dest, parallel: n };
}

/**
 * Multi-source chunked download with sidecar `.chunks.json` resume state,
 * dynamic slow/stalled mirror rotation, cancellation support, and SHA-256 verification.
 */
async function downloadMulti(urls, dest, opts = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('No candidate download URLs provided');
  if (list.length === 1) return downloadParallel(list[0], dest, opts);

  if (fs.existsSync(dest) && opts.expectSha256) {
    const got = await sha256File(dest);
    if (got.toLowerCase() === opts.expectSha256.toLowerCase()) return { dest, parallel: 0, cached: true };
    fs.unlinkSync(dest);
  }

  const conns = Math.max(1, Math.min(16, Number(opts.connections) || 8));
  const minChunk = opts.minChunk || 2 * 1024 * 1024;

  const probes = await Promise.all(list.map((u) => probeRange(u).then((p) => ({ url: u, ...p }))));
  const ranged = probes.filter((p) => p.ok && p.size > 0);
  if (!ranged.length) {
    let lastErr;
    for (const u of list) {
      if (opts.signal?.aborted) throw new Error('Download cancelled');
      try { return await download(u, dest, opts); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All download sources failed');
  }

  const total = ranged[0].size;
  const good = ranged.filter((p) => p.size === total).map((p) => p.finalUrl);

  if (total < minChunk * 2 || conns <= 1) {
    return download(good[0], dest, opts);
  }
  if (good.length === 1) {
    return downloadParallel(good[0], dest, opts);
  }

  const n = Math.min(Math.max(conns, good.length * 2), Math.max(2, Math.floor(total / minChunk)));
  const per = Math.ceil(total / n);
  const chunks = [];
  for (let i = 0; i < n; i += 1) {
    const s = i * per;
    const e = Math.min(total - 1, s + per - 1);
    if (s <= e) chunks.push({ s, e });
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const sidecar = `${dest}.chunks.json`;
  const doneSet = new Set();
  let resumed = false;
  if (fs.existsSync(dest) && fs.existsSync(sidecar)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      const st = fs.statSync(dest);
      if (meta && meta.total === total && meta.n === chunks.length
        && st.size === total && Array.isArray(meta.done)) {
        for (const off of meta.done) doneSet.add(Number(off));
        resumed = doneSet.size > 0;
      }
    } catch (_) { /* Corrupted sidecar; restart cleanly */ }
  }

  const fd = fs.openSync(dest, resumed ? 'r+' : 'w');
  if (!resumed) fs.ftruncateSync(fd, total);

  const saveSidecar = () => {
    try {
      fs.writeFileSync(sidecar, JSON.stringify({
        total, n: chunks.length, done: [...doneSet],
      }));
    } catch (_) { /* ignore */ }
  };

  let received = 0;
  for (const c of chunks) {
    if (doneSet.has(c.s)) received += (c.e - c.s + 1);
  }
  let lastTick = Date.now();
  let lastBytes = received;
  const report = (delta) => {
    received += delta;
    const now = Date.now();
    if (opts.onProgress && now - lastTick >= 160) {
      const dt = (now - lastTick) / 1000;
      const speed = dt > 0 ? (received - lastBytes) / dt : 0;
      lastTick = now;
      lastBytes = received;
      opts.onProgress({
        received,
        total,
        percent: Math.min(99, Math.round((received / total) * 100)),
        speed,
        connections: Math.min(conns, chunks.length),
        sources: good.length,
        resumed,
      });
    }
  };

  const pending = chunks.filter((c) => !doneSet.has(c.s));
  const scores = new Array(good.length).fill(0);
  let rr = 0;
  const pickUrl = (avoid = -1) => {
    let best = -1;
    let bestScore = Infinity;
    for (let k = 0; k < good.length; k += 1) {
      const idx = (rr + k) % good.length;
      if (idx === avoid && good.length > 1) continue;
      if (scores[idx] < bestScore) { bestScore = scores[idx]; best = idx; }
    }
    rr = (rr + 1) % good.length;
    return best >= 0 ? best : 0;
  };

  const idleMs = opts.idleMs || 15000;
  const slowAfterMs = opts.slowAfterMs ?? (good.length > 1 ? 8000 : 0);
  const slowBps = opts.slowBps || 48 * 1024;
  const maxAttempts = Math.max(opts.retries || 0, good.length * 3, 6);

  let cursor = 0;
  const workers = Math.min(conns, Math.max(1, pending.length));
  try {
    await Promise.all(Array.from({ length: workers }, async () => {
      while (cursor < pending.length) {
        if (opts.signal?.aborted) throw new Error('Download cancelled');
        const my = cursor;
        cursor += 1;
        const { s, e } = pending[my];
        let lastErr;
        let lastIdx = -1;
        for (let a = 0; a < maxAttempts; a += 1) {
          if (opts.signal?.aborted) throw new Error('Download cancelled');
          const idx = pickUrl(lastIdx);
          lastIdx = idx;
          const u = good[idx];
          let got = 0;
          try {
            // eslint-disable-next-line no-await-in-loop
            await fetchRange(u, fd, s, e, (b) => { got += b; report(b); }, {
              idleMs,
              slowAfterMs: a < good.length ? slowAfterMs : 0,
              slowBps,
              signal: opts.signal,
            });
            scores[idx] = Math.max(0, scores[idx] - 1);
            doneSet.add(s);
            saveSidecar();
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            scores[idx] += 2;
            received = Math.max(0, received - got);
            if (opts.signal?.aborted) throw err;
          }
        }
        if (lastErr) throw lastErr;
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    saveSidecar();
    throw e;
  }

  fs.closeSync(fd);
  try { fs.unlinkSync(sidecar); } catch (_) { /* ignore */ }
  await verifyChecksum(dest, opts.expectSha256);

  if (opts.onProgress) {
    opts.onProgress({
      received: total, total, percent: 100, speed: 0,
      connections: workers, sources: good.length, resumed,
    });
  }
  return { dest, parallel: workers, sources: good.length, multi: true, resumed };
}

module.exports = { download, downloadParallel, downloadMulti, head, probeRange, sha256File };
