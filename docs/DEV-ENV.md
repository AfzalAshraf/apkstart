# Development environment and command reference

This guide describes a portable development setup. It does not assume a particular developer machine, drive letter, or user profile.

## Requirements

- Windows 10 or 11 x64 for the supported Electron and Win32 integration path.
- Node.js 20 or newer and npm.
- Git and a working C/C++/PowerShell environment only when changing or validating the native helper/build toolchain.
- Additional disk space and network access for Android Emulator and system-image provisioning. Runtime assets are large; keep them outside the source tree where possible.

## Install and run

```powershell
npm ci
npm test
npm start
```

The initial app launch may require downloading Android runtime components. Use a test profile when experimenting with install, reset, cleanup, or runtime-path changes.

## Common commands

```powershell
# Default automated suites (local and deterministic)
npm test

# Build the portable application directory
npm run pack

# Prepare bundled runtime resources, then build the NSIS setup package
npm run runtime
npm run build:exe

# Runtime and Android integration checks (requires a suitable local runtime)
npm run selftest
npm run test:boot

# Register / unregister the .apk association for the current Windows user
npm run assoc:on
npm run assoc:off
```

`npm run test:boot` can download a small Alpine test image and runs a real QEMU boot/shutdown cycle. `npm run selftest` operates on the configured ADB device and may install or launch an APK when given the relevant options. Read the script help and isolate its data directory before running it.

If Electron is installed with its binary, an optional integration test can be launched with:

```powershell
npx electron test/electron-integration.js
```

## Data locations

The exact paths depend on the current settings and packaging flavor. Typical locations include:

| Data | Default / source of truth |
|---|---|
| Settings, app registry, icons, APK cache, logs | `%APPDATA%\apkstart` |
| Runtime root | `settings.runtime.dir`, otherwise the application data runtime directory or bundled resources |
| AVD home | `settings.runtime.avdDir`, otherwise the Provisioner-selected default |
| Shared host folder | `%USERPROFILE%\ApkStartShared` |
| Test outputs | Temporary directories or ignored test output directories |

Use `Provisioner.paths()` and the application's settings as the authority; do not rely on hard-coded developer paths.

## Isolating local tests

- Set `APKSTART_TEST_APK` only to an APK you are authorized to use; never commit it.
- Use temporary `APPDATA`/settings roots for integration tests that mutate the runtime or app registry.
- Keep emulator processes under observation after a failed test. A detached emulator may outlive the Electron process by design so that it can be adopted on the next launch.
- Before cleanup, confirm the target directory belongs to the test profile. Do not delete a runtime or AVD based only on its folder name.

## Troubleshooting

| Symptom | First checks |
|---|---|
| Parser tests mention a missing APK fixture | This is optional; synthetic APK tests should still run. Set `APKSTART_TEST_APK` for an additional real-file check. |
| Runtime is not ready | Inspect the runtime page, `Provisioner.checkEnv()`, selected runtime paths, disk space, and the latest runtime/emulator logs. |
| Emulator launch falls back or exits early | Export a Doctor report and inspect the selected GPU/hypervisor profile, emulator version, failure record, and log tail. |
| AVD appears locked | Confirm no emulator process is using that AVD before removing stale lock files. Use the application's diagnostic/cleanup action or an isolated test profile. |
| Update source is temporarily unavailable | Check release metadata, rate limits, and configured source preference. Regression tests should not require either public service. |
| Windows window does not embed | Verify `agent.ps1` BOM, helper startup/scope, host ownership, Chromium render child lookup, and current emulator window. Run the Windows probes; Node tests cannot validate this boundary. |
| Packaged app cannot decompress a system image | Check the packaged `@napi-rs/lzma` Windows x64 dependency and electron-builder filters, then test a clean package rather than only the development tree. |

## Text encoding and native helper invariants

- Save maintained text files as UTF-8.
- Preserve the UTF-8 BOM at the beginning of `src/core/win/agent.ps1`.
- Keep `src/core/win/windowctl.ps1` pure ASCII.
- After editing a PowerShell/C# helper, run the available syntax/compile checks and a Windows integration probe when possible.

## Release preparation

Before preparing a release, read `.github/workflows/release.yml`, `electron-builder.yml`, and the relevant release-note file. Run the tests and build each required artifact from a clean output directory. Record exact filenames, byte sizes, and checksums. Keep GitHub/Gitee credentials in the CI secrets store; never write tokens to the repository or chat. Do not push tags or publish a release without explicit authorization.
