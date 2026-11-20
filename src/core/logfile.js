'use strict';
/**
 * Automatic log rotation helper (`logfile.js`).
 * Keeps each engine log under `maxKB` by preserving its recent tail (`keepRatio`)
 * instead of allowing `emulator.log` or `qemu.log` to grow without bound.
 */
const fs = require('fs');
const path = require('path');

function rotateIfHuge(filePath, maxKB = 2048, keepRatio = 0.4) {
  try {
    if (!fs.existsSync(filePath)) return;
    const st = fs.statSync(filePath);
    const maxBytes = Math.max(128, maxKB) * 1024;
    if (st.size <= maxBytes) return;
    const keep = Math.floor(maxBytes * keepRatio);
    const fd = fs.openSync(filePath, 'r');
    const tail = Buffer.alloc(keep);
    try {
      fs.readSync(fd, tail, 0, keep, st.size - keep);
    } finally {
      fs.closeSync(fd);
    }
    const header = Buffer.from(
      `--- [Log rotated at ${new Date().toISOString()}; previous size ${(st.size / 1024 / 1024).toFixed(1)} MB] ---\n`,
    );
    fs.writeFileSync(filePath, Buffer.concat([header, tail]));
  } catch (_) { /* Log rotation failure is non-fatal */ }
}

function rotate(filePath, maxKB = 2048) {
  try {
    if (!fs.existsSync(filePath)) return false;
    if (fs.statSync(filePath).size < Number(maxKB) * 1024) return false;
    const backup = filePath.replace(/\.log$/i, '.1.log');
    if (path.resolve(backup) === path.resolve(filePath)) return false;
    fs.rmSync(backup, { force: true });
    fs.renameSync(filePath, backup);
    return true;
  } catch (_) {
    return false;
  }
}

function append(filePath, line, maxKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, String(line).endsWith('\n') ? String(line) : `${line}\n`, 'utf8');
    rotateIfHuge(filePath, maxKB);
    return true;
  } catch (_) {
    return false;
  }
}

function attachPeriodicTrim(filePath, maxKB = 2048, intervalMs = 5 * 60 * 1000) {
  const t = setInterval(() => rotateIfHuge(filePath, maxKB), intervalMs);
  if (t.unref) t.unref();
  return () => clearInterval(t);
}

module.exports = { append, rotate, rotateIfHuge, attachPeriodicTrim };
