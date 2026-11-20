'use strict';
/**
 * Dual-origin release discovery & mirror throughput ranking (`GitHub` + `Gitee`).
 *
 * Features:
 *   - Queries GitHub and Gitee Releases concurrently, merging multi-part assets (`.part1..N`)
 *     and choosing the highest release version across origins;
 *   - Benchmarks candidate download URLs with a real 256 KB Range transfer (`probeSpeed`),
 *     sorting mirrors by actual throughput rather than ping;
 *   - Applies a 15-minute circuit breaker on 401/403/429 rate-limited origins and falls back
 *     to stale cached metadata when all origins are temporarily offline.
 */
const http = require('http');
const https = require('https');
const { cmpVer } = require('./version');

const UA = 'ApkStart-Updater/1.0 (+https://github.com/RoutineMiku/apkstart)';

const REPOS = {
  github: {
    name: 'GitHub',
    owner: 'RoutineMiku',
    repo: 'apkstart',
    api: 'https://api.github.com/repos/RoutineMiku/apkstart/releases?per_page=8',
    web: 'https://github.com/RoutineMiku/apkstart/releases',
  },
  gitee: {
    name: 'Gitee',
    owner: 'daily-miku',
    repo: 'apkstart',
    api: 'https://gitee.com/api/v5/repos/daily-miku/apkstart/releases?per_page=8&direction=desc',
    web: 'https://gitee.com/daily-miku/apkstart/releases',
  },
};

const PUBLIC_GH_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

function client(url) { return url.startsWith('https:') ? https : http; }

function resolveRedirect(base, loc) {
  try { return new URL(loc, base).toString(); } catch (_) { return loc; }
}

function getJson(url, { timeout = 8000, headers = {} } = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('Too many redirects'));
    let host = url;
    try { host = new URL(url).host; } catch (_) { /* ignore */ }
    const req = client(url).get(url, {
      timeout,
      headers: {
        'User-Agent': UA,
        Accept: 'application/vnd.github+json, application/json',
        ...headers,
      },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        return resolve(getJson(resolveRedirect(url, res.headers.location), { timeout, headers }, hops + 1));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size < 4 * 1024 * 1024) chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (code !== 200) {
          const hint = code === 403 ? ' (rate-limited)'
            : code === 404 ? ' (repository or release not found)' : '';
          const err = new Error(`${host} HTTP ${code}${hint}`);
          err.status = code;
          return reject(err);
        }
        try { resolve(JSON.parse(text)); } catch (_) { reject(new Error(`${host} returned invalid JSON`)); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`${host} connection timed out`)));
    req.on('error', (e) => reject(new Error(`${host}: ${e.message}`)));
  });
}

function pickBestRelease(list) {
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const r of list) {
    if (!r || r.draft || r.prerelease) continue;
    if (!r.tag_name) continue;
    if (!best || cmpVer(r.tag_name, best.tag_name) > 0) best = r;
  }
  return best;
}

const PART_RE = /^(.+)\.part(\d+)$/i;

function normalizeAssets(rawAssets, source) {
  const whole = new Map();
  const groups = new Map();

  for (const a of rawAssets || []) {
    const name = String(a && a.name || '');
    const url = a && a.browser_download_url;
    const size = Number(a && a.size) || 0;
    if (!name || !url) continue;
    if (!/^ApkStart/i.test(name)) continue;

    const pm = PART_RE.exec(name);
    if (pm) {
      const base = pm[1];
      const idx = Number(pm[2]);
      if (!idx) continue;
      if (!groups.has(base)) groups.set(base, new Map());
      groups.get(base).set(idx, { index: idx, name, size, url, source });
    } else {
      whole.set(name, { name, size, url, urls: [url], sizes: size ? { [url]: size } : {}, source });
    }
  }

  for (const [base, partsMap] of groups) {
    const indices = [...partsMap.keys()].sort((x, y) => x - y);
    const contiguous = indices[0] === 1 && indices.every((v, i) => v === i + 1);
    if (!contiguous) continue;
    const parts = indices.map((i) => partsMap.get(i));
    const total = parts.every((p) => p.size > 0) ? parts.reduce((s, p) => s + p.size, 0) : 0;
    if (whole.has(base)) {
      whole.get(base).parts = parts;
    } else {
      whole.set(base, {
        name: base,
        size: total,
        url: null,
        urls: [],
        sizes: {},
        parts,
        source,
        partial: true,
      });
    }
  }
  return whole;
}

