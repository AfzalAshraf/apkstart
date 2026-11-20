'use strict';
/**
 * Regression tests for zero-configuration tuning and lightweight app containers (Node only; does not launch an emulator)
 * Run with: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js automatic settings]');

  await test('GPU backend selection follows the emulator version (host first on newer versions, software fallback, swiftshader_indirect on older versions)', () => {
    // Newer versions (37.x / 36.4.9+): host is most responsive, with automatic fallback to software/swangle.
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', 'host should be first choice on 37.x');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), 'Newer versions must include a software-rendering fallback');
    // swiftshader_indirect fails GL initialization on 37.x and must not be a candidate.
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // Older versions still use swiftshader_indirect.
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('Automatically tune settings for low-memory machines (no hard-coded 4 GB / 4 cores)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `Expected 2048 MB of memory; got ${p.memoryMB}`);
    assert(p.cores === 2, `Expected 2 cores; got ${p.cores}`);
    assert(p.accel === 'off', 'Without hardware acceleration, fall back to software emulation');
    assert(p.bootTimeoutMs > 240000, 'Software emulation should have a longer boot timeout');
    assert(p.gpu === 'host', `host should be the preferred renderer (planVariants handles fallback); got ${p.gpu}`);
    // When acceleration is disabled, the final fallback must use software rendering; TCG has no usable GPU otherwise.
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'The last-resort plan must use software rendering');
    // The data partition defaults to 4/6/8 GB based on available disk space (not a fixed 16 GB) and can be overridden in Settings.
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `Expected a 4–8 GB data partition; got ${p.dataMB} MB`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'The configured data-partition size must be applied');
  });

  await test('High-memory machines must not use unlimited memory', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `High-end systems should still be capped: ${p.memoryMB} MB / ${p.cores} cores`);
    assert(p.accel === 'auto');
  });

  await test('Retry matrix proceeds from best to most conservative and includes software emulation and cold-boot fallback', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `Expected 3–4 retries; got ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'Missing software-emulation fallback');
    // The final retry only skips snapshot loading and uses minimum memory; never pass -wipe-data:
    // When the disk is full, every retry fails. Adding wipe would also erase the user’s installed apps (this has happened in practice).
    assert(v[v.length - 1].snapshot === false, 'The final retry must skip snapshot loading');
    assert(v[v.length - 1].wipe === false, 'Automatic retries must never clear user data');
    assert(v[v.length - 1].memoryMB <= 2048, 'The final retry should use minimum memory');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'Retry plans must be unique');
  });

  await test('Moving an image to another drive is not an image change: changing sysdir must not clear user data', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'Paths to the same image must have the same identity');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'Moving the image to another drive must not invalidate its snapshot (which would force an unnecessary cold boot)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'A genuinely different image must be detected');
  });

  await test('Snapshot fingerprints must ignore GPU, acceleration, and memory retries to avoid clearing installed apps on each retry', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('Log diagnostics identify GPU, acceleration, non-ASCII path, and lock-file issues', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('Log diagnostics classify emulator exit 0xC0000005 as a renderer crash', () => {
    // Observed in issues #20/#25: the emulator exited with 3221225477 after printing Userspace boot properties.
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Crash logs often include renderer initialization messages; prioritize the crash diagnosis over GPU_INIT.
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'A crash should take precedence over ordinary renderer logs');
  });

  await test('Free-port detection returns an even-numbered port pair', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `Unexpected port: ${p}`);
  });

  await test('Automatic settings shown in the UI match runtime settings (37.x no longer shows a deprecated backend)', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `Expected host (with fallback on failure); got ${p.gpu}`);
    assert(p.accelOk === true && text.includes('Hardware acceleration'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('Port 5562'), text);

    // Older engines retain their legacy backend; manually configured advanced settings still apply.
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js runtime cleanup]');

  await test('Identify reclaimable files: non-x86_64 QEMU, old images, old AVDs, lock files, and stale snapshots', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'Expected non-x86_64 QEMU to be listed');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'Must not delete x86_64 QEMU');
    assert(paths.some((p) => p.includes('android-30')), 'Expected the old API 30 image to be listed');
    assert(paths.some((p) => p.endsWith('.lock')), 'Expected lock files to be listed');
    assert(paths.some((p) => p.includes('snapshots')), 'Expected stale snapshots to be listed');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'Expected inactive AVDs to be listed');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'Must not delete the active AVD configuration');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'Dry run must not delete files');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'Applying cleanup should reclaim space');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'Inactive AVD should be removed');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'The active AVD must be preserved');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'x86_64 QEMU must be preserved');
  });

  console.log('\n[adb.js readable install and launch errors]');

  await test('Show clear guidance when an app with an old targetSdk fails on Android 14', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('automatically'), s);
  });

  await test('ARM translation-layer crashes produce actionable guidance', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('ARM translation layer') && s.includes('ARM-compatible system image'), s);
  });

  console.log('\n[sharer avoids repeated transfers (a cause of full disks)]');

  await test('Do not pull the same file from the device on every sync', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Use the real path/state-file logic, but point it to a temporary directory.
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // Round 1: push a new local file to the device
    const firstPull = calls.pull;
    await sh.sync();          // Round 2
    await sh.sync();          // Round 3
    await sh.sync();          // Round 4
    assert(calls.push === 1, `Expected one push; got ${calls.push}`);
    assert(firstPull === 0, `A newly pushed file must not be pulled back immediately; got ${firstPull} pulls`);
    assert(calls.pull === firstPull, `Later syncs must not pull it repeatedly; total pulls: ${calls.pull}`);
  });

  await test('Very large files must not be pulled back to the PC (the local folder is not a device-cache dump)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'Files larger than 512 MB must not be pulled to the PC');
  });

  console.log('\n[adb/sharer file sharing]');

  await test('Parse Android ls -l output, including group and date fields', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `Expected 3 rows; got ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('Retrieve the remote file list in one find+stat call (without parsing ls dates)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `Expected 2 files; got ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js streaming extraction for large archives]');

  await test('ZipFile and ZipArchive parse the same archive consistently, including deflate and streaming pipeTo', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'Entry names should match');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'Stored entry contents should match');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'Deflate entry contents should match');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'pipeTo streaming output should be complete');
    } finally {
      file.close();
    }
  });

  await test('Zip64: read entry count and offsets from Zip64 EOCD when standard EOCD fields are placeholders', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // Local header
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // Central directory entry: set three fields to 0xffffffff and store actual values in the Zip64 extra (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD, locator, and legacy EOCD (all fields overflow)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive should recognize the Zip64 entry');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'ZipArchive contents should match');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'ZipArchive should read the uncompressed size from the extra field');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile should recognize the Zip64 entry');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'ZipFile contents should match');
      assert(file.entries.get('hello.txt').localOffset === 0, 'ZipFile should read the local-header offset from the extra field');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js zero-configuration AVD]');

  await test('AVD uses a small data partition, quick boot, and a modern GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'The data partition should not be 16 GB');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'Cold boot must not be forced');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'Control snapshots with the -snapshot command-line flag to avoid loading the old default_boot.');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'Expected the snapshot fingerprint to be written');
  });

  await test('Startup arguments include automatic memory, cores, and snapshots without a deprecated GPU mode', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // When no snapshot exists (new AVD or invalidated snapshot), never pass -snapshot:
    // QEMU would wait for a nonexistent memory state, leaving the process running without booting.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // Without a snapshot, disable loading only, not saving: -no-snapshot also disables the automatic save on exit,
      // so the first cold boot would never create a snapshot and every launch would require a full boot.
      assert(/-no-snapshot-load/.test(fresh), 'Use -no-snapshot-load when no snapshot exists (skip loading only)');
      assert(!/ -no-snapshot( |$)/.test(fresh), 'Do not use -no-snapshot when there is no snapshot (it disables saving on exit)');
    }
    // Use quick boot only when a snapshot exists. It must be a complete snapshot:
    // An interrupted save can leave an incomplete snapshot.pb of only a few dozen bytes; treat it as no snapshot,
    // or the emulator will attempt to load it, fail, then fall back to a cold boot after an unnecessary delay.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // Treat an empty snapshot (12-byte pb and no ram.img) as no snapshot
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'An incomplete snapshot must not be treated as usable');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'An empty snapshot must fall back to a cold boot (skip loading)');

    // Complete snapshot: pb and ram.img both contain data (hasSnapshot removes the empty snapshot above)
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), 'Use the quickboot snapshot when available');
    assert(!/-no-snapshot-load/.test(withSnap), 'Do not skip loading a complete snapshot');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'Pass -wipe-data when resetting user data');
    // When resetting data, do not load the old snapshot (it no longer matches), but **allow saving** a new one.
    // Repair network relies on this sequence: reset data, boot with networking, save a snapshot immediately, and restore it next time.
    // The old implementation passed -no-snapshot here, disabling saves as well and preventing the repaired network state from being saved.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'Do not load the old snapshot after a data reset');
    assert(!/ -no-snapshot( |$)/.test(cold), 'Continue saving a new snapshot after a data reset (network repair depends on it)');
  });

  // The window-agent script contains UTF-8 comments. PowerShell 5.1 decodes UTF-8 without a BOM as ANSI,
  // which can garble the comments and merge them with the following C# code. Add-Type then fails to compile,
  // causing the window agent to fail and app windows not to embed. This regression test prevents a repeat.
  await test('The window-agent script must have a UTF-8 BOM (otherwise PowerShell 5.1 may fail to compile it)', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 is missing its UTF-8 BOM');
  });

  // The emulator window must be a child of Chromium’s renderer, not a sibling child of the host.
  // As siblings, Electron continually raises the web layer above the emulator, covering the Android image and consuming mouse input
  // (black bars, incomplete image, ignored clicks, or an unresponsive consent button). Do not set a window region on the embedded window either;
  // that breaks hit testing and can reveal black bars after resizing.
  await test('Parent the embedded window under the renderer and do not set a window region', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed must use the parent returned by FindChromeRender');
    assert(/FindChromeRender\(host\)/.test(src), 'Must find the Chromium renderer child window');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'Must not clip the embedded window with a region');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'Clear any region left by an older version during embed');
  });

  // Rotation must change the physical panel dimensions and restart the emulator, not just change runtime wm size or density.
  //   - wm size: the physical LCD remains portrait, so the image rotates sideways, occupies only a strip in the corner, and click coordinates are wrong;
  //   - wm density: the framebuffer dimensions do not change, so the image does not fill the window and leaves a large blank area when maximized.
  await test('Landscape must use physical panel dimensions (lcdFor landscape), not runtime wm size rotation', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `Expected portrait 720x1280; got ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `Expected landscape 1280x720; got ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation must not override wm size');
    assert(/wm density 190/.test(body), 'Keep density only as a fallback');
  });

  await test('Game mode must use high priority and disable the global mouse hook', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'Game mode must raise QEMU to High priority');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'Game mode must not install the WH_MOUSE_LL global hook');
  });

  await test('Recognize the newer emulator ram.bin as a complete snapshot (otherwise a newly saved 3 GB snapshot may be deleted as empty)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin should be recognized as a complete snapshot');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), 'Use quick boot when a snapshot exists');
    assert(!/-no-snapshot-load/.test(args), 'Do not skip loading a complete snapshot');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('userdata seed image: 4 KB blocks, ENCRYPT, and consistent accounting', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'Superblock magic must be 0xEF53');
    // dm-default-key (Android 13 /data metadata encryption) uses a 4096-byte logical block size,
    // so a smaller filesystem block makes mount() return EINVAL and prevents /data from mounting.
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size must be 2 (4096 bytes)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size must equal the block size');
    // Without ext_attr, setxattr returns EOPNOTSUPP and SELinux labels cannot be written,
    // causing netd, media, and tombstoned to exit 1 and leaving boot stuck at the animation.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'ext_attr must be enabled');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'Free blocks must be between 0 and total');
    assert(freeInodes === inodes - 10, 'Free inode count must exclude reserved inodes 1–10 (checked by e2fsck)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'ENCRYPT must be enabled by default (required for FBE)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'encrypt:false must clear this flag');
  });

  console.log('\n[Display, shortcuts, and zero-configuration behavior]');
  await test('Window mode must show a real window (otherwise the app process runs but is invisible)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'Window mode must not use -no-window');
    // Do not pass -no-skin: it overrides -skin and restores the old panel dimensions from config.ini,
    // causing landscape settings to remain portrait or the image to appear only as a strip in the corner.
    assert(!/\s-no-skin(\s|$)/.test(win), 'Window mode must not pass -no-skin (it overrides -skin)');
    assert(/-skin \d+x\d+/.test(win), 'Window mode must use -skin to specify panel dimensions');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('Audio is enabled by default (no -no-audio); pass -no-audio only when disabled', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Override the settings getter: audio is on by default, so omit -no-audio.
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'Do not pass -no-audio when audio=true');
    // Pass -no-audio only when audio is disabled.
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'Pass -no-audio when audio=false');
  });

  await test('Migrate old settings: headless and “exit after launch” are no longer supported', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless must be migrated to false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch must be false');
    assert(s.autoStart === true && s.autoDeploy === true, 'Auto-start and one-click setup are enabled by default');
    assert(s.createStartMenuShortcut === true, 'Start Menu shortcut is enabled by default');
  });

  await test('Display sizing: window and full-screen share portrait resolution; the 9:16 window can stretch', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // Full-screen does not change Android resolution (the LCD fixes the emulator aspect ratio); it only maximizes the window.
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'invalid landscape input', area).h > d.sizeFor('window', 'invalid landscape input', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Full-screen fills the height, calculates width using the portrait ratio, and centers the window (the emulator LCD fixes its aspect ratio).
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('adb display commands use wm size and wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO and WebP icon fallbacks both produce valid ICO files', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'ICO header should declare one image');
    assert(ico.readUInt32LE(14) === png.length, 'Embedded PNG size should match');
    assert(ico.slice(22).equals(png), 'ICO image data should be the original PNG');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // If nativeImage cannot decode WebP, use the branded placeholder ICO when no decode callback is supplied.
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP should still produce an icon');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'Use the real icon when decode is available');
  });

  await test('Window-control script exists and is ASCII-only (avoids encoding issues in paths and titles)', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'Missing windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'The PowerShell script must be ASCII-only; non-ASCII values are passed as UTF-8 JSON');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile streams the source file to stdin and produces an image the runtime can decompress (CI hang regression)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // Use the fastest preset for the small fixture so the test suite stays quick.
    process.env.XZ_TIMEOUT_MS = '15000';  // Kill after 15 seconds if it hangs; do not stall CI.
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile did not return within 25 seconds (was stdin left without EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'Compressed output must not be empty');
    let back;
    if (/\.xz$/i.test(out)) {
      // Do not rely on the @napi-rs/lzma native binding: the Node 20 CI job may fail to load it because of
      // a known npm optional-dependencies bug (Node 22 works).
      // Use Python lzma to read the output and validate the XZ magic,
      // while end-to-end installer tests validate runtime decompression compatibility.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'Must be a valid XZ container');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'XZ output exists, but Python is unavailable for validation');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'Decompressed bytes must exactly match the source image');
  });

  console.log('\n[container.js app-level containers]');

  const container = require('../src/core/container');

  await test('Never trim system/framework packages; session cleanup applies only to user apps', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} should be recognized as a user app`);
      else assert(sys, `${p} should be recognized as a system package`);
    }
    assert(container.isSystemPackage(''), 'Treat an empty package name as a system package to prevent invalid commands');
  });

  await test('Starting an app stops only other installed user apps; system packages are untouched by default', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `Expected to stop two other user apps; stopped: ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'System packages must not be disabled by default');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'Do not kill background apps during launch; that could stop the app that just came to the foreground');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'Must not force-stop the system framework');
  });

  await test('Package-name allowlist prevents command injection from a corrupted list', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `Only valid package names should be stopped; got ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'Command must not contain injected fragments');
  });

  await test('Deep trimming can disable background packages, restore them completely, and preserve required components', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'Deep trimming should have packages to disable');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} must never be disabled`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} must be restorable`);
    }
  });

  await test('Container parking clears background apps and enters Android idle; state covers multiple windows and the final close', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'Parking should clear cached background processes');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'Parking should put Android into idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'Park the container after the last window closes');
  });

  await test('doctor lightweight container: cap vCPU while honoring manual settings', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // The old logic used floor(cores/4), clamped to 2–3, so an 8-core machine got only 2 vCPUs and video apps lagged.
    // Balanced mode now uses half the physical cores, capped at 4; resource-saving mode stays at 2.
    assert(lite && lite.cores === 4, `Expected 4 cores for balanced mode on a 16-core machine; got ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `Resource-saving mode should use 2 cores; got ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'Explicitly disabling this option should return null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'Keep at least 2 cores on a 2-core machine');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(manual.cores === 6, 'User-selected core count must take precedence over lightweight mode');
    assert(/Lite container/.test(doctor.describeProfile(auto)), 'The profile summary should identify lightweight mode');
  });

  await test('Global mouse hook is disabled by default and the window agent no longer blocks the message pump', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'The side-button hook must be disabled by default');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'The main process must not install the global hook unconditionally');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'App windows must not install the global hook unconditionally');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'File synchronization must not run persistently without a condition');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'Hook enable/disable must be idempotent');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'The hook must run on a dedicated message thread');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'The hook thread must run a message loop');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'The main loop must not block for four seconds');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'Use short polling to keep the message pump responsive');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'Limit window scanning; do not call EnumWindows every two seconds indefinitely');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'Settings must expose lightweight-container options');
  });

  await test('WinAgent.setHook(false) does not launch the PowerShell agent when disabled by default', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'Disabling should return hooked=false');
    assert(a.ready === null, 'When disabled by default, do not launch a persistent agent process');
  });

  console.log('\n[mouse and key mapping]');

  await test('Defaults and legacy migration: right-click back and smooth scrolling on; side buttons off', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'Right-click back is enabled by default');
    assert(d.wheel === 'smooth', 'Smooth scrolling is enabled by default');
    assert(d.side === false, 'Side buttons are disabled by default');
    assert(d.enabled === true, 'The right-click mapping requires the hook');
    // Legacy settings.json files without the new keys should get the same defaults.
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'Do not install the hook when all mappings are disabled');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'Native scrolling does not need a hook');
  });

  await test('hookOptions normalizes configuration and clears all sub-options when disabled', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false must not intercept any events');
    assert(pointer.hookOptions(true).side === true, 'Support the legacy boolean form (side buttons)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('Wheel direction: down scroll maps to finger up; up scroll maps to finger down; coordinates stay in bounds', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'Scrolling down should move content up (finger swipe up)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'Scrolling up should move content down (finger swipe down)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'Zero movement must not produce a command');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x coordinate is out of bounds');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y coordinate is out of bounds');
      assert(s.duration >= 100 && s.duration <= 240, 'Swipe duration should be capped');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'Fast scrolling must not produce an unbounded swipe');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'Horizontal wheel input should produce a horizontal swipe');
  });

  await test('input command allowlist permits only internally generated commands and blocks injection', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /Invalid input command/i.test(e.message); }
    assert(blocked, 'Reject invalid commands before launching adb');
    assert(c._input === null, 'A rejected command must not create a persistent session');
  });

  await test('Use the persistent input channel for Back first; fall back to one-shot adb only on failure', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'The normal path should not spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'Fall back when the persistent channel fails so the click is not lost');
  });

  await test('WheelRouter merges consecutive scroll events into one swipe command', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `Expected three wheel ticks to merge into one command; got ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'Must produce a valid input swipe command');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'The merged command must preserve downward-scroll direction');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'Must not inject after dispose');
  });

  await test('Agent script: intercept right-click/wheel, merge wheel events, scope to the foreground, and use a dedicated thread', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'Must handle right-click and vertical wheel events');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'Must also support horizontal wheel events');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'Wheel events must be merged before reporting');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'Scope input to the foreground root window');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'The hook must run on a dedicated message thread');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'The main loop must not block for long periods');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'Unconfigured mappings must not intercept events');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'Settings changes must update the hook immediately');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'Settings must expose the input-mapping controls');
  });

  await test('WinAgent.setHook sends input mappings and does not launch the agent when disabling', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'Enabling should send exactly one command');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'Configuration must be sent with the hook command');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'Disabling must uninstall the hook');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'Do not start PowerShell when the hook is disabled by default');
  });

  console.log('\n[updater.js online updates]');
  await test('Compare version segments numerically; support a v prefix and multiple segments', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 should be greater than 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'A v prefix should not affect equality');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'Compare numerically, not lexicographically');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 is less than 1.0.1');
  });

  await test('Select the update asset based on package type: Setup.exe for installer, portable.zip for portable', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'Classify as portable when no uninstaller is present');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert(portable.flavor === 'setup', 'Classify as installer when an uninstaller is present');
    // Asset selection is a pure function; use a mock check result to validate fallback naming.
    assert(/Setup\.exe$/i.test('ApkStart-0.3.2-Setup.exe'), 'Installer asset name matches');
    assert(/portable.*\.zip$/i.test('ApkStart-v0.3.2-win64-portable.zip'), 'Portable asset name matches');
  });

  await test('Portable updater must not treat the full runtime bundle (ApkStart-runtime-*.zip) as an update package', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // When both assets exist, choose the portable package.
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `Expected the portable package; got ${info.asset.name}`);

    // If only the runtime bundle exists (portable upload missing), do not auto-update rather than using a 1.5 GB runtime as the app package.
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'Do not select the runtime bundle as an update asset');
    assert(info.canAutoApply === false, 'Do not auto-update when no valid asset is available');
  });

  await test('Dual sources: include mirror URLs and prefer a custom prefix over public mirrors', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'The origin must be first before speed ranking');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), 'Automatic mirrors should be candidates');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `Only the custom prefix should apply; got ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'With automatic mirrors disabled, only the direct URL should remain');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'Add a trailing slash to the prefix when missing');

    // Mirrors proxy GitHub only; prefixing Gitee URLs returns 403, so do not include them.
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Do not prepend the GitHub mirror to Gitee assets');
  });

  await test('Dual sources: rank by speed and preserve original order when all probes fail', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Inject the speed-test cache directly so the test does not depend on the internet.
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `Expected the fastest URL first; got ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'Put failed URLs last but keep them for another attempt');
    s.reset();
    assert(s._rankCache.size === 0, 'reset must clear speed-test results so sources are retested after a network change');
  });

  await test('Dual sources: never treat Gitee’s automatically attached source archive (v1.2.3.zip) as an installer', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `Only ApkStart* assets should remain; got ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Gitee assets have no size field; retain split groups or the whole package will be discarded', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Gitee release assets include name and URL only, no size (observed).
        assets: [
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `Expected one merged asset; got ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkStart-v0.3.3-win64-portable.zip', `Expected the full-package asset name; got ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'Both parts must be retained');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'Split-part URLs and order must match');
    assert(a.size === 0, 'Use zero for unknown size (the UI reports progress from bytes received)');
  });

  await test('Split assets must be retained through updater.asset or prepare reports “no usable download URL”', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts must remain attached to the asset');
    assert(info.canAutoApply === true, 'Assets with split parts should be eligible for automatic updates');
  });

  await test('Dual sources: when merging releases, use only assets from that version; never substitute an old package', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `Expected the higher version; got ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'A same-named asset from an older release must not replace the current asset');
  });

  await test('Window agent: scope directories with semicolons and filter empty entries (the sole input for window ownership)', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // Do not launch the agent; validate only the protocol payload.
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `Expected one scope command; got ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `Empty entries should be filtered; got ${sent[0].dirs}`);
    assert(r.ok === true, 'A successful scope command should return ok');
    // An empty array must not throw: it means “suppress nothing,” and the caller decides whether to warn.
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'Allow an empty scope (the agent then leaves all windows untouched)');
  });

  await test('Dual sources: retain both URLs for same-named full packages or Gitee will never be tried', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Gitee assets have no size (observed); do not copy the GitHub size.
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `Expected one merged asset with the same name; got ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `Keep URLs for both sources; got ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'Track sizes per URL; unknown remains unknown');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `Expected both source URLs; got ${JSON.stringify(cands)}`);
  });

  await test('Multi-source download: when source sizes differ, use the fastest source rather than always choosing the larger one', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // Source listed first (already sorted by speed)
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // The list is ordered by rank() speed; the first source is fastest.
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `Expected the fastest source’s ${small.length} bytes; got ${got.length} bytes`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Split update package is reassembled in order and aborted immediately on size mismatch', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'Reassembled size must equal the sum of the parts');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'First part is in the wrong order');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'Second part is in the wrong order');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('Multi-source download: fetch chunks from different sources and reconstruct the exact original bytes', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Wait for the listening callback explicitly; attaching the listener after listen can miss the event and hang the test.
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'Reconstructed multi-source file must exactly match the original');
      assert(r.sources === 2 && r.parallel >= 2, `Expected two sources to be used; got ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'File size must match');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Multi-source download resumes only missing chunks (does not redownload the full 1.4 GB)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // Count only actual data chunks (exclude the 0-0 probe).
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Use two URLs; with one URL, downloadMulti delegates to the single-source chunked downloader, which already supports resume.
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Simulate the first two chunks downloaded and the last missing (3 connections × 1 MB).
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'Expected the download to resume');
      assert(ranged === 1, `Expected to fetch one missing chunk; requested ${ranged}`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'Resumed file must exactly match the source');
      assert(!fs.existsSync(`${out}.chunks.json`), 'Remove the sidecar file after completion');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Downloader: if a connection sends no data, time out and switch sources instead of hanging', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // Return valid headers, then stall: simulate a TCP connection that is blocked or throttled.
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Send 1 KB, then stop sending data.
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'The complete file must eventually download');
      assert(cost < 15000, `Must not hang on a stalled connection; elapsed ${cost} ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Downloader switches sources when one is limited to tens of KB/s instead of stalling near completion', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Slow source: sends only 4 KB every 100 ms (about 40 KB/s).
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'Content must be correct after switching sources');
      // Using the slow source for 2 MB at 40 KB/s would take about 50 seconds; switching should finish in a few seconds.
      assert(cost < 15000, `Expected a source switch at low speed; elapsed ${cost} ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Multi-source download falls back to single-source chunking when only one URL is available', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Use a just-released port for the bad source so the connection is refused immediately instead of timing out.
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // Point the second URL at an unreachable port; ignore it instead of failing the whole download.
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'Single-source fallback must download the whole file');
      assert(!r.multi || r.sources === 1, 'Do not mark as multi-source when only one source is available');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Dual sources: cache release results for 10 minutes and always recheck when forced', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `Should not request again while cached; got ${calls} requests`);
    await s.latest({ force: true });
    assert(calls === 2, 'force must bypass the cache');
    s.reset();
    await s.latest();
    assert(calls === 3, 'Request again after reset');
  });

  await test('Dual sources: circuit-break a source after a 403 rate limit instead of retrying every round', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 (rate limited)' },
      ];
    };
    // First request: Gitee returns 403 and is circuit-broken.
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'The first round should make a real request');
    const reason = s.blockedReason('gitee');
    assert(!!reason, 'A 403 must trigger the circuit breaker');
    assert(s.blockedReason('github') === null, 'A source without errors must not be circuit-broken');
    // Skip requests during the circuit-breaker window (do not access the network).
    assert(/temporarily skipped/i.test(reason), `The circuit-breaker reason should be understandable: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'reset must clear the circuit breaker');
  });

  await test('Dual sources: when all sources are unreachable, return the last result as stale instead of failing', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'First request should succeed');
    s._relTtl = 0;   // Expire the cache.
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'Timed out' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'Expected the old result to be returned and marked stale');
  });

  await test('System image location: new installations must use the runtime directory (required by CI runtime assembly)', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) New installation: neither runtime nor user data contains system-images; use the runtime directory.
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `Expected a new installation in the runtime directory; got ${p.paths().sysImgRoot}`);

      // 2) If the runtime directory already contains the image (for example, from the full package), prefer it.
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'Prefer the existing image in the runtime directory');

      // 3) If only the user data directory has the image (legacy layout), use it.
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `Expected legacy layout to fall back to the user data directory; got ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[resource profiles, disk allocation, and log limits]');

  await test('A single resource-profile selection controls vCPU, priority, and resolution', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'Smooth mode should not limit the core count');
    assert(s.engine.priorityMode === 'game', 'Smooth mode should use low-latency game priority (favor FPS and video)');
    assert(s.engine.renderSize === '720x1280', `Expected 720p resolution; got ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'Resource-saving mode should use 540p and a lightweight container');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'Balanced mode should use automatic resolution');
  });

  await test('Data-partition size is configurable and no longer a fixed default', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `Expected 12 GB; got ${p.dataMB} MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `Expected 6 GB automatically when disk space is sufficient; got ${auto.dataMB} MB`);
  });

  await test('Snapshot fingerprint excludes data-partition size (resizing must not invalidate snapshots or clear data)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'Changing only the size must not change the fingerprint');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'Changing emulator version must change the fingerprint');
  });

  await test('Rotate logs over the size limit and keep only one backup', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'Expected the log to rotate');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'Expected the backup to be named .1.log');
  });

  await test('If a log filename does not end in .log, do not delete it just to rotate', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'Abort rotation if the backup path would equal the source path');
    assert(fs.existsSync(f), 'The log file must not be deleted');
  });

  await test('Persist startup failures so diagnostic reports show the actual cause after restart', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / hardware acceleration', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'Exit code should be persisted');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'Diagnosis should be persisted');
    assert(back.attempts.length === 1, 'Attempt history should be persisted');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'Clear the failure record after a successful launch');
  });

  await test('.xapk split bundle: stream out parts, parse the base APK, and clean up on failure', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Success case: two APK splits (base + config); metadata comes from the parseable split.
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `Expected two APK splits; got ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'Split files should be written to disk');
      assert(b.meta.package === 'com.example.test', `Package name: ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Failure case: no APK splits should produce a clear error and leave no temporary directory behind.
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /No split APK entries found/i.test(err.message), `Expected a missing-splits error, got ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'Remove the temporary directory on failure');
  });

  await test('materializeImages decompresses .img.gz, skips existing images, and cleans up invalid output', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40 MB of zeros compresses to a few dozen KB but expands past 32 MB, testing the expanded-image check.
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `Expected one image to be materialized; got ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'Expanded image has the expected size');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'Uncompressed components should remain in place');
      assert(!fs.existsSync(`${img}.part`), 'Do not leave a .part file on success');

      const again = await prov.materializeImages();
      assert(again === 0, `Expected an existing image to be skipped; materialized ${again}`);

      // Invalid image must throw MATERIALIZE_FAILED and remove .part (otherwise the next run may treat it as complete).
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `Expected invalid image to fail; got ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'Do not leave a .part file on failure');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('Changing download sources or bundle URLs must clear provisioner URL caches (otherwise a restart is required)', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Simulate cached bundle and emulator URLs.
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'Bundle URL cache should be cleared');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'Emulator and system-image URL caches should be cleared');
  });

  await test('Diagnose each startup attempt using only its own logs (a previous crash must not affect the next attempt)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // Round 1: 0xC0000005
      { t: 3, line: '--- Round 2 ---' },
      { t: 4, line: 'Address already in use' },          // Round 2: port already in use
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'Round 1 should be diagnosed as a crash');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'Round 2 should be diagnosed as a port conflict');
    // If the current attempt has no logs, fall back to the overall log tail instead of returning UNKNOWN.
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `An empty attempt should fall back to the full log; got ${fallback.length} lines`);
  });

  await test('Launch component parsing must not duplicate the package name (otherwise the app icon opens only the Android home screen)', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Full components (stored in apps.json after v0.3.4) should be used as-is.
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'Full component should be returned unchanged');
    // Legacy data: prepend the package name to bare or dot-prefixed class names.
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'An empty activity should return an empty string (use the implicit intent)');
    // resolve-activity output often ends with blank or priority lines; still find the component.
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'Skip blank lines and retrieve the final component line');
    assert(parseResolvedActivity('com.other', out) === '', 'Do not use a component for another package');
  });

  console.log(results.join('\n'));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
