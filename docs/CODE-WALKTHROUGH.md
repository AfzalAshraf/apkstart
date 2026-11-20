# ApkStart code walkthrough

This guide is an entry map for engineers continuing work in ApkStart. It follows current module responsibilities and call paths rather than pinning explanations to line numbers, which become stale after edits.

## Start here

| If the task is about… | Start with… | Then inspect… |
|---|---|---|
| APK metadata or split packages | `src/core/apk.js` | `zip.js`, `axml.js`, `arsc.js`, `installer.js` |
| Install, launch, shortcut, app registry | `src/core/installer.js` | `src/main.js`, `adb.js`, `store.js`, `shortcut.js` |
| Runtime setup or emulator startup | `src/core/engine.js` | `provision.js`, `emulator.js`, `doctor.js`, `userdata.js` |
| Display, rotation, embedded window | `src/main.js` and `src/core/appwin.js` | `display.js`, `agent.js`, `win/agent.ps1` |
| Renderer feature or settings | `src/ui/app.js` | `index.html`, `style.css`, `theme.css`, `app.css`, `preload.js` |
| Update or release package | `src/core/updater.js` | `sources.js`, `download.js`, `build/`, `.github/workflows/` |
| File sync or notifications | `src/core/sharer.js` / `notify.js` | ADB methods and main-process lifecycle callbacks |

## Repository map

```text
src/main.js               Electron main process, lifecycle, tray, app orchestration, IPC
src/preload.js            Typed-by-convention bridge: named methods and event subscriptions
src/ui/index.html         Main renderer markup
src/ui/app.js             Main renderer state and actions
src/ui/shell.*            Per-app host window markup, styling, and state rendering
src/core/                 Domain modules; most are independent of Electron
src/core/win/agent.ps1    Scoped Win32 helper with embedded C# P/Invoke
build/                    Portable package and bundled-runtime preparation
scripts/                  Association and runtime self-test commands
test/                     Unit/regression suites and opt-in host integration probes
tools/                    Diagnostics, timing, and release utilities
docs/                     Architecture and focused engineering guides
```

## Install path: input file to registered app

`src/main.js` accepts installation requests from the renderer and command-line/file-association launches. The main process performs path checks, ensures the runtime is available, and calls `Installer.installApk()`.

`Installer.install()` branches by extension:

- A single `.apk` is parsed by `parseApk()`.
- `.apks` and `.xapk` use `parseBundle()`, which streams APK entries to a temporary directory and inspects the base manifest.

The install pipeline identifies ABI requirements, provisions the required image when configured, installs one APK or multiple splits through `AdbClient`, extracts/materializes icon files, persists the app record, and writes desktop/Start Menu shortcuts according to settings. Bundle temporary files are removed in a `finally` path.

### Things to verify when changing install behavior

- Does the main process call the same method/result shape as `Installer` exports?
- Are bundle paths and cached APK paths handled by both initial install and restore/reinstall?
- Does a launcher alias remain the launched component?
- Are install failures reflected in the renderer's progress state, with no stuck spinner?
- Does shortcut creation honor user settings and return paths stored in the app record?

## Launch path: app record to embedded Android surface

`launchWithFlow()` in `src/main.js` coordinates runtime readiness, opens an `AppWindow`, calls the installer launch method, applies display settings, then embeds the Android surface. The `AppWindow` state is sent to `shell.html` through the `shell:state` event and queried initially through `shell:ready`.

The per-app shell calls named `window.apkstart.shell*` methods exposed by `preload.js`. The main process handles rotate, minimize, maximize, and close. Closing parks/detaches the emulator surface, closes the host, and runs app cleanup.

`WinAgent` is not a generic window manager. The main process declares the runtime scope before it asks the helper to hide or embed windows. The helper locates the correct emulator window, verifies host ownership, and places the guest window beneath Chromium's render child.

## Runtime path: ensure → boot → attach → park

`Runtime.ensure()` is the single high-level entry point used by installer and app launch. It coalesces concurrent requests to avoid launching multiple emulators. It prefers an already-online device, then attempts to adopt a suitable existing runtime, and otherwise provisions or starts the configured engine.

The built-in Android Emulator path is split between:

- `Provisioner`: component paths, downloads, checksums/metadata, extraction, disk guard, system-image materialization, environment checks.
- `EmulatorEngine`: AVD files, hardware profile, launch arguments, readiness probes, retries, logs, and snapshots.
- `doctor.js`: host/environment diagnosis, display profile, resource selection, retry planning, and readable diagnostic reports.
- `container.js`: background-app stop/restore and idle session command sets.
- `AdbClient`: process invocation, device state, install/start/stop, display, input, and shared-file operations.

When the last app window closes, runtime/app state can be parked or snapshotted; an idle policy may later stop the engine. Never change a cleanup path without checking snapshot finalization and app-data preservation.

## UI and IPC path

`src/preload.js` is the renderer's capability boundary. For a new renderer action:

1. Add or reuse one named preload method.
2. Register the exact channel in `src/main.js`.
3. Validate the incoming value in the main process.
4. Handle errors/results in the renderer.
5. Update tests and verify the channel, selector, and asset contracts.

Events such as progress and state changes are separately subscribed through narrow helper methods. Do not add a generic `ipcRenderer` API or expose filesystem/process access to the renderer.

## Build and release path

- `build/pack.js` assembles the portable directory.
- `build/prepare-runtime.js` assembles and compresses a bundled runtime payload.
- `electron-builder.yml` defines the NSIS package and resource inclusion rules.
- `.github/workflows/ci.yml` runs the Windows regression suite.
- `.github/workflows/release.yml` builds and uploads release assets.
- `src/core/updater.js`, `sources.js`, and `download.js` implement asset selection, source ranking, download, extraction, and apply/restart behavior.

The runtime archive and application update archive are different asset types. Keep the updater's selection rules explicit so a runtime bundle cannot be extracted over the application directory.

## Before editing a cross-cutting contract

1. Search for the method/channel/settings key in `src/`, `scripts/`, `test/`, and `tools/`.
2. Read both caller and callee; confirm argument and return shapes.
3. Add a regression assertion at the contract boundary.
4. Run the narrow suite and then `npm test`.
5. Update [Architecture](ARCHITECTURE.md) or the focused parser/runtime guide if the contract changed.
6. Record Windows-only verification separately in `MILESTONES.md`.
