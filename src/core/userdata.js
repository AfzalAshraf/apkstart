'use strict';
/**
 * Minimal EXT4 sparse/raw `userdata.img` generator (`createBlankExt4`).
 *
 * Writes a valid EXT4 superblock, group descriptor table, block/inode bitmaps,
 * and root directory inode so QEMU/Android boots cleanly on first launch and
 * `init`/`e2fsck` prepares `/data` automatically.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BLOCK = 4096;
const BLOCKS_PER_GROUP = 32768;
const INODES_PER_GROUP = 8192;
const INODE_SIZE = 256;
const EXT4_SUPER_MAGIC = 0xef53;

function writeBlankExt4(filePath, sizeMB = 4096) {
  const totalBytes = BigInt(sizeMB) * 1024n * 1024n;
  const totalBlocks = Number(totalBytes / BigInt(BLOCK));
  const groups = Math.max(1, Math.ceil(totalBlocks / BLOCKS_PER_GROUP));
  const totalInodes = groups * INODES_PER_GROUP;
  const inodeTableBlocks = (INODES_PER_GROUP * INODE_SIZE) / BLOCK;

  const fd = fs.openSync(filePath, 'w');
  try {
    fs.ftruncateSync(fd, Number(totalBytes));

    const gdtBlocks = Math.max(1, Math.ceil((groups * 32) / BLOCK));
    const gdt = Buffer.alloc(gdtBlocks * BLOCK, 0);
    let freeBlocksTotal = 0;
    let freeInodesTotal = 0;

    for (let g = 0; g < groups; g++) {
      const groupStart = g * BLOCKS_PER_GROUP;
      const blocksInThisGroup = Math.min(BLOCKS_PER_GROUP, totalBlocks - groupStart);
      const hasBackup = g === 0 || isSparseSuper(g);
      const metaHead = hasBackup ? (1 + gdtBlocks) : 0;

      const blockBitmapBlk = groupStart + metaHead;
      const inodeBitmapBlk = blockBitmapBlk + 1;
      const inodeTableBlk = inodeBitmapBlk + 1;
      const firstDataBlk = inodeTableBlk + inodeTableBlocks;
      const usedInGroup = (firstDataBlk - groupStart) + (g === 0 ? 1 : 0);
      const freeInGroup = Math.max(0, blocksInThisGroup - usedInGroup);
      const freeInodesInGroup = g === 0 ? (INODES_PER_GROUP - 10) : INODES_PER_GROUP;

      freeBlocksTotal += freeInGroup;
      freeInodesTotal += freeInodesInGroup;

      const off = g * 32;
      gdt.writeUInt32LE(blockBitmapBlk, off + 0);
      gdt.writeUInt32LE(inodeBitmapBlk, off + 4);
      gdt.writeUInt32LE(inodeTableBlk, off + 8);
      gdt.writeUInt16LE(freeInGroup & 0xffff, off + 12);
      gdt.writeUInt16LE(freeInodesInGroup & 0xffff, off + 14);
      gdt.writeUInt16LE(g === 0 ? 1 : 0, off + 16);

      const bbm = Buffer.alloc(BLOCK, 0);
      setBitsRange(bbm, 0, usedInGroup);
      setBitsRange(bbm, blocksInThisGroup, BLOCKS_PER_GROUP);
      fs.writeSync(fd, bbm, 0, BLOCK, blockBitmapBlk * BLOCK);

      const ibm = Buffer.alloc(BLOCK, 0);
      if (g === 0) setBitsRange(ibm, 0, 10);
      setBitsRange(ibm, INODES_PER_GROUP, BLOCK * 8);
      fs.writeSync(fd, ibm, 0, BLOCK, inodeBitmapBlk * BLOCK);

      if (g === 0) {
        const rootDirBlk = firstDataBlk;
        writeRootInodeAndDir(fd, inodeTableBlk, rootDirBlk);
      }
    }

    const sb = buildSuperblock({ totalBlocks, totalInodes, freeBlocksTotal, freeInodesTotal });
    const block0 = Buffer.alloc(BLOCK, 0);
    sb.copy(block0, 1024);
    fs.writeSync(fd, block0, 0, BLOCK, 0);
    fs.writeSync(fd, gdt, 0, gdt.length, BLOCK);

    for (let g = 1; g < groups; g++) {
      if (!isSparseSuper(g)) continue;
      const base = g * BLOCKS_PER_GROUP * BLOCK;
      const b = Buffer.alloc(BLOCK, 0);
      const sbCopy = Buffer.from(sb);
      sbCopy.writeUInt16LE(g, 0x5a);
      sbCopy.copy(b, 0);
      fs.writeSync(fd, b, 0, BLOCK, base);
      fs.writeSync(fd, gdt, 0, gdt.length, base + BLOCK);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function isSparseSuper(g) {
  if (g <= 1) return true;
  for (const p of [3, 5, 7]) {
    let n = g;
    while (n % p === 0) n /= p;
    if (n === 1) return true;
  }
  return false;
}

function setBitsRange(buf, from, to) {
  for (let i = from; i < to; i++) {
    const byteIdx = i >> 3;
    if (byteIdx >= buf.length) break;
    buf[byteIdx] |= 1 << (i & 7);
  }
}

function buildSuperblock({ totalBlocks, totalInodes, freeBlocksTotal, freeInodesTotal }) {
  const sb = Buffer.alloc(1024, 0);
  const now = Math.floor(Date.now() / 1000);
  sb.writeUInt32LE(totalInodes, 0x00);
  sb.writeUInt32LE(totalBlocks, 0x04);
  sb.writeUInt32LE(Math.floor(totalBlocks * 0.02), 0x08);
  sb.writeUInt32LE(freeBlocksTotal, 0x0c);
  sb.writeUInt32LE(freeInodesTotal, 0x10);
  sb.writeUInt32LE(0, 0x14);
  sb.writeUInt32LE(2, 0x18);
  sb.writeUInt32LE(2, 0x1c);
  sb.writeUInt32LE(BLOCKS_PER_GROUP, 0x20);
  sb.writeUInt32LE(BLOCKS_PER_GROUP, 0x24);
  sb.writeUInt32LE(INODES_PER_GROUP, 0x28);
  sb.writeUInt32LE(now, 0x2c);
  sb.writeUInt32LE(now, 0x30);
  sb.writeUInt16LE(0, 0x34);
  sb.writeUInt16LE(0xffff, 0x36);
  sb.writeUInt16LE(EXT4_SUPER_MAGIC, 0x38);
  sb.writeUInt16LE(1, 0x3a);
  sb.writeUInt16LE(1, 0x3c);
  sb.writeUInt32LE(now, 0x40);
  sb.writeUInt32LE(0, 0x48);
  sb.writeUInt32LE(1, 0x4c);
  sb.writeUInt32LE(11, 0x54);
  sb.writeUInt16LE(INODE_SIZE, 0x58);

  sb.writeUInt32LE(0x0038, 0x5c);
  sb.writeUInt32LE(0x0242, 0x60);
  sb.writeUInt32LE(0x0001, 0x64);

  for (let i = 0; i < 16; i++) sb[0x68 + i] = (i * 37 + 0x5a) & 0xff;
  Buffer.from('userdata\0').copy(sb, 0x78);

  sb.writeUInt16LE(32, 0xfe);
  sb.writeUInt32LE(now, 0x108);
  return sb;
}

function writeRootInodeAndDir(fd, inodeTableBlk, rootDirBlk) {
  const now = Math.floor(Date.now() / 1000);
  const inode = Buffer.alloc(INODE_SIZE, 0);
  inode.writeUInt16LE(0x41ed, 0x00);
  inode.writeUInt32LE(BLOCK, 0x04);
  inode.writeUInt32LE(now, 0x08);
  inode.writeUInt32LE(now, 0x0c);
  inode.writeUInt32LE(now, 0x10);
  inode.writeUInt16LE(2, 0x1a);
  inode.writeUInt32LE(BLOCK / 512, 0x1c);
  inode.writeUInt32LE(0x00080000, 0x20);

  inode.writeUInt16LE(0xf30a, 0x28 + 0);
  inode.writeUInt16LE(1, 0x28 + 2);
  inode.writeUInt16LE(4, 0x28 + 4);
  inode.writeUInt32LE(0, 0x28 + 12);
  inode.writeUInt32LE(1, 0x28 + 16);
  inode.writeUInt16LE(0, 0x28 + 18);
  inode.writeUInt32LE(rootDirBlk, 0x28 + 20);
  inode.writeUInt16LE(32, 0x80);

  fs.writeSync(fd, inode, 0, INODE_SIZE, inodeTableBlk * BLOCK + INODE_SIZE * 1);

  const dir = Buffer.alloc(BLOCK, 0);
  dir.writeUInt32LE(2, 0);
  dir.writeUInt16LE(12, 4);
  dir[6] = 1; dir[7] = 2; dir[8] = 0x2e;
  dir.writeUInt32LE(2, 12);
  dir.writeUInt16LE(BLOCK - 12, 16);
  dir[18] = 2; dir[19] = 2; dir[20] = 0x2e; dir[21] = 0x2e;
  fs.writeSync(fd, dir, 0, BLOCK, rootDirBlk * BLOCK);
}

function createBlankExt4(filePath, sizeMB = 4096) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        writeBlankExt4(filePath, sizeMB);
        resolve(filePath);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/** Build an in-memory minimal EXT4 seed image for callers that need a Buffer. */
function buildEmptyExt4({ sizeMB = 64, encrypt = true } = {}) {
  const file = path.join(os.tmpdir(), `apkstart-userdata-${process.pid}-${Date.now()}.img`);
  try {
    writeBlankExt4(file, sizeMB);
    const image = fs.readFileSync(file);
    const featureOffset = 1024 + 0x60;
    const flags = image.readUInt32LE(featureOffset);
    image.writeUInt32LE(encrypt ? (flags | 0x10000) : (flags & ~0x10000), featureOffset);
    return image;
  } finally {
    try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
  }
}

module.exports = { buildEmptyExt4, createBlankExt4, writeBlankExt4 };
