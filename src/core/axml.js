'use strict';
/**
 * Parser for Android's compiled binary XML (AXML) format.
 * It preserves attribute namespaces and resolves typed values so APK metadata
 * extraction can distinguish manifest attributes from android: attributes.
 */

const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_CDATA_TYPE = 0x0104;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;

const UTF8_FLAG = 1 << 8;
const TYPE_NULL = 0x00;
const TYPE_REFERENCE = 0x01;
const TYPE_ATTRIBUTE = 0x02;
const TYPE_STRING = 0x03;
const TYPE_FLOAT = 0x04;
const TYPE_DIMENSION = 0x05;
const TYPE_FRACTION = 0x06;
const TYPE_DYNAMIC_REFERENCE = 0x07;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const NONE = 0xffffffff;

const KNOWN_ATTR_IDS = {
  0x01010001: 'label',
  0x01010002: 'icon',
  0x01010003: 'name',
  0x01010010: 'exported',
  0x0101001e: 'screenOrientation',
  0x01010203: 'targetActivity',
  0x0101020c: 'minSdkVersion',
  0x0101021b: 'versionCode',
  0x0101021c: 'versionName',
  0x01010270: 'targetSdkVersion',
  0x0101052c: 'roundIcon',
};

function readUtf8Length(buf, pos) {
  if (pos >= buf.length) return { value: 0, size: 0 };
  const first = buf[pos];
  if (first & 0x80) {
    if (pos + 1 >= buf.length) return { value: 0, size: 0 };
    return { value: ((first & 0x7f) << 8) | buf[pos + 1], size: 2 };
  }
  return { value: first, size: 1 };
}

function readUtf16Length(buf, pos) {
  if (pos + 2 > buf.length) return { value: 0, size: 0 };
  const first = buf.readUInt16LE(pos);
  if (first & 0x8000) {
    if (pos + 4 > buf.length) return { value: 0, size: 0 };
    return { value: ((first & 0x7fff) << 16) | buf.readUInt16LE(pos + 2), size: 4 };
  }
  return { value: first, size: 2 };
}

