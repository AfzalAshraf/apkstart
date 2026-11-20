'use strict';
/**
 * Create a Windows portable-package ZIP.
 *
 * Why not use PowerShell `Compress-Archive`?
 * It uses .NET Deflate (roughly zlib level 6), producing a 105,213,775-byte archive from the same 225 MB directory.
 * 7-Zip Deflate (`-mx=9`) produces 99,616,541 bytes, saving about 5.6 MB.
 * Gitee release attachments have a 100 MB per-file limit (104,800,000 bytes uploaded successfully,
 * while 105,213,775 bytes required part1/part2 files that users cannot extract directly). That 5 MB decides
 * whether users receive one directly extractable archive or must download and join two parts.
 *
 * Prefer 7-Zip and fall back to Compress-Archive only when 7-Zip is unavailable (with a warning).
 *
 * Usage:
 *   node build/zip.js <source-directory> <output.zip> [--limit-mb 100]
 * Exit codes: 0 success / 1 failure / 2 size limit exceeded (CI treats this as failure to prevent accidental split releases).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Find a standalone 7-Zip executable (7z.exe or 7za.exe) in common locations. */
function find7z() {
  const explicit = process.env.APKSTART_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // Search PATH (GitHub Actions windows-latest includes 7-Zip on PATH).
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // Search the 7-Zip cache downloaded by electron-builder (common on development machines).
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* No cache directory. */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Create a ZIP with 7-Zip, using the source directory as cwd so archive paths have no parent prefix. */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7-Zip failed with status ${r.status}: ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Fallback to PowerShell Compress-Archive (about 5% larger); use only when 7-Zip is unavailable. */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Compress-Archive failed: ${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Verify the ZIP with the app parser and compare entry count and uncompressed bytes with the source. */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`Entry count mismatch: archive has ${names.length}, source has ${expect.files}`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`Uncompressed size mismatch: archive has ${bytes} bytes, source has ${expect.bytes}`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('Usage: node build/zip.js <source-directory> <output.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`Compressing ${srcDir} (${stats.files} files, ${(stats.bytes / MIB).toFixed(1)} MB)`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('Compressor:', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('⚠️  7-Zip not found; falling back to Compress-Archive. The archive may be about 5% larger and exceed Gitee’s per-file limit.');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`Created: ${outZip}`);
  console.log(`  ${entries} entries, ${size} bytes (${(size / MIB).toFixed(2)} MiB), ${(size / stats.bytes * 100).toFixed(1)}% of source size`);

  if (size > limitMiB * MIB) {
    console.error(`✗ Exceeds the ${limitMiB} MiB limit (Gitee attachment limit: 100 MB). Reduce the package instead of bypassing the limit with split archives.`);
    process.exit(2);
  }
  console.log(`  ✓ Within the ${limitMiB} MiB limit (${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB remaining)`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
