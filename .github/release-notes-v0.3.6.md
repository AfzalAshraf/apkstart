# ApkStart v0.3.6

> **Fixes the black screen after tapping “Agree and continue” in Hongguo.** The actual cause was delayed Wi-Fi connectivity in the Android VM: the app loaded its home page before networking was ready. This was unrelated to graphics or the rendering backend.

## 1. Diagnose and fix the Hongguo black screen

### The previous diagnosis was wrong

v0.3.5 attributed the black screen to the GPU backend (`swangle` / `software`). Changing renderers could not fix it.

### The cause found in testing

ADB checks showed:

- `cmd wifi status` reported `Wifi is not connected` and `ip -o addr show wlan0` showed no IP address.
- The VM had no network connection. The privacy dialog is a local page and appeared normally; after consent, Hongguo requested home-page data and displayed a black page when the request failed.
- `sys.boot_completed` only means Android has started. Wi-Fi association and DHCP can take tens of seconds or more than two minutes. The app could launch before the network became ready and remain black after failed requests.

On the same VM, the first check showed no IP; after one or two minutes it showed `wlan0 inet 10.0.2.16/24` and `Wifi is connected to "AndroidWifi"`. Hongguo then displayed its home page normally.

### Fixes in this release

1. **Wait for network before launching an app:** `installer.launch` waits up to 150 seconds before `am start`. Progress is logged as `Waiting for Android VM network... Ns`.
2. **Check network after boot:** report the reason in the log if the VM has no IP instead of leaving users to guess at a black screen.
3. **Settings → Repair network:** reset Android user data, reboot, and wait up to four minutes for network readiness. After success, save a quick-boot snapshot with networking ready.
   - The app list is preserved; launching an app reinstalls it automatically.
   - In-app data such as login state and watch history is lost and users must sign in again.
   - Only the current AVD is affected; the system image and local APK cache are untouched.

If Hongguo is black, try launching it again first; this release waits for network readiness automatically. If it is still black, use **Settings → Repair network**.

## 2. Cache cleanup from v0.3.5

The `includeSnapshots` behavior and Android-data reset flow from v0.3.5 are unchanged.

## 3. Known limitations

- The Android 14 `google_apis_playstore` image has an upstream issue: cold boots with existing user data often leave Wi-Fi in `NO-CARRIER` without an IP. A boot after data reset usually connects normally. Repair network resets data and immediately saves a snapshot to preserve the working state.
- The Play Store image does not allow `adb root`, so a broken Wi-Fi configuration cannot be removed individually.

## 4. Reported validation

- After the fix, tapping **Agree and continue** opens `MainFragmentActivity`; the episode list and recommendations render normally (confirmed by screenshot).
- After network readiness, the VM reports `wlan0 inet 10.0.2.16/24` and `Wifi is connected to "AndroidWifi"`.
- `npm test`: **113 checks passed** (8 + 25 + 80).

## 5. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
