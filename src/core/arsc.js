'use strict';
/**
 * Android `resources.arsc` binary parser (zero external dependencies).
 *
 * Resolves `@0x7fXXXXXX` resource IDs for application labels, version names,
 * and highest-DPI launcher icons (including Android 8+ adaptive-icon XML trees).
 */
const { readStringPool } = require('./axml');

const RES_TABLE_TYPE = 0x0002;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;
const RES_TABLE_TYPE_TYPE = 0x0201;

const FLAG_SPARSE = 0x01;
const FLAG_OFFSET16 = 0x02;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;

class ResTable {
  constructor(buf, opts = {}) {
    this.buf = buf;
    this.preferredLang = opts.preferredLang || 'en';
    this.globalStrings = [];
    this.packages = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    if (buf.length < 12 || buf.readUInt16LE(0) !== RES_TABLE_TYPE) {
      throw new Error('Not a valid resources.arsc binary table');
    }
    const headerSize = buf.readUInt16LE(2);
    const totalSize = Math.min(buf.length, buf.readUInt32LE(4));

    let pos = headerSize;
    while (pos + 8 <= totalSize) {
      const cType = buf.readUInt16LE(pos);
      const cSize = buf.readUInt32LE(pos + 4);
      if (cSize < 8 || pos + cSize > totalSize) break;
      if (cType === RES_STRING_POOL_TYPE) {
        this.globalStrings = readStringPool(buf, pos);
      } else if (cType === RES_TABLE_PACKAGE_TYPE) {
        this._parsePackage(pos, pos + cSize);
      }
      pos += cSize;
    }
  }

  _parsePackage(start, end) {
    const buf = this.buf;
    const headerSize = buf.readUInt16LE(start + 2);
    const id = buf.readUInt32LE(start + 8);
    const typeStringsOff = buf.readUInt32LE(start + 268);
    const keyStringsOff = buf.readUInt32LE(start + 276);

    const pkg = {
      id,
      typeStrings: typeStringsOff ? readStringPool(buf, start + typeStringsOff) : [],
      keyStrings: keyStringsOff ? readStringPool(buf, start + keyStringsOff) : [],
      types: new Map(),
    };

    let pos = start + headerSize;
    while (pos + 8 <= end) {
      const cType = buf.readUInt16LE(pos);
      const cSize = buf.readUInt32LE(pos + 4);
      if (cSize < 8 || pos + cSize > end) break;
      if (cType === RES_TABLE_TYPE_TYPE) {
        this._parseType(pkg, pos, pos + cSize);
      } else if (cType === RES_TABLE_TYPE_SPEC_TYPE) {
        // TypeSpec holds config masks only; not required for concrete value lookup
      }
      pos += cSize;
    }

    this.packages.set(id, pkg);
  }

