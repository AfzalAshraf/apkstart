'use strict';
/**
 * Build the portable package at dist/ApkStart-win64-portable/.
 *   ApkStart.exe (renamed from electron.exe) + resources/app (application source).
 * No installer is required; extract and run. The same layout can be reused by electron-builder.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Allow a custom output directory so a locked target can be replaced after building elsewhere.
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('Building portable package →', OUT);
// Do not recursively delete an existing target: some environments block bulk deletion, and a failed build would remove
// the last working package. Rename it as a backup first, then build cleanly; use a versioned path if it is locked.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Previous version preserved →', backup);
  } catch (_) {
    // Antivirus, search indexing, or Explorer may hold the directory handle for a long time,
    // making a directory rename fail with EBUSY. Fall back to a versioned output path to avoid collisions.
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Previous directory is locked; using →', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Electron runtime
console.log('Copying Electron runtime...');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Trim locale packs: Electron ships 55 locales totaling 41 MB. Keep Simplified Chinese, Traditional Chinese, and English.
//     Retaining zh-CN, zh-TW, and en-US saves about 39 MB (roughly 15% of the package).
const KEEP_LOCALES = new Set(['zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* A missing locales directory is harmless. */ }

// 1.2 Remove backup license data and stale SwiftShader ICD metadata that are not needed at runtime.
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Runtime files that can be omitted:
//     d3dcompiler_47.dll compiles ANGLE HLSL into GPU instructions, but Windows 8.1 and later
//     include this DLL in System32. If LoadLibrary cannot find the bundled copy, it uses the system copy.
//     Removing it passed UI, icon, and font-rendering smoke checks (screenshots were unchanged); saves 2.1 MB.
//     Do not remove vk_swiftshader.dll or vulkan-1.dll: Chromium uses them as a software fallback when GPU drivers
//     are unavailable; removing them can cause a blank window.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* Not present. */ }
}

// 2. Application files
console.log('Copying application files...');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. Optional directories
// Only documentation is bundled from engine/. Large runtime components (emulator, system-images,
// platform-tools, and AVD data) are downloaded from official sources on first launch, not bundled.
// tools/ contains developer diagnostics and benchmarks; it is not needed by users and is not bundled.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 4. Rename the main executable
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'ApkStart.exe'));

// 5. Version information
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `ApkStart ${pkg.version}\nBuild time: ${new Date().toISOString()}\n`);

// 6. Report package size on every build to catch unexpected growth.
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Done. Package: ${totalMB.toFixed(0)} MB (locale packs saved ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `redundant runtime files saved ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Compress with: node build/zip.js dist/ApkStart-win64-portable <output.zip>');
console.log(`Run ${path.join(OUT, 'ApkStart.exe')} to launch the app.`);
