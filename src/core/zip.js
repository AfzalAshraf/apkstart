'use strict';
/**
 * Pure Node.js ZIP / ZIP64 reader (zero external dependencies).
 *
 * Two modes:
 *   - `ZipArchive(buffer)` — in-memory reader for small archives and unit tests;
 *   - `ZipFile(filePath)`  — random-access `fd` reader for multi-GB APKs, XAPKs,
 *     and Android SDK packages (reads only the last 64 KB EOCD + Central Directory,
 *     and streams entries directly to disk via `pipeTo` with O(1) memory).
 *
 * Supports ZIP64 (archives > 4 GB or > 65,535 entries) and protects `read()` against
 * deflate zip-bombs (`MAX_READ = 512 MB` enforced on both compressed and uncompressed sizes).
 */
const fs = require('fs');
const zlib = require('zlib');

const SIG_EOCD = 0x06054b50;
const SIG_Z64_EOCD = 0x06064b50;
const SIG_Z64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;
const MAX_READ = 512 * 1024 * 1024;

function findEocdIn(buf) {
  const minOff = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= minOff; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

function readZip64Locator(buf, eocdInBuf, tailFileStart) {
  const locPos = eocdInBuf - 20;
  if (locPos < 0) return -1;
  if (buf.readUInt32LE(locPos) !== SIG_Z64_LOC) return -1;
  const off = Number(buf.readBigUInt64LE(locPos + 8));
  return Number.isSafeInteger(off) && off >= 0 ? off : -1;
}

function parseZip64Eocd(buf, pos) {
  if (pos < 0 || pos + 56 > buf.length) return null;
  if (buf.readUInt32LE(pos) !== SIG_Z64_EOCD) return null;
  return {
    total: Number(buf.readBigUInt64LE(pos + 32)),
    cdSize: Number(buf.readBigUInt64LE(pos + 40)),
    cdOffset: Number(buf.readBigUInt64LE(pos + 48)),
  };
}

function applyZip64Extra(extra, fields) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const sz = extra.readUInt16LE(p + 2);
    const end = Math.min(extra.length, p + 4 + sz);
    if (id === 0x0001) {
      let q = p + 4;
      if (fields.uncompSize === U32_MAX && q + 8 <= end) {
        fields.uncompSize = Number(extra.readBigUInt64LE(q)); q += 8;
      }
      if (fields.compSize === U32_MAX && q + 8 <= end) {
        fields.compSize = Number(extra.readBigUInt64LE(q)); q += 8;
      }
      if (fields.localOffset === U32_MAX && q + 8 <= end) {
        fields.localOffset = Number(extra.readBigUInt64LE(q)); q += 8;
      }
      return;
    }
    p += 4 + sz;
  }
}

function parseCentralDirectory(cd, totalHint) {
  const entries = new Map();
  let pos = 0;
  let count = 0;
  const limit = totalHint > 0 ? totalHint : Infinity;
  while (count < limit && pos + 46 <= cd.length) {
    if (cd.readUInt32LE(pos) !== SIG_CEN) break;
    const method = cd.readUInt16LE(pos + 10);
    const compSize = cd.readUInt32LE(pos + 20);
    const uncompSize = cd.readUInt32LE(pos + 24);
    const nameLen = cd.readUInt16LE(pos + 28);
    const extraLen = cd.readUInt16LE(pos + 30);
    const commentLen = cd.readUInt16LE(pos + 32);
    const localOffset = cd.readUInt32LE(pos + 42);
    const nameEnd = pos + 46 + nameLen;
    if (nameEnd > cd.length) break;
    const name = cd.slice(pos + 46, nameEnd).toString('utf8');
    const rec = { name, method, compSize, uncompSize, localOffset };
    if (extraLen > 0 && (compSize === U32_MAX || uncompSize === U32_MAX || localOffset === U32_MAX)) {
      const extraEnd = Math.min(cd.length, nameEnd + extraLen);
      applyZip64Extra(cd.slice(nameEnd, extraEnd), rec);
    }
    entries.set(name, rec);
    pos = nameEnd + extraLen + commentLen;
    count++;
  }
  return entries;
}

class ZipArchive {
  constructor(buffer) {
    if (!Buffer.isBuffer(buffer)) throw new Error('ZipArchive requires a Buffer');
    this.buf = buffer;
    this.entries = new Map();
    this._parseCentralDirectory();
  }

  _parseCentralDirectory() {
    const buf = this.buf;
    const eocd = findEocdIn(buf);
    if (eocd < 0) throw new Error('Not a valid ZIP/APK archive (missing EOCD signature)');

    let total = buf.readUInt16LE(eocd + 10);
    let cdSize = buf.readUInt32LE(eocd + 12);
    let cdOffset = buf.readUInt32LE(eocd + 16);

    if (total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      const z64Off = readZip64Locator(buf, eocd, 0);
      const z64 = z64Off >= 0 ? parseZip64Eocd(buf, z64Off) : null;
      if (!z64) throw new Error('Invalid ZIP64 archive: missing Zip64 EOCD record');
      ({ total, cdSize, cdOffset } = z64);
    }

    const end = Math.min(buf.length, cdOffset + cdSize);
    this.entries = parseCentralDirectory(buf.subarray(cdOffset, end), total);
  }

