## What changed

### 1. Prevent ApkStart from hiding other Qt applications

The window agent previously identified its own windows by class name:

- `FindEmulator()` matched class names containing `QWindowIcon`, which is used by all Qt top-level windows.
- `HideToolWindows()` matched `QWindowTool`, also used by Qt menus, emoji panels, and floating windows such as `QWindowToolSaveBits`.
- A persistent scan ran every 120 ms, hid matches with `ShowWindow(h, 0)`, and could re-parent them during `embed` or `park`.

WeChat 4.x uses Qt 6 and has a main-window class like `Qt51514QWindowIcon`. Opening ApkStart could therefore hide or embed a WeChat window, leaving a black area.

**Fix: class name is not identity; process path is.**

- Add a `scope` command. Before hiding or embedding windows, the main process supplies the runtime directories and its process ID.
- Every window must pass `IsOurs(pid)`: its executable path must be inside one of the declared directories.
- With no scope, the agent leaves every window alone. Missing an unwanted window is safer than hiding another app.
- Console windows are identified through the conhost parent-process chain or an absolute runtime path in the title, not vague `emulator`/`qemu`/`netsim` title matching.
- `embed` verifies that the host window belongs to the main process, protecting against a recycled window handle.
- The mouse hook checks that its host still exists and belongs to the expected process; stale handles are allowed through.
- Rotation shortcuts are sent only when an ApkStart window is foreground.
- A restarted agent receives the scope again.

**Reported comparison on one machine** (WeChat 4.1.7.59, 296×388 main window):

| Version | WeChat window |
|---|---|
| 0.3.3 | Hidden 3.7 seconds after launch; hidden for all 74 subsequent samples |
| 0.3.4 | Visible throughout 45-second and 280-second runs; never hidden |

### 2. Publish one directly extractable portable ZIP on Gitee

- Replace `Compress-Archive` (.NET Deflate) with 7-Zip `-mx=9`: the same directory shrank from **105.2 MB to 99.8 MB**.
- Remove `d3dcompiler_47.dll` (Windows 8.1 and later provide it in System32; rendering was unchanged), saving another 2.1 MB. Keep `vk_swiftshader` and `vulkan-1` as GPU fallbacks.
- The final archive was **95.0 MiB**, within Gitee's 100 MB single-file limit.
- Add `build/zip.js` to validate entry count and expanded byte size with ApkStart's own ZIP reader. CI fails above 100 MiB instead of silently reverting to split archives.

### 3. Make automatic source selection actually keep both URLs

Assets with the same name were deduplicated by name, keeping whichever source appeared first. Because GitHub came first, the Gitee URL was discarded; after portable releases stopped using split parts, Gitee could never be selected.

- Merge matching asset names into `urls` and store each source's `size` separately.
- Rank sources before download. For multi-source chunks, use the fastest source's total size as the baseline instead of always choosing the largest archive.
- On the test machine, Gitee was fastest among GitHub direct, ghfast, gh-proxy, and Gitee: **95.2 MB in 48 seconds** (about 2 MB/s).

### 4. Other changes

- Window ownership checks now ignore emulators shipped with other products (such as MuMu or LDPlayer), avoiding unnecessary monitoring.
- Window test tools (`check-agent`, `check-console`, `check-windows`, `check-launch-clean`, and `check-quit-clean`) now declare their scope.

## Validation reported for this release

| Check | Result |
|---|---|
| Unit and integration tests | `run-tests` 3; `auto-test` **70 passed, 0 failed** |
| End-to-end with a real runtime, AVD, and Hongguo APK | Install, launch, and embed passed; app window appeared in 0.5 seconds; **0** leaked windows |
| WeChat 4.1.7.59 coexistence | WeChat window was never hidden during emulator start, app install, or embed |
| Gitee portable ZIP | 95.18 MiB; `Expand-Archive` took 5.2 seconds; MD5 matched all 69 source files |
| Download from Gitee | 95.2 MB in 48 seconds; ZIP structure verified |

## Downloads

- Portable `ApkStart-v0.3.4-win64-portable.zip` (**95 MB**): extract and run; the runtime downloads on first launch. GitHub and Gitee both host one complete ZIP.
- Full installer `ApkStart-0.3.4-Setup.exe` (about 1.35 GB): includes adb, the emulator, and system image; available on GitHub because it exceeds Gitee's limit.