function mergeReleases(results) {
  const ok = results.filter((r) => r && r.rel);
  if (!ok.length) return null;

  let topVer = ok[0].rel.tag_name;
  for (const r of ok.slice(1)) {
    if (cmpVer(r.rel.tag_name, topVer) > 0) topVer = r.rel.tag_name;
  }
  const sameVer = ok.filter((r) => cmpVer(r.rel.tag_name, topVer) === 0);
  const primary = sameVer.find((r) => r.source === 'github') || sameVer[0];

  const byName = new Map();
  for (const r of sameVer) {
    const map = normalizeAssets(r.rel.assets, r.source);
    for (const [name, item] of map) {
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          size: item.size,
          url: item.url,
          urls: [...(item.urls || [])],
          sizes: { ...(item.sizes || {}) },
          parts: item.parts ? item.parts.map((p) => ({ ...p, urls: [p.url] })) : null,
          sources: [r.source],
        });
      } else {
        const cur = byName.get(name);
        if (!cur.sources.includes(r.source)) cur.sources.push(r.source);
        for (const u of item.urls || []) {
          if (!cur.urls.includes(u)) cur.urls.push(u);
          if (item.sizes && item.sizes[u]) cur.sizes[u] = item.sizes[u];
        }
        if (!cur.url && item.url) cur.url = item.url;
        if (!cur.size && item.size) cur.size = item.size;
        if (item.parts) {
          if (!cur.parts) {
            cur.parts = item.parts.map((p) => ({ ...p, urls: [p.url] }));
          } else if (cur.parts.length === item.parts.length) {
            cur.parts.forEach((p, i) => {
              const u = item.parts[i].url;
              if (u && !p.urls.includes(u)) p.urls.push(u);
            });
          }
        }
      }
    }
  }

  return {
    version: String(primary.rel.tag_name).replace(/^[vV]/, ''),
    tag: primary.rel.tag_name,
    name: primary.rel.name || primary.rel.tag_name,
    notes: String(primary.rel.body || '').trim(),
    htmlUrl: primary.rel.html_url || primary.web,
    publishedAt: primary.rel.published_at || primary.rel.created_at || '',
    sources: sameVer.map((r) => ({ source: r.source, name: r.name, tag: r.rel.tag_name, web: r.web })),
    unreachable: results.filter((r) => r && r.error).map((r) => ({ source: r.source, name: r.name, error: r.error })),
    assets: [...byName.values()],
  };
}

function probeSpeed(url, { sampleBytes = 256 * 1024, timeoutMs = 4500 } = {}, hops = 0) {
  return new Promise((resolve) => {
    if (hops > 5) return resolve({ url, ok: false, speed: 0, error: 'redirects' });
    const t0 = Date.now();
    let got = 0;
    let firstByte = 0;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve({ url, ...r }); } };

    const req = client(url).get(url, {
      timeout: timeoutMs,
      headers: { 'User-Agent': UA, Range: `bytes=0-${sampleBytes - 1}` },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        settled = true;
        return resolve(probeSpeed(
          resolveRedirect(url, res.headers.location),
          { sampleBytes, timeoutMs },
          hops + 1,
        ));
      }
      if (code !== 200 && code !== 206) {
        res.destroy();
        return done({ ok: false, speed: 0, error: `HTTP ${code}` });
      }
      res.on('data', (chunk) => {
        if (!firstByte) firstByte = Date.now();
        got += chunk.length;
        if (got >= sampleBytes) {
          const dt = Math.max(0.05, (Date.now() - t0) / 1000);
          res.destroy();
          done({ ok: true, speed: Math.round(got / dt), bytes: got, rtt: firstByte - t0 });
        }
      });
      res.on('end', () => {
        if (got > 0) {
          const dt = Math.max(0.05, (Date.now() - t0) / 1000);
          done({ ok: true, speed: Math.round(got / dt), bytes: got, rtt: (firstByte || Date.now()) - t0 });
        } else {
          done({ ok: false, speed: 0, error: 'empty' });
        }
      });
      res.on('error', (e) => done({ ok: false, speed: 0, error: e.message }));
    });
    const hard = setTimeout(() => {
      req.destroy();
      if (got > 16 * 1024) {
        const dt = Math.max(0.05, (Date.now() - t0) / 1000);
        done({ ok: true, speed: Math.round(got / dt), bytes: got, rtt: (firstByte || Date.now()) - t0 });
      } else {
        done({ ok: false, speed: 0, error: 'timeout' });
      }
    }, timeoutMs);
    if (hard.unref) hard.unref();
    req.on('close', () => clearTimeout(hard));
    req.on('timeout', () => { req.destroy(); done({ ok: false, speed: 0, error: 'timeout' }); });
    req.on('error', (e) => { clearTimeout(hard); done({ ok: false, speed: 0, error: e.message }); });
  });
}

function isGitHubDownload(url) {
  return /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//i.test(url);
}

function withMirror(url, prefix) {
  const p = String(prefix || '').trim();
  if (!p) return url;
  return (p.endsWith('/') ? p : `${p}/`) + url;
}

class Sources {
  constructor(getSettings) {
    this.getSettings = typeof getSettings === 'function' ? getSettings : () => ({});
    this._rankCache = new Map();
    this._ttl = 5 * 60 * 1000;
    this._relCache = null;
    this._relTtl = 10 * 60 * 1000;
    this._blockUntil = new Map();
  }

