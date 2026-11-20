'use strict';
/**
 * Engine and bootstrap tests (no real QEMU / adb / Android required)
 * Covers downloads (including resume), ZIP extraction, environment checks, QEMU arguments, and the monitor protocol.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// Isolate test data so it cannot affect real user settings.
const TMP = path.join(os.tmpdir(), `apkstart-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // A local HTTP server simulates a download source, including Range resume.
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // Fully support start-end Range requests for parallel chunk tests.
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // Explicitly reject Range requests.
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('Complete download and follow redirects', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, 'Unexpected size');
  });

  await test('Resume a partial download', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `Size after resume: ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), 'Resumed content does not match');
    assert(lastPercent > 50, 'Progress was not reported');
  });

  await test('HEAD request and SHA-256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'HEAD Unexpected size');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'Invalid SHA-256 format');
  });

  await test('A SHA-256 mismatch removes the downloaded file', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, 'Expected an error');
    assert(!fs.existsSync(dest), 'A checksum failure should remove the file');
  });

  await test('Parallel chunk download reconstructs the file correctly', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), 'Reconstructed chunks do not match the source');
    assert(r.parallel > 1, `Parallel download was not used: ${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `Too few chunk requests: ${server.rangeHits}`);
    assert(maxPercent > 0, 'Progress was not reported');
  });

  await test('Fall back to a single stream when the source does not support Range', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), 'Fallback download does not match the source');
    assert(!r.parallel, 'Parallel mode should not be used');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('Default runtime directory is under the data directory', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `Unexpected path:  ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64.exe'), 'Unexpected QEMU path');
    assert(p.paths().adbExe.endsWith('adb.exe'), 'Unexpected adb path');
  });

  await test('Empty environment: adb is unavailable but the component structure is valid', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'adb should not be ready');
    // QEMU may be installed system-wide (for example, by winget under Program Files) and should be detected.
    if (env.qemu.ok) assert(env.qemu.version, 'A ready QEMU must report its version');
    assert(env.ready === false, 'The environment should not be ready');
    assert(typeof env.hypervisor.whpx === 'boolean', 'Hypervisor information is missing');
  });

  await test('Built-in ZIP extraction works', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // Construct a minimal ZIP using stored entries.
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', 'Extracted contents do not match');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'ZIP entry could not be read');
  });

  await test('Resolve relative URLs in the SDK index to absolute URLs', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // emulator entries in repository2-3.xml are relative to the repository root.
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'Relative emulator URL was not resolved');
    // System-image indexes are relative to sys-img/android/, not the repository root.
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `Unexpected system-image base URL:  ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'Incorrect system-image relative URL resolution');
    // Absolute URLs should remain unchanged.
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', 'Absolute URL was modified');
  });

  await test('Resolved emulator and system-image URLs are absolute and downloadable', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `Not an absolute URL:  ${u}`);
      assert(/\.zip$/i.test(u), `Not a ZIP URL:  ${u}`);
    }
    assert(/windows_x64/i.test(emuUrl), `Unexpected emulator package platform:  ${emuUrl}`);
  });

  await test('AVD configuration preserves the x86_64 architecture', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `Expected hw.cpu.arch=x86_64, got: ${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'Expected abi.type=x86_64');
    assert(/^image\.sysdir\.1=\S*system-images\//m.test(cfg), 'image.sysdir.1 is missing');
  });

  await test('Install error for NO_MATCHING_ABIS explains the ARM library mismatch', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(out.includes('ARM native libraries'), `Expected an ARM-library explanation: ${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), 'The original error code should be preserved');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(/corrupted|incomplete/i.test(other), `Unknown errors should remain readable: ${other}`);
  });

  await test('Image validation distinguishes valid, corrupt, and incomplete ISO9660 files', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `Valid ISO was rejected: ${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `Corrupt image was not rejected: ${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /incomplete/i.test(c.reason), `An incomplete image was not rejected: ${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('Parse remote stat output and preserve real mtimes to avoid endless retransfers', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `Unexpected number of parsed entries: ${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, 'Incorrect first-row fields');
    assert(rows[1].rel === 'sub/b.png', 'Incorrect relative path for subdirectory');
    assert(rows[1].mtime === 1794309900000, 'mtime was not converted to milliseconds');
    assert(parseStatList('ls: /nope: No such file') === null, 'Non-stat output should return null so the caller can fall back');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, 'An empty directory should return an empty array');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('QEMU arguments: boot from the ISO in install mode', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: true };
    store.saveSettings({
      runtime: { isoPath: 'C:/img/android.iso', diskPath: 'C:/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom C:/img/android.iso'), 'Missing -cdrom');
    assert(/order=d/.test(args), 'Expected boot from the CD-ROM');
    assert(/accel=whpx/.test(args), 'Expected WHPX acceleration');
    assert(/-cpu host/.test(args), 'WHPX should use the host CPU');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), 'Missing adb port forwarding');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), 'Missing monitor');
    assert(/-m 4096/.test(args), 'Incorrect memory argument');
  });

  await test('QEMU arguments: boot from disk in normal mode', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), 'The ISO should not be mounted');
    assert(/order=c/.test(args), 'Expected boot from disk');
    assert(/accel=tcg/.test(args), 'TCG should be used when WHPX is unavailable');
    assert(/-cpu max/.test(args), 'TCG should use max CPU');
    assert(args.includes('if=virtio,format=qcow2'), 'Incorrect disk argument');
  });

  await test('Headless mode hides the virtual machine window', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), 'Expected no display window');
  });

  await test('QEMU monitor protocol: handshake and send a command', async () => {
    // Simulate a QEMU monitor: return "(qemu) " on connect and "ok" after a command.
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `Received:  ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('ensure returns needsSetup when no system is installed', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // Use a fake adb client so isOnline fails quickly.
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, 'The environment should not be ready');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('Concurrent prewarm and launch calls start the runtime only once', async () => {
    const rt = new Runtime(TMP);
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.setPriority = async () => 0;
    let calls = 0;
    rt._ensureInner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, engine: 'emulator' };
    };
    // Prewarm (scheduled four seconds after launch) can overlap with a user-triggered ensure call.
    const [a, b] = await Promise.all([rt.prewarm({}), rt.ensure({})]);
    assert(calls === 1, `Runtime startup was triggered ${calls} times; only one emulator should start`);
    assert(a && a.ok && b && b.ok, 'Both code paths should receive a ready result');
  });

  await test('Startup readiness requires boot_completed and the package manager', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, 'Expected the runtime to be ready');
    assert(calls.some((c) => c.includes('sys.boot_completed')), 'boot_completed was not checked');
    assert(calls.some((c) => c.includes('pm path android')), 'Package manager was not checked');
  });

  await test('Return the kernel stage when Android has not finished booting', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `Expected the kernel stage: ${JSON.stringify(r)}`);
  });

  console.log('\n[provision.js compatibility image / full package]');

  await test('playImageInfo validates the Android 14 compatibility image', async () => {
    const dir = path.join(TMP, 'apkstart', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, 'An undersized image must not be marked ready');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `Expected the API 34 compatibility image to be ready: ${JSON.stringify(info)}`);
  });

  await test('Full-package brand assets and Douyin contact link are present', async () => {
    const root = path.join(__dirname, '..');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'assets', 'douyin-qr.jpg')), 'Missing Douyin QR image');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), 'Missing full-runtime assembly script');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(html.includes('douyin-qr.jpg'), 'About section does not reference the Douyin QR image');
    assert(html.includes('https://v.douyin.com/9TIIxVCANig/'), 'Missing Douyin profile URL');
  });

  console.log(results.join('\n'));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
