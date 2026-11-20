'use strict';
/**
 * Zero-dependency RGBA -> PNG encoder & procedural ApkStart brand/tray icon generator (`png.js`).
 */
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

function encodePng(width, height, rgba) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new RangeError('PNG width and height must be positive integers');
  }
  const pixels = Buffer.isBuffer(rgba)
    ? rgba
    : (ArrayBuffer.isView(rgba)
      ? Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
      : Buffer.from(rgba || []));
  const stride = w * 4;
  if (pixels.length !== stride * h) {
    throw new RangeError(`RGBA buffer must contain exactly ${stride * h} bytes`);
  }
  const raw = Buffer.allocUnsafe((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function drawAppIcon(size = 256) {
  const buf = Buffer.alloc(size * size * 4);
  const s = size;
  const pad = s * 0.06;
  const r = s * 0.22;

  function roundedRectSdf(x, y) {
    const cx = s / 2, cy = s / 2;
    const hw = s / 2 - pad - r, hh = s / 2 - pad - r;
    const dx = Math.max(Math.abs(x - cx) - hw, 0);
    const dy = Math.max(Math.abs(y - cy) - hh, 0);
    return Math.hypot(dx, dy) - r;
  }

  const p1 = [s * 0.37, s * 0.30];
  const p2 = [s * 0.37, s * 0.70];
  const p3 = [s * 0.72, s * 0.50];
  function triSdf(px, py) {
    const pts = [p1, p2, p3];
    let inside = true;
    let minD = Infinity;
    for (let i = 0; i < 3; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % 3];
      const ex = bx - ax, ey = by - ay;
      const wx = px - ax, wy = py - ay;
      const cross = ex * wy - ey * wx;
      if (cross < 0) inside = false;
      const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey));
      const d = Math.hypot(wx - ex * t, wy - ey * t);
      if (d < minD) minD = d;
    }
    return (inside ? -minD : minD) - s * 0.025;
  }

  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      const d = roundedRectSdf(x + 0.5, y + 0.5);
      const bgAlpha = clamp01(0.5 - d);
      if (bgAlpha <= 0) continue;

      const t = (x + y) / (2 * s);
      let R = 16 + (52 - 16) * (1 - t);
      let G = 185 + (211 - 185) * (1 - t);
      let B = 129 + (153 - 129) * (1 - t);

      const td = triSdf(x + 0.5, y + 0.5);
      const triA = clamp01(0.5 - td);
      if (triA > 0) {
        R = R * (1 - triA) + 255 * triA;
        G = G * (1 - triA) + 255 * triA;
        B = B * (1 - triA) + 255 * triA;
      }

      buf[i] = Math.round(R);
      buf[i + 1] = Math.round(G);
      buf[i + 2] = Math.round(B);
      buf[i + 3] = Math.round(bgAlpha * 255);
    }
  }
  return encodePng(s, s, buf);
}

module.exports = { encodePng, drawAppIcon };
