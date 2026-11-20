# ApkStart architecture

ApkStart is a Windows desktop host for Android applications. Electron owns the desktop UI and lifecycle; the Android Emulator (or an explicitly attached ADB runtime) executes the guest application. ApkStart does not implement an Android kernel, hypervisor, or ARM translator.

## Component layers

```text
┌────────────────────────────────────────────────────────────────┐
│ Renderer: src/ui (HTML/CSS/JS)                                  │
│                 │ named methods only                           │
├─────────────────▼──────────────────────────────────────────────┤
│ Preload: src/preload.js (contextBridge allowlist)               │
│                 │ IPC                                           │
├─────────────────▼──────────────────────────────────────────────┤
│ Main process: src/main.js (windows, tray, lifecycle, IPC)       │
├─────────────────┬──────────────────────────────────────────────┤
│ Application     │ Runtime and domain services                  │
│ installer.js    │ engine.js / emulator.js / provision.js        │
│ apk.js          │ adb.js / display.js / container.js / store.js │
├─────────────────┴──────────────────────────────────────────────┤
│ Win32 integration: appwin.js → agent.js → win/agent.ps1         │
│ Android guest: ADB client → emulator / attached device          │
└────────────────────────────────────────────────────────────────┘
```

`src/core/` is mostly Node.js code. Windows window manipulation is isolated behind `WinAgent`, which communicates with a long-lived PowerShell process over newline-delimited JSON on loopback TCP. The renderer never receives direct access to Node APIs or arbitrary shell commands.

## Main workflows

### Install an APK or split bundle

1. The main process validates the path and archive signature.
2. `Installer` parses a single APK through `parseApk`, or streams `.apks`/`.xapk` entries to an isolated temporary directory.
3. `ZipFile`, `axml.js`, and `arsc.js` extract package metadata, launcher intent, ABI directories, and candidate icons without an external Android SDK tool.
4. `Installer` provisions or connects to a runtime, installs the APK (or split set), persists the app record, materializes an ICO, and creates enabled shortcuts.
5. Temporary split files are cleaned whether installation succeeds or fails.

The APK's launcher intent filter is authoritative when present. An `activity-alias` that owns the launcher intent is kept as the launch component; it must not be replaced blindly with a potentially non-exported target activity.

### Launch an installed app

1. The main process ensures the runtime and gets an ADB client.
2. The installer restores the app from its cached APK if it is missing, applies foreground preparation, and starts its resolved component.
3. `AppWindow` creates or reuses a frameless Electron host window and displays a startup overlay.
4. `WinAgent` locates the emulator surface within the explicitly scoped runtime, validates the host, and reparents the surface beneath Chromium's render child.
5. Resize/move/focus events update the embedded window and foreground-scoped pointer mappings.
6. Closing the host parks the emulator surface before destroying the host and stops the Android app through the close callback.

The embedded surface is native Win32 window composition, not a screenshot stream. Z-order and parent-child relationships are therefore part of the input and rendering contract.

### Runtime lifecycle

`Runtime` coordinates three cases:

1. Reuse an already-online ADB device, including a previously prewarmed runtime.
2. Start/manage the built-in Google Android Emulator through `EmulatorEngine` and `Provisioner`.
3. Use the legacy QEMU/Android-x86 path for explicit advanced configurations.

Provisioning resolves runtime paths, checks required components and disk capacity, downloads and validates assets, and materializes compressed system images. `EmulatorEngine` creates the AVD configuration, derives resource profiles through `doctor.js`, retries safe boot variants, captures diagnostics, and manages validated quickboot snapshots. `container.js` limits background app activity between ApkStart sessions; automatic retries must not wipe user data.

### Display and orientation

The AVD's physical LCD profile, Android's logical orientation, and the Windows host window must agree. A landscape transition can require a controlled emulator restart so the emulator framebuffer is created with the correct panel dimensions. Treating `wm size` or a global Ctrl+Arrow key as a substitute for a physical panel change can leave the image rotated, incorrectly laid out, or misaligned with pointer coordinates.

`DisplayController` applies resolution, density, orientation, and immersive policy where appropriate. `AppWindow` owns host window sizing and embedding. Test orientation changes together with touch input, window resize, maximize/restore, and restart recovery.

## Process and security boundaries

- **Renderer:** no Node integration; uses `window.apkstart` methods from the preload allowlist.
- **Preload:** exposes specific operations and event subscriptions, never a generic IPC transport.
- **Main process:** validates request data and owns filesystem, process, dialog, and shell access.
- **ADB:** receives known commands through `AdbClient`. Pointer injection uses a strict command allowlist; arbitrary renderer text must never reach a shell.
- **Win32 agent:** operates only on processes inside configured runtime directories. It validates window ownership before hiding or embedding, and only installs global pointer hooks while the app window is foreground and an opted-in mapping is active.
- **Archive handling:** APK and release archives may be large or malformed. Use bounded reads/streaming, validate extraction targets, and close descriptors and temporary resources on every path.

## Data and storage

`store.js` persists settings and app metadata under the per-user application data directory. Runtime binaries, system images, AVD state, snapshots, app APK backups, icons, and logs have separate paths and may be redirected where supported. Never assume that the installation directory is a safe place for mutable user data; upgrades must preserve the user data and AVD locations.

The shared folder is synchronized between the Windows directory and `/sdcard/ApkStartShared`. It is not a direct filesystem mount and should not be treated as a transactional cross-device filesystem.

## Tests and verification boundaries

- `test/run-tests.js`: ZIP, PNG, synthetic AXML/APK and metadata contracts.
- `test/engine-test.js`: downloads against a local server, provisioning helpers, runtime readiness, and legacy QEMU argument tests.
- `test/auto-test.js`: focused regression contracts for doctor profiles, snapshots, ZIP64/streaming, installer behavior, pointer mapping, updater selection, storage, and other audited fixes.
- `test/` and `tools/` also contain opt-in Windows, Electron, and emulator probes.

A passing Node suite does not prove the native window can be embedded on a particular Windows build. Use the v0.4.3 integration gate in [MILESTONES.md](../MILESTONES.md) before claiming end-to-end Windows verification.
