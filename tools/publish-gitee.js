'use strict';
/**
 * Publish a release to Gitee.
 *
 * Why this script exists: a single Gitee release attachment is limited to 100 MB (104,857,600 bytes;
 * uploads of 104,800,000 bytes have succeeded). A portable package compressed with 7-Zip is about 99.6 MB, so it can be uploaded as
 * one complete ZIP that users can extract directly instead of split part1/part2 files (which must be concatenated in order;
 * manual downloads cannot use them otherwise). Split only when the ZIP exceeds the limit; the app updater
 * supports both formats.
 * The setup installer and full runtime bundle (about 1.4 GB each) exceed the limit by too much, so they remain on GitHub.
 * The app merges assets from both sources, so this does not affect updates.
 *
 * Usage:
 *   GITEE_TOKEN=xxxx node tools/publish-gitee.js v0.3.3 D:/dist
 *     v0.3.3   release tag (must already be pushed to Gitee)
 *     D:/dist  directory containing ApkStart-v0.3.3-win64-portable.zip (optional; --zip can be used instead)
 *
 *   node tools/publish-gitee.js v0.3.3 --zip D:/x.zip --notes notes.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const HARD_LIMIT = 100 * 1024 * 1024;  // Gitee single-attachment limit (100 MiB; tested).
const PART_LIMIT = 99 * 1024 * 1024;   // Chunk size when splitting, with 1 MiB reserved for multipart headers.

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

async function api(method, p, body) {
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error('Missing required environment variable GITEE_TOKEN');
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* The response may be empty. */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

/** Split a large file and return the resulting paths. */
function splitFile(file, limit) {
  const size = fs.statSync(file).size;
  if (size <= limit) return [];
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let index = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(limit, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const p = `${file}.part${index}`;
      fs.writeFileSync(p, buf);
      out.push(p);
      offset += len;
      index += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * Upload a single attachment.
 * A 95 MB bundle is sent in a single POST (Gitee has no multipart upload API), which can fail midway on an unstable connection.
 * Previously there were no retries, so one network interruption required rerunning the entire command,
 * and removing the old attachment first. This upload now retries three times with increasing delays.
 */
async function upload(releaseId, file, attempts = 3) {
  const token = process.env.GITEE_TOKEN;
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('file', new Blob([buf]), name);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      // Do not retry 4xx responses other than 429: retrying an invalid token or duplicate name will not help.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Upload of ${name} failed: ${res.status} ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
      if (/^Upload .* failed/.test(e.message)) throw e;
    }
    if (i < attempts) {
      const wait = i * 8;
      console.warn(`   Upload attempt ${i} failed (${lastErr.message}); retrying in ${wait} seconds...`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`Upload of ${name} failed after ${attempts} attempts: ${lastErr && lastErr.message}`);
}

(async () => {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error('Usage: GITEE_TOKEN=xxx node tools/publish-gitee.js v0.3.3 [--zip path] [--notes file]');
    process.exit(1);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  let zip = arg('--zip', '');
  if (!zip && dir) {
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((n) => /portable\.zip$/i.test(n))
      : '';
    if (hit) zip = path.join(dir, hit);
  }
  if (!zip || !fs.existsSync(zip)) {
    console.error(`Portable ZIP not found: ${zip || '(not specified)'}. Pass --zip or place the ZIP in ${dir}.`);
    process.exit(1);
  }
  const notesFile = arg('--notes', '');
  const body = notesFile && fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `Portable package (single ZIP, extract and run; in-app updates are supported). The full installer and runtime bundle are on GitHub Releases.`;

  console.log('1) Find or create release', tag);
  const list = await api('GET', `/releases?per_page=50`);
  let rel = (Array.isArray(list) ? list : []).find((r) => r.tag_name === tag);
  if (!rel) {
    rel = await api('POST', '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body,
    });
    console.log('   Created release id =', rel.id);
  } else {
    console.log('   Existing release id =', rel.id);
  }

  // When republishing a version (for example, after rebuilding), remove the old attachments first; otherwise both
  // old and new split parts may be listed and the client could select either one.
  if (process.argv.includes('--replace')) {
    console.log('2) Remove old attachments with the same name');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const olds = (Array.isArray(list) ? list : []).filter((a) => /^ApkStart-.*\.zip(\.part\d+)?$/i.test(a.name || ''));
    for (const a of olds) {
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   Deleted', a.name);
    }
  }

  const zipSize = fs.statSync(zip).size;
  if (zipSize > HARD_LIMIT) {
    console.warn(`⚠️  Portable ZIP is ${(zipSize / 1048576).toFixed(1)} MB, above Gitee’s single-file limit; splitting is required.`
      + 'Manual downloads must be concatenated in order before extraction. First try `node build/zip.js` or reduce the package size.');
  }
  console.log('3) Prepare upload (prefer one ZIP; split only if needed)');
  const parts = splitFile(zip, PART_LIMIT);
  const files = parts.length ? parts : [zip];

  // A version may switch between one ZIP and split parts. Delete attachments in the alternate format with the same base name,
  // or the release will contain both `x.zip` and `x.zip.part1/part2`, and the client may choose either.
  // --replace also removes attachments from other versions; this step removes only the alternate form of the current package.
  {
    const base = path.basename(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const other = parts.length ? new RegExp(`^${base}$`, 'i') : new RegExp(`^${base}\\.part\\d+$`, 'i');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    for (const a of Array.isArray(list) ? list : []) {
      if (!other.test(a.name || '')) continue;
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   Deleted obsolete-format attachment', a.name);
    }
  }

  for (const f of files) {
    console.log(`   Uploading ${path.basename(f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    // eslint-disable-next-line no-await-in-loop
    await upload(rel.id, f);
  }
  for (const p of parts) fs.rmSync(p, { force: true });
  console.log(`\nDone: https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
