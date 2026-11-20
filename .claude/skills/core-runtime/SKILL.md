---
name: apkstart-core-runtime
description: Maintain ApkStart's Node core modules for APK parsing, ADB, runtime provisioning, emulator lifecycle, storage, downloads, and app installation.
---

# Core and runtime department

## Scope

Own `src/core/*.js` except the Windows agent, window controller, and renderer-facing shell. Primary modules include `apk.js`, `axml.js`, `arsc.js`, `zip.js`, `adb.js`, `installer.js`, `engine.js`, `emulator.js`, `provision.js`, `doctor.js`, `display.js`, `container.js`, `store.js`, and download/update helpers.

## Working protocol

- Trace public exports and production consumers before changing signatures or result shapes. `src/main.js`, `scripts/selftest.js`, tests, and the UI bridge can all depend on the same module.
- Keep parsers bounded and defensive. Use `ZipFile`/`pipeTo` for large archives and close file handles in `finally` blocks. Never add copyrighted APK fixtures.
- Keep all user data outside the packaged program tree. Automatic retry must not wipe data; any destructive reset must be explicit.
- Build ADB shell commands from validated values. Prefer a dedicated helper in `adb.js` over command fragments scattered across main/UI code.
- Preserve config migration behavior and compatibility exports until callers are migrated.

## Verification

- Run the narrow suite that covers the module (`test/run-tests.js`, `test/engine-test.js`, or `test/auto-test.js`) and then `npm test`.
- Add synthetic ZIP/AXML/ARSC/APK fixtures for parser changes and isolated temporary roots for filesystem changes.
- For runtime behavior requiring a real emulator, label it as Windows/device-only and provide a repeatable manual test. Do not infer it from a mock.
- Update architecture or parser/runtime walkthrough docs when contracts or data paths change.
