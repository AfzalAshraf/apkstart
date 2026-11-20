# ApkStart

<p align="center"><img src="docs/images/logo.png" alt="ApkStart logo" width="160" /></p>

[![CI](https://github.com/RoutineMiku/apkstart/actions/workflows/ci.yml/badge.svg)](https://github.com/RoutineMiku/apkstart/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/RoutineMiku/apkstart?include_prereleases&sort=semver)](https://github.com/RoutineMiku/apkstart/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6.svg)](#requirements)

**Run Android apps on Windows as desktop apps.** ApkStart installs APKs, creates shortcuts, and opens each Android app in its own Windows window.

- Double-click an APK after registering the file association to inspect and install it.
- Create desktop and Start Menu shortcuts that launch an installed app directly.
- Embed the Android Emulator surface in a per-app window instead of presenting the emulator's full management UI.
- Share files through a host folder synchronized with `/sdcard/ApkStartShared`.
- Provision the Android runtime on demand, or use a bundled runtime in the setup build. Connecting to an existing ADB runtime is also supported.

![ApkStart main window](docs/images/app.png)

## Downloads

Get the latest release from [GitHub Releases](https://github.com/RoutineMiku/apkstart/releases). A Gitee mirror may also be published at [gitee.com/daily-miku/apkstart/releases](https://gitee.com/daily-miku/apkstart/releases).

Release assets may include:

- **Setup build** (`ApkStart-*-Setup.exe`): NSIS installer. Releases may bundle the Android runtime; check the release notes and asset size because the runtime is large.
- **Portable build** (`ApkStart-*-win64-portable.zip`): extract and run without installing ApkStart. When no local runtime is available, the application offers runtime setup.
- **Runtime archive** (`ApkStart-runtime-*.zip`): provisioning input, not an application update. Do not extract it over the ApkStart program directory.

Use only release assets published for the version you intend to install. Runtime availability and download size depend on the selected build and the user's settings.

## Requirements and limitations

- Windows 10 or 11, x64.
- Node.js 20 or newer for development; released builds include Electron.
- Android runtime downloads require network access unless a suitable runtime is already present or bundled with the selected release.
- Hardware acceleration depends on the host and Windows virtualization configuration. ApkStart can fall back to software rendering, which may be substantially slower.
- Android apps can enforce device, sensor, integrity, ABI, or account requirements that an emulator cannot satisfy. ARM translation is not a guarantee that every ARM-only app will work.
- App installs and app data are stored in the Android runtime/AVD. Windows file sharing is implemented as synchronization, not as a direct NTFS mount inside Android.

## Build from source

The supported development target is Windows x64. From a clean checkout:

```powershell
npm ci
npm test
npm start
```

The first run may require downloading Android runtime components. To register or remove the `.apk` file association for the current Windows user:

```powershell
npm run assoc:on
npm run assoc:off
```

Build the portable application directory:

```powershell
npm run pack
```

Prepare the runtime payload and build the NSIS setup package (requires the runtime components and the build tools used by `prepare-runtime.js`):

```powershell
npm run runtime
npm run build:exe
```

For additional development and packaging details, see [Development environment](docs/DEV-ENV.md) and [Contributing](CONTRIBUTING.md).

## Runtime and data

ApkStart can provision platform-tools, the Android Emulator, system images, and optional acceleration components. The runtime and AVD locations can be configured in the application settings. The default user data directory is under `%APPDATA%\apkstart`; a separate AVD directory may be selected for larger disks.

The emulator runtime is independent of third-party emulator applications. An existing ADB-compatible device can be attached as an optional alternative. Android system images and other redistributable components remain subject to their respective licenses and are obtained according to the selected provisioning route.

The default shared folder is `%USERPROFILE%\ApkStartShared`, synchronized with `/sdcard/ApkStartShared`. Treat it as a convenience sync folder, not a transactional or instantaneous filesystem mount.

## Tests

```powershell
npm test
```

`npm test` runs the parser/synthetic-APK suite, the engine/provisioning suite, and the broader regression suite. At the v0.4.3 audit checkpoint it completed with **117 passed and 0 failed**. A real APK fixture is optional; the synthetic APK tests run without distributing a third-party APK.

Additional Windows- or runtime-dependent checks include:

```powershell
npm run test:boot
npm run selftest
node test/electron-integration.js
```

The boot and self-test commands require the corresponding runtime/tools and may interact with a local Android environment. Run them only with an isolated test profile. Static checks and Node tests do not verify actual Win32 window embedding; see [the milestone gates](MILESTONES.md) for the required integration checks.

## Repository map

```text
src/main.js                 Electron main process, application lifecycle, IPC orchestration
src/preload.js              Explicit renderer API allowlist
src/ui/                     Vanilla HTML/CSS/JavaScript renderer and per-app shell
src/core/                   APK parsing, ADB, runtime, emulator, storage, windows, updates
build/                      Portable and bundled-runtime packaging
scripts/                    User-facing command-line helpers and self-tests
test/                       Node regression tests and opt-in Windows/runtime probes
tools/                      Diagnostics and release utilities
docs/                       Architecture, walkthroughs, and development guides
```

## Architecture and security

The Electron main process owns privileged operations. The renderer has no Node integration and can call only methods explicitly exposed by the preload script. Android commands are routed through the ADB client; generated input commands are validated. The Windows helper scopes window operations to ApkStart's runtime before hiding or embedding emulator windows.

For component boundaries, runtime lifecycle, archive handling, and the Windows embedding path, see [Architecture](docs/ARCHITECTURE.md) and the [code walkthrough](docs/CODE-WALKTHROUGH.md).

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), run `npm test`, and include platform-specific evidence for behavior that cannot be exercised in Node.

## License

ApkStart is licensed under the [MIT License](LICENSE). Android system images, emulator binaries, Google components, and other third-party runtime assets are distributed or downloaded under their own licenses; review the relevant terms before redistributing them.