  _parseType(pkg, start, end) {
    const buf = this.buf;
    const headerSize = buf.readUInt16LE(start + 2);
    const typeId = buf.readUInt8(start + 8);
    const flags = buf.readUInt8(start + 9);
    const entryCount = buf.readUInt32LE(start + 12);
    const entriesStart = buf.readUInt32LE(start + 16);

    const cfgStart = start + 20;
    const cfgSize = buf.readUInt32LE(cfgStart);
    let lang = '';
    let density = 0;
    if (cfgSize >= 16 && cfgStart + 16 <= end) {
      const l0 = buf.readUInt8(cfgStart + 8);
      const l1 = buf.readUInt8(cfgStart + 9);
      if (l0 && l1 && (l0 & 0x80) === 0) lang = String.fromCharCode(l0, l1);
      density = buf.readUInt16LE(cfgStart + 14);
    }

    const isSparse = (flags & FLAG_SPARSE) !== 0;
    const isOff16 = (flags & FLAG_OFFSET16) !== 0;

    const offsetsPos = start + headerSize;
    const dataBase = start + entriesStart;
    const entries = new Map();

    for (let i = 0; i < entryCount; i++) {
      let entryIdx = i;
      let off;
      if (isSparse) {
        const p = offsetsPos + i * 4;
        if (p + 4 > dataBase) break;
        entryIdx = buf.readUInt16LE(p);
        off = buf.readUInt16LE(p + 2) * 4;
      } else if (isOff16) {
        const p = offsetsPos + i * 2;
        if (p + 2 > dataBase) break;
        const v = buf.readUInt16LE(p);
        if (v === 0xffff) continue;
        off = v * 4;
      } else {
        const p = offsetsPos + i * 4;
        if (p + 4 > dataBase) break;
        off = buf.readInt32LE(p);
        if (off === -1) continue;
      }

      const ep = dataBase + off;
      if (ep + 8 > end) continue;
      const eSize = buf.readUInt16LE(ep);
      const eFlags = buf.readUInt16LE(ep + 2);
      const isComplex = (eFlags & 0x0001) !== 0;
      if (isComplex) continue;
      if (ep + eSize + 8 > end) continue;
      const vType = buf.readUInt8(ep + eSize + 3);
      const vData = buf.readUInt32LE(ep + eSize + 4);
      entries.set(entryIdx, { type: vType, data: vData });
    }

    if (!pkg.types.has(typeId)) pkg.types.set(typeId, []);
    pkg.types.get(typeId).push({ config: { lang, density }, entries });
  }

  /**
   * Resolve all config variants of a resource ID (`0xPPTTEEEE`), following nested
   * `@ref` indirections up to depth 6.
   */
  resolveAll(resId, depth = 0) {
    if (depth > 6 || !resId) return [];
    const pkgId = (resId >>> 24) & 0xff;
    const typeId = (resId >>> 16) & 0xff;
    const entryIdx = resId & 0xffff;
    const pkg = this.packages.get(pkgId);
    if (!pkg) return [];
    const list = pkg.types.get(typeId);
    if (!list) return [];

    const results = [];
    for (const cfg of list) {
      const e = cfg.entries.get(entryIdx);
      if (!e) continue;
      if (e.type === TYPE_STRING) {
        const s = this.globalStrings[e.data];
        if (s !== undefined) results.push({ value: s, config: cfg.config });
      } else if (e.type === TYPE_REFERENCE && e.data !== resId) {
        for (const sub of this.resolveAll(e.data, depth + 1)) {
          results.push({ value: sub.value, config: cfg.config.lang ? cfg.config : sub.config });
        }
      }
    }
    return results;
  }

  /**
   * Resolve a string resource with deterministic locale fallback:
   *  1) `preferredLang` (defaults to `'en'`) -> +50
   *  2) Default unqualified config (`lang === ''`) -> +20
   *  3) `'en'` or `'zh'` fallback -> -5 / -10 (so English/Chinese win over random locales like `af`)
   *  4) Any other locale -> -40
   */
  resolveString(resId, preferredLang) {
    const want = (preferredLang || this.preferredLang || 'en').toLowerCase();
    const all = this.resolveAll(resId);
    if (!all.length) return null;
    const score = (c) => {
      const lang = (c.lang || '').toLowerCase();
      if (lang === want) return 50;
      if (!lang) return 20;
      if (lang === 'en') return -5;
      if (lang === 'zh') return -10;
      return -40;
    };
    all.sort((a, b) => score(b.config) - score(a.config));
    return all[0].value;
  }

  /**
   * Resolve candidate icon resource paths sorted from highest useful DPI (480/640) downward,
   * preferring raster PNG/WebP over XML drawables at equal density.
   */
  resolveIconPaths(resId) {
    const all = this.resolveAll(resId).filter((r) => typeof r.value === 'string');
    const score = (r) => {
      const d = r.config.density || 160;
      const isPng = /\.(png|webp)$/i.test(r.value) ? 1000 : 0;
      const dpiScore = d === 0xffff ? 300 : Math.min(d, 640);
      return isPng + dpiScore;
    };
    all.sort((a, b) => score(b) - score(a));
    return [...new Set(all.map((r) => r.value))];
  }
}

module.exports = { ResTable };
