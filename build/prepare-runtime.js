'use strict';
/**
 * Prepare engine/ as a distributable runtime in build/runtime/.
 *
 * The main step is compressing system.img. AOSP system.img is a 3.1 GB sparse image,
 * mostly zeros; a gzip baseline reduces it to about 580 MB, and XZ can shrink it further. This image accounts for most of the full package size.
 * With the trimmed emulator (~340 MB), Electron, and platform-tools, the package is about 1.0–1.1 GB.
 * Without compression, the package would exceed 1.4 GB.
 * The tradeoff is a one-time 1–2 minute extraction to the user data directory on first launch.
 * Extraction is handled by materializeImages() in src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Prebuilt /data seed image (formatted ext4, gzip-compressed); see userdata.img handling below.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Compress large images with XZ (LZMA2), about 25% smaller than gzip -6 (system.img 1.5 GB → ~1.1 GB).
 *  Default to preset 9e; on two-core CI, XZ_PRESET=6 cuts runtime to one-third with about 3% more size.
 *
 *  Implementation notes from previous failures:
 *   - Use Python lzma (single-threaded and stable). @napi-rs/lzma createCompressStream can
 *     hang with zero-byte output in some environments (observed for 18 minutes); keep it only as a timed last resort.
 *   - Root cause of a three-hour CI hang: pipe the source file to child-process stdin and close it when finished.
 *     Python runs `shutil.copyfileobj(sys.stdin.buffer, z)` and waits forever without EOF,
 *     writing no stdout and never exiting. The old code only consumed p.stdout; a local .xz file
 *     hid the problem locally by skipping compression, while a clean CI workspace exposed it.
 *   - A watchdog kills a hung compressor and falls back to gzip so packaging cannot stall indefinitely.
 *   - If Python is unavailable or compression fails, use gzip -9 (slightly larger, but reliable);
 *     materializeImages selects the decompressor by extension and supports both formats.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* Try the next command. */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Default timeout: two hours (about 40 minutes for 3 GB on two cores at preset 6); kill and fall back to gzip on timeout.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Attach listeners before awaiting so a fast exit cannot lose the close event.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  XZ compression exceeded ${Math.round(timeoutMs / 60000)} minutes; terminating and falling back to gzip -9.`);
      try { p.kill(); } catch (_) { /* Already exited. */ }
    }, timeoutMs);

    let ok = false;
    try {
      // stdin is the compressor input. pipeline ends p.stdin after reading src,
      // allowing Python to flush the XZ footer and exit normally.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Kill the child immediately on EPIPE or a write failure instead of waiting for the watchdog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // Remove a partial .xz before using the fallback.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  ${py} compression failed; falling back to gzip -9.`);
  } else {
    console.log('  Python not found; falling back to gzip -9 (slightly larger, but reliable).');
  }
  // Fallback: gzip -9 (not XZ); materializeImages selects the decompressor by extension.
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime is up to date (use --force to rebuild).');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('Missing engine/ directory; cannot prepare the runtime.');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy emulator and platform-tools directly (excluding old build artifacts).
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`Copying ${dir}...`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Trim files that are never loaded with the fixed startup arguments (about 400 MB).
  if (!process.argv.includes('--no-slim')) {
    console.log('Trimming runtime...');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. System images: compress large images as .xz for streaming extraction; copy the rest unchanged.
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt contains GMS licensing text (~20 MB) and is not needed at runtime.
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // Use the repository seed ext4 template for userdata.img:
            // the official system image contains a 1 MB zero-filled file, which makes e2fsck return code 8 during expansion,
            // leaving a 1 MB partition, invalid guest magic, read-only /data, and a system that never boots on fresh install.
            // Generate the template once with mke2fs and keep it in the repository; CI needs no additional toolchain.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('Using the prebuilt ext4 userdata image (build/seed).');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Compress each large image once and omit the original; skip compression when a valid archive exists.
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // Also recognize .gz from the fallback path, or each rebuild would recompress a 3 GB image.
              // Use a >1 MB minimum instead of a compression ratio: vendor.img.gz is about 21 MB and userdata.img is mostly zeros,
              // so a large fixed threshold or compression-ratio check would incorrectly rebuild valid files.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Skipping ${f} (existing ${path.extname(existing)}: ${(sizeOf(existing) / 1048576).toFixed(1)} MB).`);
                compressed += 1;
                continue;
              }
              console.log(`Compressing ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) to XZ 9e (slow, one-time)...`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`Done: build/runtime (${(total / 1073741824).toFixed(2)} GB; compressed ${gzCount} large images).`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Export helpers for regression tests without running the full packaging flow.
module.exports = { xzFile, gzipFile, findPython };
