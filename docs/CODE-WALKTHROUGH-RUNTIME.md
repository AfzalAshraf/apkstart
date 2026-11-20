# Runtime and update walkthrough

This guide follows the runtime path from configured locations and downloaded assets to a ready Android device, then covers application updates. Check the current implementation before editing: paths, caches, and result shapes are contracts shared by the main process and core modules.

## High-level dependency flow

```text
src/main.js
  └─ Runtime (src/core/engine.js)
       ├─ Provisioner (provision.js) ── Sources (sources.js) ── download.js
       ├─ EmulatorEngine (emulator.js) ── doctor.js / userdata.js / logfile.js
       ├─ AdbClient (adb.js)
       └─ container.js / layers.js

src/main.js ── Updater (updater.js) ── Sources / download.js / zip.js
```

`version.js` holds version comparison independently so release-source and updater code do not need a circular dependency.

## Runtime path ownership: `provision.js`

`Provisioner.paths()` is the authority for runtime-related locations. It derives the runtime root, ADB and emulator paths, system-image root, AVD home, temporary directory, and optional QEMU/ISO/disk paths from settings and bundled-resource state.

When changing path behavior:

- Use `paths()` rather than constructing a second default path in a caller.
- Check both a fresh installation and a user who already has system images or an AVD in an older supported location.
- Keep program files, runtime downloads, AVD state, logs, and shared files distinct.
- Ensure `materializeImages()` reads from the runtime bundle and writes to the selected system-image root consistently.

Provisioning helpers check the environment, resolve runtime archives or official component indexes, enforce disk-space requirements, download assets, extract them, and materialize compressed `.img` files. Extraction must validate entry names and must not leave a partial destination that a later check can mistake for a complete image.

## Download and source selection

`Sources` enumerates release sources, merges same-version application assets, builds candidate URLs, ranks them, caches measurements, and temporarily skips rate-limited sources. `download.js` implements HTTP redirects, single-stream resume, ranged downloads, and multi-source chunks.

Important invariants:

- Runtime archives and application update archives are distinct asset classes.
- A multi-source chunk assembly can only mix sources whose advertised total size is compatible with the selected transfer.
- Partial transfer metadata must agree with the target file before resume.
- Idle/slow connections need a bounded failure path; a download must settle and report an error rather than hang indefinitely.
- User cancellation and failure cleanup must remove or preserve partial files according to the documented resume contract.
- Tests should use a local HTTP server and synthetic payloads; normal regression tests must not depend on GitHub/Gitee availability.

## Emulator lifecycle: `engine.js` and `emulator.js`

`Runtime.ensure()` is the orchestration boundary. It coalesces concurrent callers, reuses an online or adoptable device when possible, and starts the configured runtime otherwise. Main-process code should not duplicate this decision tree.

`EmulatorEngine` builds the AVD configuration and launch arguments using the selected hardware profile. It probes actual guest readiness rather than treating process creation as success, records attempts and logs, and validates snapshots before loading them. Safe fallback variants may change rendering or acceleration; they must not silently erase app data.

`doctor.js` provides host/environment information, display LCD profiles, resource profiles, retry variants, failure diagnoses, snapshot fingerprints, and reports. Keep the displayed profile aligned with the parameters actually passed to the emulator.

`userdata.js` creates the ext4 seed used for initial user data. `build/seed/userdata.img.gz` is a build input, not a runtime cache. Changes to filesystem flags, block accounting, or feature bits require synthetic format assertions and a real emulator validation.

## App sessions, idle behavior, and recovery

`container.js` derives command batches for opening/closing app sessions, trimming background user apps, idling the guest, and restoring system apps. The system-app exclusion list is a safety boundary; do not broaden cleanup to system packages without a tested recovery path.

`Runtime` tracks active apps and idle timers. `EmulatorEngine` saves and validates quickboot snapshots. A snapshot should be invalidated only when the underlying machine image/profile truly changes, not for harmless path relocation or a retry-only rendering change.

Network repair, data reset, app reinstall, and idle shutdown are distinct operations. The first three can change user-visible state; keep destructive steps explicit and preserve the app registry and cached APK needed for reinstall where promised.

## ADB contract: `adb.js`

`AdbClient` owns ADB discovery, process execution, device selection, shell calls, installation, launcher resolution, app lifecycle, display, input, file sync, and readiness checks. Reuse its existing methods instead of building shell strings in main-process handlers.

Input injection is deliberately restricted to recognized commands. Package names, paths, and app components must be normalized or validated before command construction. Timeouts should scale with large APK transfers where appropriate, but remain bounded.

## Update path: `updater.js`

The update flow is:

1. Fetch and merge release metadata through `Sources`.
2. Identify the installation flavor (portable or setup) and select the matching application asset, excluding runtime archives.
3. Rank candidate URLs and download or assemble the asset.
4. Extract into a validated staging directory.
5. Generate the apply/restart action and wait for the running process to exit before replacement.

Keep artifact matching conservative. A broad `\.zip` fallback can select the much larger runtime archive and overwrite the wrong directory. Test both install flavors, multiple release sources, missing assets, split updates, and cancellation.

## Verification commands

```powershell
npm test
npm run test:boot
npm run selftest
```

The latter two require appropriate runtime components and may affect a local emulator profile. Use an isolated test data directory. For native window embedding, use the Windows-specific probes and acceptance steps in `MILESTONES.md`; runtime unit tests are not sufficient evidence.
