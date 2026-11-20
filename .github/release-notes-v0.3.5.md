# ApkStart v0.3.5 release notes

> This release fixes defects confirmed during code review and on-device testing after v0.3.4.

## What changed

### 1. Support APKs larger than 2 GB (#21)

The old parser read an entire APK into memory. Files larger than 2 GB exceeded Node's single-Buffer limit and could leave the install spinner running after an English error.

- Use a **file-backed ZIP reader** that reads the central directory and loads manifests, resource tables, and icons on demand. Peak memory is now a few megabytes instead of the APK size.
- Extract `.apks` and `.xapk` split packages as streams; clean temporary directories after failures.
- Scale `adb install` timeout by package size (about five minutes for a 2 GB package, capped at 20 minutes) instead of always using four minutes.
- Send install failures through the main-process event path and clear the “Installing...” spinner after an error.

### 2. ZIP64 support for large images and update packages

Add **ZIP64** support (EOCD locator and extra-field ID `0x0001`). Archives with more than 65,535 entries no longer silently lose entries; oversized entry sizes and offsets are read from the extended fields.

### 3. Fix runtime preparation stalls and repeated image downloads

- Report source-ranking progress as each candidate is tested; limit an individual source to six seconds. Unreachable sources move to the end without blocking downloads.
- Show a “Fetching runtime version information...” message before downloading the full runtime bundle.
- Do not swallow system-image extraction failures. Report the filename and error instead of appearing to stall at 99% before downloading another 1.4 GB copy.
- Extract images to `.part` files and atomically rename them after success, so interruptions do not leave a truncated `system.img` that looks complete.
- Consider an image expanded only when its size is at least the compressed input size; truncated files are expanded again.
- Include the full runtime bundle in disk-space estimates (about 1.5 GB compressed plus 3.3 GB expanded at peak) and warn before download when space is insufficient.

### 4. Respect a manually selected runtime directory (#23)

When a portable app had a bundled `runtime/` directory beside it, the old startup logic could replace a manually configured `runtime.dir` with that bundled path. Now an explicitly configured directory is respected if it contains an emulator; automatic takeover occurs only when no directory was selected or the selected directory is unavailable.

### 5. Do not mistake the 1.5 GB runtime archive for an app update

A release may contain both the portable app and `ApkStart-runtime-*.zip`. The old `.zip` fallback could select the runtime archive when the portable package was missing and extract it into the app directory. Fallback matching now excludes runtime assets; if no app package is available, the UI directs users to download manually from the release page.

### 6. Persist startup-failure diagnostics (#20 / #25)

Startup attempts and diagnoses previously existed only in memory. After restarting ApkStart, exported reports showed `attempts: []` and `UNKNOWN`.

- Persist attempts, diagnosis, and exit code to `%APPDATA%\apkstart\logs\last-failure.json`; clear it after a successful boot.
- Include the persisted record, exit-code meaning, and the tail of `emulator.log` in diagnostic reports. Read the last 300 file lines if the in-memory log is empty.
- Diagnose `0xC0000005` (decimal `3221225477`) as a rendering-backend crash and suggest updating graphics drivers or reducing quality.
- Automatically retry this crash with a safer renderer and remember it in `engine.badGpu`, keyed by emulator version.
- Show the previous startup failure directly in the runtime panel in Settings.

### 7. Restore existing `.apk` file associations on uninstall

The old unregister path always cleared the `.apk` default program, despite a comment promising to clear it only when it still pointed to ApkStart.

- Save the previous default program at `HKCU\Software\ApkStart\assocPrev` during registration.
- Restore it when unregistering. If no previous value was saved, clear the association only when it still points to ApkStart.
- Verified locally: a `MuMuPlayer.apk` association was restored after register/unregister.

### 8. Improve app-icon extraction and fallback messaging

- Add `jpg` and `jpeg` to candidate icon formats.
- Recursively resolve bitmap resources in adaptive icons and `layer-list` XML, up to three levels deep.
- If extraction still fails, tell the user that the shortcut is temporarily using a placeholder icon instead of silently showing a green triangle.

### 9. Fix desktop shortcuts that opened the Android home screen

A launcher stored as a complete component such as `com.foo.bar/com.foo.bar/.MainActivity` was being prefixed with the package name again. `am start -n` then received an invalid component and canceled the launch (`result code=-92`), leaving the Android home screen visible.

- Add `componentArg()` to preserve complete components and add a package prefix only to a bare class name; support both historical data formats.
- Make `parseResolvedActivity()` inspect all output lines because `resolve-activity` can end with a blank line.
- Verified after reinstalling Hongguo: `mCurrentFocus` showed `com.phoenix.read/...SplashActivity`, and the app UI appeared instead of the home screen.

### 10. Log-rotation boundary case

When a log filename did not end in `.log`, rotation could delete it before renaming. Skip rotation in that case; a larger log is preferable to losing it.

### 11. Other changes

- Add a synthetic APK fixture (`test/lib/make-apk.js`) with binary AXML, a PNG icon, and ABI directories so parser coverage remains available when no real APK is present.
- Expand regression coverage for ZIP64, `.xapk` extraction, image materialization, update-asset selection, `0xC0000005` diagnosis, log rotation, persisted failures, and WebP icon fallback.
- `npm test` increased from 98 to **113 passing checks**.

## Validation reported for this release

| Check | Result |
|---|---|
| `npm test` | 113 passed, 0 failed (8 + 25 + 80) |
| `electron test/electron-integration.js` | ICO, `.lnk`, and WebP fallback passed |
| Real cold boot | Ready in 25.0 seconds (`sys.boot_completed=1`) |
| Snapshot restore | 5–6 seconds |
| Graceful shutdown | `code=0`, `hasSnapshot=true` |
| Real APK parse | Hongguo Short Drama 7.4.3.32; `res/b/a3.webp`; arm64-v8a detected |
| 2.15 GB APK parse | 18 ms; process RSS 47 MB (the old parser read the full 2.2 GB into memory) |
| Fresh install and desktop shortcut | Shortcut launched `com.phoenix.read/...SplashActivity` in an app window |
| `npm run selftest -- --apk` | **13 checks passed**, covering adb, engine, image, AEHD, Android 14/API 34, freeform, two-way sync, parse, install, app window, and screenshot |
| `tools/check-launch-clean.js` | App window appeared in **0.5 seconds**; no emulator or console windows became visible |
| Install flow | Packaged app parsed and installed a 153 MB APK in 22 seconds; desktop and Start Menu `.lnk` targets, arguments, and icons were correct |
| Window cleanup | `check-quit-clean`: no visible emulator/console windows during boot or for 8 seconds after exit |
| Registry association | Existing `MuMuPlayer.apk` association restored after register/unregister |
| Portable build | 226 MB; UI smoke check passed |

## Known limitations

- The underlying cause of `0xC0000005` remains in the graphics driver/Vulkan backend. This release switches renderers automatically and improves diagnostics; send a new report if a machine still crashes.
- Shape and vector drawable icons are not yet supported; they use the placeholder icon with an explicit notice.
- `.apk` association is per-user (HKCU, no administrator rights). If another program repeatedly reclaims it, Windows **Default apps** settings take precedence.