function parseStringPool(buf, chunkStart, chunkSize) {
  if (chunkStart + 28 > buf.length) throw new Error('Invalid AXML string pool header');
  const headerSize = buf.readUInt16LE(chunkStart + 2);
  const stringCount = buf.readUInt32LE(chunkStart + 8);
  const flags = buf.readUInt32LE(chunkStart + 16);
  const stringsStart = buf.readUInt32LE(chunkStart + 20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;
  const offsetsBase = chunkStart + headerSize;
  const dataBase = chunkStart + stringsStart;
  const chunkEnd = Math.min(buf.length, chunkStart + chunkSize);
  const strings = new Array(stringCount);

  for (let i = 0; i < stringCount; i += 1) {
    const offsetAt = offsetsBase + i * 4;
    if (offsetAt + 4 > chunkEnd) { strings[i] = ''; continue; }
    let pos = dataBase + buf.readUInt32LE(offsetAt);
    if (pos < dataBase || pos >= chunkEnd) { strings[i] = ''; continue; }
    if (isUtf8) {
      const chars = readUtf8Length(buf, pos);
      pos += chars.size;
      const bytes = readUtf8Length(buf, pos);
      pos += bytes.size;
      strings[i] = bytes.size && pos + bytes.value <= chunkEnd
        ? buf.toString('utf8', pos, pos + bytes.value)
        : '';
    } else {
      const chars = readUtf16Length(buf, pos);
      pos += chars.size;
      const byteLength = chars.value * 2;
      strings[i] = chars.size && pos + byteLength <= chunkEnd
        ? buf.toString('utf16le', pos, pos + byteLength)
        : '';
    }
  }
  return strings;
}

function decodeValue(type, data, strings) {
  switch (type) {
    case TYPE_NULL: return null;
    case TYPE_STRING: return strings[data] ?? '';
    case TYPE_REFERENCE:
    case TYPE_DYNAMIC_REFERENCE:
      return { type: 'ref', id: data >>> 0 };
    case TYPE_ATTRIBUTE:
      return { type: 'attr', id: data >>> 0 };
    case TYPE_INT_BOOLEAN: return data !== 0;
    case TYPE_INT_DEC: return data | 0;
    case TYPE_INT_HEX: return `0x${(data >>> 0).toString(16)}`;
    case TYPE_FLOAT: {
      const b = Buffer.allocUnsafe(4);
      b.writeUInt32LE(data >>> 0, 0);
      return b.readFloatLE(0);
    }
    case TYPE_DIMENSION:
    case TYPE_FRACTION:
      return data >>> 0;
    default:
      if (type >= 0x1c && type <= 0x1f) {
        return `#${(data >>> 0).toString(16).padStart(8, '0')}`;
      }
      return data;
  }
}

function parseAxml(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buf.length < 8) throw new Error('Invalid AXML: buffer too short');
  if (buf.readUInt16LE(0) !== RES_XML_TYPE) {
    const text = buf.toString('utf8');
    if (text.trimStart().startsWith('<')) {
      throw new Error('Unexpected plain-text XML (expected compiled binary AXML)');
    }
    throw new Error(`Invalid AXML magic: 0x${buf.readUInt16LE(0).toString(16)}`);
  }

  let pos = buf.readUInt16LE(2);
  let strings = [];
  let resourceIds = [];
  const prefixByUri = new Map();
  const root = { name: '#doc', tag: '#doc', attrs: [], children: [], parent: null };
  const stack = [root];
  const getString = (index) => (
    index === NONE || index < 0 || index >= strings.length ? null : strings[index]
  );

  while (pos + 8 <= buf.length) {
    const type = buf.readUInt16LE(pos);
    const headerSize = buf.readUInt16LE(pos + 2);
    const chunkSize = buf.readUInt32LE(pos + 4);
    if (chunkSize < 8 || pos + chunkSize > buf.length) break;

    if (type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(buf, pos, chunkSize);
    } else if (type === RES_XML_RESOURCE_MAP_TYPE) {
      const count = Math.floor((chunkSize - headerSize) / 4);
      resourceIds = new Array(count);
      for (let i = 0; i < count; i += 1) {
        resourceIds[i] = buf.readUInt32LE(pos + headerSize + i * 4);
      }
    } else if (type === RES_XML_START_NAMESPACE_TYPE) {
      if (pos + 24 <= pos + chunkSize) {
        const prefix = getString(buf.readUInt32LE(pos + 16));
        const uri = getString(buf.readUInt32LE(pos + 20));
        if (uri) prefixByUri.set(uri, prefix || '');
      }
    } else if (type === RES_XML_START_ELEMENT_TYPE) {
      if (pos + 36 > pos + chunkSize) { pos += chunkSize; continue; }
      const nameIndex = buf.readUInt32LE(pos + 20);
      const attrStart = buf.readUInt16LE(pos + 24);
      const attrSize = buf.readUInt16LE(pos + 26) || 20;
      const attrCount = buf.readUInt16LE(pos + 28);
      const name = getString(nameIndex) || '';
      const attrs = [];
      const attrBase = pos + 16 + attrStart;

      for (let i = 0; i < attrCount; i += 1) {
        const a = attrBase + i * attrSize;
        if (a + 20 > pos + chunkSize) break;
        const nsIndex = buf.readUInt32LE(a);
        const attrNameIndex = buf.readUInt32LE(a + 4);
        const rawIndex = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        const ns = nsIndex === NONE ? '' : (getString(nsIndex) || '');
        let attrName = getString(attrNameIndex);
        if (!attrName && attrNameIndex < resourceIds.length) {
          const id = resourceIds[attrNameIndex];
          attrName = KNOWN_ATTR_IDS[id] || `attr_0x${(id >>> 0).toString(16)}`;
        }
        if (!attrName) attrName = `attr_${i}`;

        const raw = getString(rawIndex);
        let typed = decodeValue(dataType, data, strings);
        if (raw !== null && (dataType === TYPE_NULL || dataType === TYPE_STRING)) typed = raw;
        const refId = typed && typed.type === 'ref' ? typed.id : null;
        attrs.push({
          ns,
          prefix: ns ? (prefixByUri.get(ns) || '') : '',
          name: attrName,
          value: typed,
          typed,
          refId,
          dataType,
        });
      }

      const node = { name, tag: name, attrs, children: [], parent: stack[stack.length - 1] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (type === RES_XML_END_ELEMENT_TYPE) {
      if (stack.length > 1) stack.pop();
    } else if (type === RES_XML_CDATA_TYPE) {
      // Text nodes are not needed when extracting AndroidManifest metadata.
    }

    pos += chunkSize;
  }

  const manifest = root.children.find((node) => node.name === 'manifest') || root.children[0];
  if (!manifest) throw new Error('AXML document has no root element');
  return manifest;
}

function attr(node, name, ns = ANDROID_NS) {
  if (!node || !Array.isArray(node.attrs)) return null;
  return node.attrs.find((a) => a.name === name && (ns === null || a.ns === ns)) || null;
}

function attrValue(node, name, ns = ANDROID_NS) {
  const value = attr(node, name, ns);
  return value ? value.typed : null;
}

function children(node, name) {
  return node ? (node.children || []).filter((child) => child.name === name || child.tag === name) : [];
}

function findAll(node, name, out = []) {
  if (!node) return out;
  if (node.name === name || node.tag === name) out.push(node);
  for (const child of node.children || []) findAll(child, name, out);
  return out;
}

function findFirst(node, name) {
  return findAll(node, name, [])[0] || null;
}

function findNodes(node, name, out = []) {
  return findAll(node, name, out);
}

module.exports = {
  parseAxml,
  attr,
  attrValue,
  children,
  findFirst,
  findAll,
  findNodes,
  ANDROID_NS,
  TYPE_REFERENCE,
};