  _rt() { return (this.getSettings() || {}).runtime || {}; }

  preference() {
    const p = this._rt().sourcePreference;
    return ['github', 'gitee'].includes(p) ? p : 'auto';
  }

  enabledSources() {
    const p = this.preference();
    if (p === 'github') return ['github'];
    if (p === 'gitee') return ['gitee'];
    return ['github', 'gitee'];
  }

  reset() {
    this._rankCache.clear();
    this._relCache = null;
    this._blockUntil.clear();
  }

  blockedReason(key) {
    const b = this._blockUntil.get(key);
    if (!b) return null;
    if (Date.now() >= b.until) { this._blockUntil.delete(key); return null; }
    const mins = Math.max(1, Math.round((b.until - Date.now()) / 60000));
    return `${b.reason} (temporarily skipped for ${mins} min)`;
  }

  async fetchReleases() {
    const token = String(this._rt().giteeToken || '').trim();
    const tasks = this.enabledSources().map(async (key) => {
      const cfg = REPOS[key];
      const blocked = this.blockedReason(key);
      if (blocked) return { source: key, name: cfg.name, web: cfg.web, error: blocked, skipped: true };
      const url = key === 'gitee' && token
        ? `${cfg.api}&access_token=${encodeURIComponent(token)}`
        : cfg.api;
      try {
        const list = await getJson(url, { timeout: 6500 });
        const rel = pickBestRelease(list);
        if (!rel) return { source: key, name: cfg.name, web: cfg.web, error: 'No published release found' };
        this._blockUntil.delete(key);
        return { source: key, name: cfg.name, web: cfg.web, rel };
      } catch (e) {
        if (e && (e.status === 403 || e.status === 429 || e.status === 401 || /\b(401|403|429)\b/.test(e.message))) {
          this._blockUntil.set(key, {
            until: Date.now() + 15 * 60 * 1000,
            reason: e.message,
          });
        }
        return { source: key, name: cfg.name, web: cfg.web, error: e.message };
      }
    });
    return Promise.all(tasks);
  }

  async latest({ force = false } = {}) {
    const now = Date.now();
    if (!force && this._relCache && now - this._relCache.at < this._relTtl) {
      return this._relCache.value;
    }
    const results = await this.fetchReleases();
    for (const r of results) {
      if (r && (r.status === 403 || r.status === 429 || /\b(403|429)\b/.test(r.error || '')) && !r.skipped) {
        this._blockUntil.set(r.source, {
          until: Date.now() + 15 * 60 * 1000,
          reason: r.error,
        });
      }
    }
    const merged = mergeReleases(results);
    if (!merged) {
      if (this._relCache) {
        return {
          ...this._relCache.value,
          stale: true,
          unreachable: results.map((r) => ({ source: r.source, name: r.name, error: r.error })),
        };
      }
      const detail = results.map((r) => `${r.name}: ${r.error || 'unavailable'}`).join('; ');
      throw new Error(`Unable to reach update sources (${detail})`);
    }
    this._relCache = { at: now, value: merged };
    return merged;
  }

  candidates(assetOrUrl) {
    const rt = this._rt();
    const raw = typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : [...(assetOrUrl.urls || []), assetOrUrl.url].filter(Boolean);
    const out = [];
    const add = (u) => { if (u && !out.includes(u)) out.push(u); };

    const custom = String(rt.mirrorPrefix || '').trim();
    const usePublic = rt.autoMirror !== false && !custom;

    for (const u of raw) {
      add(u);
      if (isGitHubDownload(u)) {
        if (custom) add(withMirror(u, custom));
        if (usePublic) {
          for (const m of PUBLIC_GH_MIRRORS) add(withMirror(u, m));
        }
      }
    }
    return out;
  }

  async rank(urls, onLog) {
    const uniq = [...new Set((urls || []).filter(Boolean))];
    if (uniq.length <= 1) return uniq;

    const now = Date.now();
    const results = await Promise.all(uniq.map(async (u) => {
      const hit = this._rankCache.get(u);
      if (hit && now - hit.at < this._ttl) return { url: u, ...hit };
      const r = await probeSpeed(u);
      this._rankCache.set(u, { at: now, ok: r.ok, speed: r.speed, rtt: r.rtt, error: r.error });
      return r;
    }));

    const anyOk = results.some((r) => r.ok);
    if (!anyOk) return uniq;

    results.sort((a, b) => (b.ok - a.ok) || (b.speed - a.speed));
    if (onLog) {
      const best = results[0];
      const mb = (best.speed / 1048576).toFixed(2);
      let host = best.url;
      try { host = new URL(best.url).host; } catch (_) { /* ignore */ }
      onLog(`Selected fastest mirror: ${host} (${mb} MB/s)`);
    }
    return results.map((r) => r.url);
  }
}

module.exports = {
  Sources, REPOS, PUBLIC_GH_MIRRORS,
  probeSpeed, normalizeAssets, mergeReleases, withMirror, isGitHubDownload,
};
