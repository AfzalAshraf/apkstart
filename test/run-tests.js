'use strict';
/**
 * Pure Node unit tests (no Electron, adb, or network required).
 * Run with: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('Parse a ZIP package.json entry from the current project', () => {
  // Verify parsing with a minimal in-memory ZIP using stored entries.
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // Central directory size
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // Central directory offset

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'Expected hello.txt to be present');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', 'Contents should match');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('PNG encoder emits a valid signature and IHDR', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'PNG signature');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'Reasonable output length');
});
test('App icons can be rendered at arbitrary sizes', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `Expected width ${s}; got ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// Test fixture: prefer the APKSTART_TEST_APK environment variable,
// then check common local APK locations (read-only; files are not copied).
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (Fixture: ${fixture})`);
  test('quickCheck recognizes the PK signature', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('Parse package name, version, and launch activity', () => {
    assert(/^[\w.]+$/.test(meta.package), `Unexpected package name: ${meta.package}`);
    assert(meta.versionName, 'Missing versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `Unexpected launch activity: ${meta.launchActivity}`);
  });
  test('Parse an available app icon', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'Icon is missing or too small');
    assert(meta.label, 'App label is empty');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('AXML root element is manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('Parse resources.arsc', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'Expected at least one package');
    }
  });
} else {
  console.log('  (Skipped: no APK fixture found; set APKSTART_TEST_APK to provide one.)');
}

// The synthetic APK builder in test/lib/make-apk.js keeps parser coverage when no real fixture is available,
// and is shared by run-tests and auto-test to avoid duplicate binary builders.
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[Synthetic APK: end-to-end AXML and APK parsing]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('attrValue namespace behavior: null means any namespace; default is Android only', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: 'Demo' },
      ],
    };
    // Non-namespaced attributes (such as package) require null; parseApk relies on this behavior.
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package requires ns=null');
    assert(attrValue(node, 'package') === null, 'Default lookup should only use the Android namespace');
    assert(attrValue(node, 'label') === 'Demo', 'Android attributes use the default namespace');
    assert(attrValue(node, 'label', null) === 'Demo', 'With ns=null, the Android attribute should be found');
  });
}
{
  const tmp = path.join(os.tmpdir(), `apkstart-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('Package name: manifest package is a non-namespaced attribute', () => {
      assert(meta.package === 'com.example.test', `Actual value: ${meta.package}`);
    });
    test('App name, version, and SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('Parse launch activity from the intent filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('ABI directory and icon resource', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'Icon should be PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'File size should be populated');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
