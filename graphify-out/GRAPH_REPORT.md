# Graph Report - apkstart  (2026-11-19)

## Corpus Check
- 91 files · ~115,311 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 9 file(s) not represented in the graph (top: .css 4, (none) 3, .lnk 1)

## Summary
- 1090 nodes · 2446 edges · 65 communities (40 shown, 25 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 208 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `b8771d06`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- AdbClient
- run-tests.js
- main.js
- app.js
- Provisioner
- AppWindow
- Runtime
- EmulatorEngine
- package.json
- steps
- notify.js
- engine-test.js
- electron-builder.yml
- doctor.js
- sources.js
- steps
- display.js
- gen-assets.py
- ref_path
- png.js
- auto-test.js
- WinAgent
- ref_child_process
- cdp.mjs
- WindowController
- ref_fs
- selftest.js
- userdata.js
- leftovers.js
- pointer.js
- windowctl.js
- boot-test.js
- core/assoc.js
- check-update.js
- publish-gitee.js
- check-launch-clean.js
- qemu-real-test.js
- wprobe.js
- layers.js
- ref_os
- pointer-hook-logic.ps1
- emulator.js
- publish-wechat.sh

## God Nodes (most connected - your core abstractions)
1. `AdbClient` - 57 edges
2. `Provisioner` - 52 edges
3. `Runtime` - 47 edges
4. `getSettings()` - 42 edges
5. `WinAgent` - 33 edges
6. `registerIpc()` - 33 edges
7. `EmulatorEngine` - 32 edges
8. `initSubsystems()` - 25 edges
9. `saveSettings()` - 21 edges
10. `Updater` - 20 edges

## Surprising Connections (you probably didn't know these)
- `ensureIso()` --calls--> `downloadParallel()`  [EXTRACTED]
  test/boot-test.js → src/core/download.js
- `registerIpc()` --calls--> `check()`  [EXTRACTED]
  src/main.js → src/core/doctor.js
- `buildApkBytes()` --calls--> `drawAppIcon()`  [EXTRACTED]
  test/lib/make-apk.js → src/core/png.js
- `initSubsystems()` --calls--> `WinAgent`  [EXTRACTED]
  src/main.js → src/core/agent.js
- `initSubsystems()` --calls--> `AndroidSettings`  [EXTRACTED]
  src/main.js → src/core/android.js

## Import Cycles
- None detected.

## Communities (65 total, 25 thin omitted)

### Community 0 - "AdbClient"
Cohesion: 0.06
Nodes (17): AdbClient, assertSafePkg(), COMMON_ADB_LOCATIONS, COMMON_PORTS, componentArg(), { execFile, spawn }, friendlyInstallError(), friendlyLaunchError() (+9 more)

### Community 1 - "run-tests.js"
Cohesion: 0.06
Nodes (34): activityCandidates(), extractIcon(), findLauncherActivity(), fs, isRef(), parseApk(), parseApkZip(), resolveAdaptiveIcon() (+26 more)

### Community 2 - "main.js"
Cohesion: 0.05
Nodes (77): electron, quickCheck(), accentFrom(), crypto, fs, Installer, installStoredApp(), isBundleFile() (+69 more)

### Community 3 - "app.js"
Cohesion: 0.19
Nodes (27): bindEvents(), bindWelcome(), closeWelcome(), collectSettingsPatch(), escapeHtml(), fmtMB(), loadAndroidStatus(), maybeShowDailyWelcome() (+19 more)

### Community 4 - "Provisioner"
Cohesion: 0.13
Nodes (5): absUrl(), baseOf(), execOut(), fetchText(), Provisioner

### Community 5 - "AppWindow"
Cohesion: 0.17
Nodes (4): AppWindow, { BrowserWindow, screen, nativeImage }, hwndInt(), path

### Community 6 - "Runtime"
Cohesion: 0.10
Nodes (11): buildIdleCommands(), buildRestoreCommands(), buildSessionCommands(), isSystemPackage(), NEVER_TRIM, nextSessionState(), OPTIONAL_SYSTEM, parseSdk() (+3 more)

### Community 7 - "EmulatorEngine"
Cohesion: 0.19
Nodes (3): adbEnv(), clearLocks(), EmulatorEngine

### Community 8 - "package.json"
Cohesion: 0.06
Nodes (36): author, bugs, url, dependencies, @napi-rs/lzma@^1.5.3, description, devDependencies, electron@^33.4.11 (+28 more)

### Community 9 - "steps"
Cohesion: 0.07
Nodes (32): name, runs-on, steps, CSC_IDENTITY_AUTO_DISCOVERY, ELECTRON_MIRROR, GH_TOKEN, GITEE_TOKEN, XZ_PRESET (+24 more)

### Community 10 - "notify.js"
Cohesion: 0.18
Nodes (8): isSystemPkg(), { Notification, nativeImage }, NotifyBridge, parseRecords(), SYSTEM_PKGS, { app }, fs, path

### Community 11 - "engine-test.js"
Cohesion: 0.10
Nodes (30): parseStatList(), client(), crypto, download(), downloadMulti(), downloadParallel(), fetchRange(), fs (+22 more)

### Community 12 - "electron-builder.yml"
Cohesion: 0.07
Nodes (29): appId, asar, compression, copyright, directories, buildResources, output, electronLanguages (+21 more)

### Community 13 - "doctor.js"
Cohesion: 0.11
Nodes (24): autoProfile(), check(), collectFullReport(), crypto, describeProfile(), diagnose(), { execFileSync }, formatReport() (+16 more)

### Community 14 - "sources.js"
Cohesion: 0.07
Nodes (21): client(), getJson(), http, https, isGitHubDownload(), mergeReleases(), normalizeAssets(), pickBestRelease() (+13 more)

### Community 15 - "steps"
Cohesion: 0.08
Nodes (24): ELECTRON_SKIP_BINARY_DOWNLOAD, jobs, test, node, name, on, pull_request, push (+16 more)

### Community 16 - "display.js"
Cohesion: 0.26
Nodes (7): autoDensity(), defaultBounds(), densityFor(), DisplayController, fullscreenBounds(), parseSize(), sizeFor()

### Community 17 - "gen-assets.py"
Cohesion: 0.25
Nodes (15): cover(), douyin_base(), download_qr(), dy1(), dy2(), dy3(), dy4(), dy5() (+7 more)

### Community 18 - "ref_path"
Cohesion: 0.18
Nodes (9): fs, path, ROOT, findAdb(), fs, net, path, { spawn } (+1 more)

### Community 19 - "png.js"
Cohesion: 0.23
Nodes (17): chunk(), clamp01(), crc32(), CRC_TABLE, drawAppIcon(), triSdf(), encodePng(), zlib (+9 more)

### Community 20 - "auto-test.js"
Cohesion: 0.12
Nodes (15): chooseProfile(), gpuCandidates(), imageIdentity(), lcdFor(), liteProfile(), parseEmulatorMajor(), planVariants(), snapshotKey() (+7 more)

### Community 21 - "WinAgent"
Cohesion: 0.05
Nodes (22): EventEmitter, fs, net, path, SCRIPT, { spawn }, WinAgent, AVD_HOME (+14 more)

### Community 22 - "ref_child_process"
Cohesion: 0.13
Nodes (10): { app }, { execFile }, path, r, { spawnSync }, [act, x, y], args, path (+2 more)

### Community 23 - "cdp.mjs"
Cohesion: 0.20
Nodes (8): attach(), Cdp, httpGet(), listTargets(), main(), pickTarget(), PORT, sleep()

### Community 25 - "ref_fs"
Cohesion: 0.22
Nodes (6): { app, desktopCapturer, screen }, fs, path, { app, nativeImage }, fs, path

### Community 26 - "selftest.js"
Cohesion: 0.10
Nodes (13): APK, argv, fs, os, path, record(), results, step() (+5 more)

### Community 27 - "userdata.js"
Cohesion: 0.20
Nodes (13): buildEmptyExt4(), buildSuperblock(), createBlankExt4(), fs, isSparseSuper(), os, path, setBitsRange() (+5 more)

### Community 28 - "leftovers.js"
Cohesion: 0.24
Nodes (14): candidateRoots(), clean(), dirSize(), { execFileSync }, fs, norm(), os, path (+6 more)

### Community 29 - "pointer.js"
Cohesion: 0.29
Nodes (5): clamp(), hookOptions(), swipeToCommand(), WheelRouter, wheelToSwipe()

### Community 30 - "windowctl.js"
Cohesion: 0.29
Nodes (6): defaultController, { execFile }, fs, os, path, SCRIPT

### Community 31 - "boot-test.js"
Cohesion: 0.18
Nodes (10): DISK, ensureIso(), fs, ISO, log(), os, path, SERIAL (+2 more)

### Community 32 - "core/assoc.js"
Cohesion: 0.30
Nodes (10): appDir, fs, path, { execFileSync }, notifyShell(), readPrev(), reg(), regDefault() (+2 more)

### Community 33 - "check-update.js"
Cohesion: 0.25
Nodes (4): fs, os, path, { spawn, execFileSync }

### Community 35 - "check-launch-clean.js"
Cohesion: 0.18
Nodes (7): ELECTRON, ENGINE, fs, os, path, ROOT, { spawn }

### Community 36 - "qemu-real-test.js"
Cohesion: 0.20
Nodes (7): CANDIDATES, fs, os, out, path, QEMU, { spawn, execFileSync }

### Community 37 - "wprobe.js"
Cohesion: 0.40
Nodes (4): path, ps1, r, { spawnSync }

### Community 39 - "layers.js"
Cohesion: 0.31
Nodes (8): analyze(), dirSize(), fmtBytes(), fs, isInside(), path, prune(), summary()

### Community 41 - "ref_os"
Cohesion: 0.25
Nodes (4): fs, os, path, TMP

### Community 42 - "pointer-hook-logic.ps1"
Cohesion: 0.36
Nodes (4): DrainEvents(), F(), SetField(), SetOpt()

### Community 44 - "emulator.js"
Cohesion: 0.18
Nodes (11): fs, iniBlock(), path, PRIORITY_SCRIPT, { spawn, execFile }, append(), attachPeriodicTrim(), fs (+3 more)

## Knowledge Gaps
- **25 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AdbClient` connect `AdbClient` to `Runtime`, `EmulatorEngine`, `emulator.js`, `ref_path`, `auto-test.js`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **Should `AdbClient` be split into smaller, more focused modules?**
  _Cohesion score 0.05553923009109609 - nodes in this community are weakly interconnected._
- **Why does `electron` connect `main.js` to `AppWindow`, `package.json`, `notify.js`, `ref_child_process`, `ref_fs`?**
  _High betweenness centrality (0.058) - this node is a cross-community bridge._
- **Should `run-tests.js` be split into smaller, more focused modules?**
  _Cohesion score 0.059154929577464786 - nodes in this community are weakly interconnected._
- **Why does `EmulatorEngine` connect `EmulatorEngine` to `AdbClient`, `Runtime`, `engine-test.js`, `emulator.js`, `doctor.js`, `ref_path`, `auto-test.js`?**
  _High betweenness centrality (0.049) - this node is a cross-community bridge._
- **Should `main.js` be split into smaller, more focused modules?**
  _Cohesion score 0.05339105339105339 - nodes in this community are weakly interconnected._
- **Should `Provisioner` be split into smaller, more focused modules?**
  _Cohesion score 0.13043478260869565 - nodes in this community are weakly interconnected._