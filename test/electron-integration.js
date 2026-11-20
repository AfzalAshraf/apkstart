'use strict';
/**
 * Electron integration tests: validate ICO generation, shortcut creation, and writing a real app icon.
 * Run with: electron test/electron-integration.js
 * Output: test/out/result.json
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { steps: [] };
  const step = (name, ok, detail = '') => {
    result.steps.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name} ${detail}`);
  };

  try {
    const { drawAppIcon } = require('../src/core/png');
    const { pngToIco, writeShortcut, removeShortcut, iconToIco } = require('../src/core/shortcut');
    const { parseApk } = require('../src/core/apk');

    // 1. App icon → PNG → ICO.
    const png = drawAppIcon(256);
    fs.writeFileSync(path.join(OUT, 'icon.png'), png);
    const ico = pngToIco(png);
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
    step('Generate ICO', !!ico && ico.length > 1000, `${ico ? ico.length : 0} bytes`);

    // 1b. WebP fallback: if nativeImage cannot decode WebP, the decode callback must be used,
    // or use a branded placeholder and report it accurately (installation shows a non-fatal warning).
    {
      // Minimal 1x1 WebP.
      const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
      let noDecoder = '';
      const placeholderIco = await iconToIco(webp, { onFallback: (why) => { noDecoder = why; } });
      step('WebP without a decoder produces a valid ICO and reports placeholder fallback',
        !!placeholderIco && placeholderIco.length > 100 && /placeholder|webp-decode-failed/.test(noDecoder),
        noDecoder || '(no callback)');

      let decoded = 0;
      const viaDecode = await iconToIco(webp, {
        decode: async () => { decoded++; return png; },
        onFallback: (why) => { throw new Error(`Unexpected fallback: ${why}`); },
      });
      // If nativeImage gains WebP support, decoded stays zero; either path passes if a valid ICO is produced.
      step('WebP icon produces a final ICO', !!viaDecode && viaDecode.readUInt16LE(2) === 1,
        `decode calls: ${decoded}, ${viaDecode ? viaDecode.length : 0} bytes`);
    }

    // 2. Shortcut.
    const lnk = path.join(OUT, 'test.lnk');
    writeShortcut({
      shortcutPath: lnk,
      target: process.execPath,
      args: '--version',
      iconIcoPath: path.join(OUT, 'icon.ico'),
      description: 'ApkStart integration test',
    });
    step('Create .lnk shortcut', fs.existsSync(lnk));
    removeShortcut(lnk);
    step('Delete .lnk shortcut', !fs.existsSync(lnk));

    // 3. Real APK icon → ICO.
    const fixture = process.env.APKSTART_TEST_APK
      || (() => {
        try {
          const dl = path.join(process.env.USERPROFILE || '', 'Documents');
          return fs.readdirSync(dl).map((f) => path.join(dl, f)).find((f) => /\.apk$/i.test(f));
        } catch (_) { return null; }
      })();
    if (fixture) {
      const meta = parseApk(fixture);
      const iconIco = pngToIco(meta.iconPng);
      if (iconIco) {
        fs.writeFileSync(path.join(OUT, 'app.ico'), iconIco);
        step('APK icon → multi-size ICO', true, `${meta.label}: ${iconIco.length} bytes`);
      } else {
        step('APK icon → multi-size ICO', false, 'pngToIco returned no data (the icon may use a format other than WebP or JPEG)');
      }
    }

    result.ok = result.steps.every((s) => s.ok);
  } catch (e) {
    result.error = e.message;
    result.ok = false;
    console.error(e);
  }

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