  has(name) { return this.entries.has(name); }
  list() { return [...this.entries.values()]; }
  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.compSize > MAX_READ || e.uncompSize > MAX_READ) {
      throw new Error(`Entry ${name} exceeds in-memory limit (${Math.max(e.compSize, e.uncompSize)} bytes)`);
    }
    const buf = this.buf;
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) {
      throw new Error(`Corrupt ZIP local header: ${name}`);
    }
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_READ });
    throw new Error(`Unsupported ZIP compression method ${e.method} (${name})`);
  }
}

class ZipFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.fd = fs.openSync(filePath, 'r');
    try {
      this.size = fs.fstatSync(this.fd).size;
      this.entries = new Map();
      this._loadIndex();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  _readAt(offset, length) {
    if (length <= 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(length);
    let done = 0;
    while (done < length) {
      const n = fs.readSync(this.fd, out, done, length - done, offset + done);
      if (n <= 0) break;
      done += n;
    }
    return done === length ? out : out.subarray(0, done);
  }

  _loadIndex() {
    if (this.size < 22) throw new Error('File is too small to be a valid ZIP/APK archive');
    const tailLen = Math.min(this.size, 0xffff + 22 + 20);
    const tailStart = this.size - tailLen;
    const tail = this._readAt(tailStart, tailLen);
    const eocdInTail = findEocdIn(tail);
    if (eocdInTail < 0) throw new Error('Not a valid ZIP/APK archive (missing EOCD signature)');

    let total = tail.readUInt16LE(eocdInTail + 10);
    let cdSize = tail.readUInt32LE(eocdInTail + 12);
    let cdOffset = tail.readUInt32LE(eocdInTail + 16);

    if (total === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
      const z64FileOff = readZip64Locator(tail, eocdInTail, tailStart);
      if (z64FileOff < 0) throw new Error('Invalid ZIP64 archive: missing Zip64 EOCD Locator');
      const z64Buf = this._readAt(z64FileOff, 56);
      const z64 = parseZip64Eocd(z64Buf, 0);
      if (!z64) throw new Error('Invalid ZIP64 archive: corrupted Zip64 EOCD record');
      ({ total, cdSize, cdOffset } = z64);
    }

    if (cdOffset < 0 || cdOffset > this.size) {
      throw new Error(`Invalid ZIP Central Directory offset (${cdOffset}/${this.size})`);
    }
    const actualSize = Math.min(cdSize, this.size - cdOffset);
    if (actualSize > 256 * 1024 * 1024) {
      throw new Error(`ZIP Central Directory is unreasonably large (${actualSize} bytes)`);
    }
    const cd = this._readAt(cdOffset, actualSize);
    this.entries = parseCentralDirectory(cd, total);
  }

  has(name) { return this.entries.has(name); }
  list() { return [...this.entries.values()]; }
  names() { return [...this.entries.keys()]; }

  _dataOffset(e) {
    const hdr = this._readAt(e.localOffset, 30);
    if (hdr.length < 30 || hdr.readUInt32LE(0) !== SIG_LOC) {
      throw new Error(`Corrupt ZIP local header: ${e.name}`);
    }
    return e.localOffset + 30 + hdr.readUInt16LE(26) + hdr.readUInt16LE(28);
  }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (e.compSize > MAX_READ || e.uncompSize > MAX_READ) {
      throw new Error(`Entry ${name} is too large (${Math.max(e.compSize, e.uncompSize)} bytes); use pipeTo instead`);
    }
    const start = this._dataOffset(e);
    const raw = this._readAt(start, e.compSize);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: MAX_READ });
    throw new Error(`Unsupported ZIP compression method ${e.method} (${name})`);
  }

  /**
   * Stream entry `name` into writable `dest` with bounded memory and deterministic
   * stream cleanup on failure (no leaked Windows file locks).
   */
  pipeTo(name, dest) {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`Entry not found in ZIP archive: ${name}`));
    if (e.method !== 0 && e.method !== 8) {
      return Promise.reject(new Error(`Unsupported ZIP compression method ${e.method} (${name})`));
    }
    let start;
    try { start = this._dataOffset(e); } catch (err) {
      try { dest.destroy(); } catch (_) { /* ignore */ }
      return Promise.reject(err);
    }
    if (e.compSize === 0) {
      return new Promise((resolve, reject) => {
        dest.once('error', reject);
        dest.end(() => resolve());
      });
    }
    const src = fs.createReadStream(null, {
      fd: this.fd,
      start,
      end: start + e.compSize - 1,
      autoClose: false,
      highWaterMark: 256 * 1024,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      let inf = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { src.destroy(); } catch (_) { /* ignore */ }
        if (inf) { try { inf.destroy(); } catch (_) { /* ignore */ } }
        try { dest.destroy(); } catch (_) { /* ignore */ }
        reject(err);
      };
      src.on('error', fail);
      dest.on('error', fail);
      dest.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      if (e.method === 8) {
        inf = zlib.createInflateRaw();
        inf.on('error', fail);
        src.pipe(inf).pipe(dest);
      } else {
        src.pipe(dest);
      }
    });
  }

  close() {
    if (this.fd !== null && this.fd !== undefined) {
      try { fs.closeSync(this.fd); } catch (_) { /* ignore */ }
      this.fd = null;
    }
  }
}

module.exports = { ZipArchive, ZipFile };
