'use strict';
/**
 * Generate a userdata seed image for debugging.
 * Usage: node tools/make-userdata.js <output-file> [size-MiB]
 */
const fs = require('fs');
const { buildEmptyExt4 } = require('../src/core/userdata');

const out = process.argv[2];
if (!out) {
  console.error('Usage: node tools/make-userdata.js <output-file> [size-MiB]');
  process.exit(2);
}
const sizeMB = Number(process.argv[3] || 64);
const img = buildEmptyExt4({ sizeMB });
fs.writeFileSync(out, img);
console.log(`Generated ${out} (${(img.length / 1024 / 1024).toFixed(0)} MiB, ext4 / 4 KiB blocks)`);
