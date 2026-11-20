'use strict';
/**
 * Trim runtime files that ApkStart never loads.
 *
 * Decisions are based on the fixed startup arguments in emulator.js:
 *   - Only x86_64 images are shipped (API 30 AOSP) → qemu-system-aarch64.exe is not needed.
 *   - -gpu software (SwiftShader rendering) → Vulkan / GLES ANGLE backends are not needed.
 *   - The UI keeps only a 38 px title bar → emulator UI locales and WebEngine panels are not needed.
 *
 * Always preserve network components: netsimd, netsim, and nimble_bridge.
 * They provide Wi-Fi and Bluetooth networking; removing them breaks app connectivity.
 *
 * Usage:
 *   node build/slim-runtime.js build/runtime          # safe profile (default)
 *   node build/slim-runtime.js build/runtime --aggressive   # also remove QtWebEngine (-169 MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Safe profile: remove files confirmed not to be loaded (about 190 MB).
 * These boundaries were confirmed by reverting one item at a time; do not remove additional files:
 *   - Qt6WebEngineCoreAndroidEmu.dll is statically imported by emulator.exe; removing it prevents startup. Keep it.
 *   - lib64/gles_angle provides vk_swiftshader, required for SwiftShader rendering. Keep it.
 *   - Removing lib64/vulkan falls back to software rendering (tested successfully); it saves 103 MB.
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'ARM64 QEMU binary (only x86_64 images are shipped)'],
  // Do not remove the entire emulator/lib64/vulkan directory: vulkan-1.dll loads the -gpu host backend,
  // and removing it breaks host rendering (confirmed necessary on AMD 780M). Remove only the large files below:
  ['emulator/lib64/vulkan/layers', 'Vulkan validation layers (not needed for host rendering, -20 MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'Shader validation tool (not needed at runtime, -7 MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'Lavapipe software Vulkan fallback (unused when a system GPU driver is available, -53 MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'Lavapipe ICD descriptor (-1 KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (duplicate exists under gles_angle, -23 MB)'],
  ['emulator/lib64/qt/translations', 'Emulator UI locale packs (only the 38 px title bar remains)'],
  // Do not remove emulator-check.exe: emulator -accel-check uses it to detect AEHD/WHPX.
  // Without it, hardware acceleration appears unavailable and TCG can increase boot time from 42 seconds to over 10 minutes.
  ['emulator/qsn.exe', 'QEMU snapshot notification helper (no references in emulator.exe, confirmed with strings, -34 MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'VR panorama environment texture (unused, -3.7 MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'VR panorama decoration texture (-3.5 MB)'],
  ['emulator/resources/Toren1BD.obj', 'VR panorama 3D model (-3.5 MB)'],
  ['emulator/resources/macroPreviews', 'Macro-action preview images (-2.7 MB)'],
  ['emulator/resources/default360.mp4', 'Default 360-degree panorama video (-2.4 MB)'],
];

/** The aggressive profile is currently empty: WebEngine and gles_angle are required dependencies. */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* Ignore. */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} is not a runtime directory (emulator/emulator.exe is missing)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  Skipped ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  Removed ${rel} (${(n / 1048576).toFixed(0)} MB) — ${why}`);
  }
  log(`${dryRun ? 'Reclaimable' : 'Reclaimed'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Runtime cleanup target: ${root} (${aggressive ? 'aggressive' : 'safe'} profile)`);
  slim(root, { aggressive, dryRun });
}
