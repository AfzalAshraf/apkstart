## What changed

### 1. Faster downloads through multi-source requests

Measurements on the test machine showed that eight GitHub-only connections achieved just **0.23 MB/s**, taking **493 seconds** to download a 113 MB update. Direct connections transferred no data even though TCP connected; only mirrors worked.

- **Parallel chunks from multiple sources:** download different chunks concurrently from GitHub direct, ghfast, and gh-proxy, combining available bandwidth. On the same machine, 113 MB dropped from **493 to 77 seconds** (about 1.5 MB/s, including source ranking and extraction).
- **Switch away from slow sources:** interrupt a chunk that falls to tens of KB/s, resume it from another source, and avoid stalling near 95%.
- **Resumable chunk downloads:** retrying a failed 1.4 GB runtime download fetches only missing chunks.
- **Stall watchdog:** abandon a connection that has not delivered data for 20 seconds instead of waiting through a 30-second socket timeout.
- **Measure sources before choosing:** download 256 KB from each candidate and compare throughput after the first byte arrives. Measure sequentially to avoid candidates competing for bandwidth.

### 2. GitHub and Gitee source selection

- Both repositories are public: GitHub `RoutineMiku/apkstart` and Gitee `daily-miku/apkstart`.
- Check both for releases and use the higher version; one unavailable source does not block the other.
- Gitee limits each release attachment to 100 MB, so portable packages are published as `.part1`/`.part2` files when needed. The client downloads parts (with size checks) and joins them; a missing part aborts the update.
- Gitee rate limiting is handled with a 10-minute release cache and a 15-minute circuit breaker for 403/429 responses. If both sources are unavailable, return the last result marked `stale` instead of failing the UI.

### 3. Protect user data

- **Do not wipe data when disk space is low:** the old retry matrix ended with `-wipe-data`. When every retry failed because the disk was full, this could erase installed apps and saves. Automatic retries no longer wipe data; low disk space stops with guidance.
- **Moving a runtime directory is not changing the image:** moving the runtime from C: to D: previously changed the path-based identity, triggered `-wipe-data`, and removed installed apps. Image identity is now independent of its directory path.
- **Fix `qemu-img resize` argument order:** the old order could enlarge the file to 6 GB while leaving the filesystem at 64 MB, causing `ENOSPC` failures. Startup now also checks and repairs the mismatch.

### 4. Other changes

- Failed APK installs no longer spam duplicate attempts; errors explain actionable causes such as insufficient partition space, ARM-only packages, signature conflicts, or downgrades.
- Resource controls include three performance profiles, three graphics-quality levels, and a configurable 4–24 GB Android data partition that can be expanded in place without losing installed apps. The Android data directory can be moved to another drive.
- Portable package size: 230 MB after removing 52 unused language packs (39 MB saved).
- Logs rotate by size, and shared-folder sync no longer repeatedly copies the same file.

## Reported validation (Windows 11, Android 14 Play image)

| Check | Result |
|---|---|
| Cold boot to app-ready | **23–25 seconds** (about 32 seconds on the first run, including detection) |
| Quickboot snapshot restore | **5 seconds** |
| Install and launch APK | App window appeared in **1.5 seconds** from a warm snapshot |
| Visible emulator/console windows during a 45-second boot | **0** |
| Windows left behind after ApkStart exits | **0** |

## Packages

- **Full setup:** `ApkStart-*-Setup.exe`, includes the runtime and works immediately after installation (about 1.4 GB).
- **Portable:** `ApkStart-*-win64-portable.zip`, extract and run; the runtime downloads on first launch with source selection and resume support.

The GitHub and Gitee releases contain the same portable package; Gitee may be preferable on some networks.
