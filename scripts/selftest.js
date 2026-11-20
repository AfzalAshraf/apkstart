'use strict';
/**
 * Runtime self-test (no UI required).
 *
 *   npm run selftest                 # check the existing runtime
 *   npm run selftest -- --apk a.apk  # also test install -> launch -> screenshot -> shared folder
 *
 * After Android is set up, this command verifies the main user flows (APK installation, app
 * windows, and file sharing) on the current machine and identifies the failing stage if needed.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Leave empty to use the normal startup path and a dynamic serial; set this to connect an external device.
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nApkStart runtime self-test');
  console.log(`Device: ${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[Components]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb is available', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('adb is not installed; run Runtime Setup first');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator is ready', async () => {
    if (!env.emulator.ok) throw new Error('The runtime engine is not installed; run Runtime Setup first');
    return `v${env.emulator.version}`;
  });
  await step('System image is complete', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'System image is missing');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)} GB`;
  });
  record('Hardware acceleration', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'Falling back to software emulation (works, but is slower)');

  console.log('\n[Device]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('Runtime is ready', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`External device is offline: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'Runtime is unavailable');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\nDevice is not ready; skipping the remaining checks.');
  } else {
    await step('Android version', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('Unable to read the Android version');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('Screen resolution', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size returned no result');
      return `${s.width}×${s.height}`;
    });
    await step('Freeform app windows', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('Could not enable freeform mode (the system may not support multi-window)');
      return 'Enabled';
    });

    console.log('\n[Shared folder]');
    await step('Two-way file sync', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `apkstart selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('apkstart selftest')) throw new Error('Host -> device sync failed');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('Device -> host sync failed');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'Upload and download both work';
    });

    if (APK) {
      console.log('\n[App flow]');
      let meta = null;
      await step('Parse APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('Install on device', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('Package not found by pm path');
          return 'pm path check passed';
        });
        await step('Launch in an app window', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('App is not in the foreground');
          return meta.package;
        });
        await step('Screenshot', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('Screenshot content is invalid');
          return file;
        });
      }
    } else {
      console.log('\n[App flow] Skipped: no --apk argument was provided');
    }
  }

  // Stop a runtime started by this self-test. Otherwise emulator child-process stdio pipes
  // keep the Node event loop alive and make the command appear to hang.
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`Result: ${results.filter((r) => r.ok === true).length} passed, ${failed.length} failed, `
    + `${results.filter((r) => r.ok === null).length} skipped`);
  if (failed.length) {
    console.log('Failed checks:');
    failed.forEach((f) => console.log(`  · ${f.name}: ${f.detail}`));
    process.exit(1);
  }
  console.log('All checks passed ✅\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nSelf-test terminated unexpectedly:', e.message);
  process.exit(1);
});
