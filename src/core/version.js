'use strict';
/**
 * Version comparison utility supporting both SemVer 2.0 (v0.4.3, 0.5.0-rc.1, 1.0.0+build)
 * and 4-part Android SDK / Emulator versions (e.g. 37.3.8.0).
 *
 * Rules:
 *   1. Leading "v"/"V" and "+build" metadata are stripped.
 *   2. Core numeric segments are compared numerically (missing trailing segments = 0,
 *      so 1.0 == 1.0.0 while 1.0.0.1 > 1.0.0).
 *   3. A release version ranks higher than a pre-release of the same core version
 *      (0.5.0 > 0.5.0-rc.1 > 0.5.0-beta.2 > 0.5.0-alpha.1).
 */
function parseVer(v) {
  const clean = String(v || '').trim().replace(/^[vV]/, '').split('+')[0];
  if (!clean) return { core: [0], pre: null };
  const dashIdx = clean.indexOf('-');
  const coreStr = dashIdx >= 0 ? clean.slice(0, dashIdx) : clean;
  const preStr = dashIdx >= 0 ? clean.slice(dashIdx + 1) : null;
  const core = coreStr
    .split('.')
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase()));
  const pre = preStr
    ? preStr
      .split(/[.-]/)
      .filter((s) => s.length > 0)
      .map((s) => (/^\d+$/.test(s) ? Number(s) : s.toLowerCase()))
    : null;
  return { core: core.length ? core : [0], pre };
}

/** a > b => 1, a < b => -1, equal => 0 */
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const coreLen = Math.max(A.core.length, B.core.length);
  for (let i = 0; i < coreLen; i++) {
    const x = A.core[i] !== undefined ? A.core[i] : 0;
    const y = B.core[i] !== undefined ? B.core[i] : 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    return String(x) > String(y) ? 1 : -1;
  }
  if (!A.pre && !B.pre) return 0;
  if (!A.pre && B.pre) return 1;   // final release > pre-release
  if (A.pre && !B.pre) return -1;  // pre-release < final release

  const preLen = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < preLen; i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    if (typeof x === 'number') return -1; // numeric pre-release id has lower precedence than non-numeric per SemVer
    if (typeof y === 'number') return 1;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}

module.exports = { parseVer, cmpVer };
