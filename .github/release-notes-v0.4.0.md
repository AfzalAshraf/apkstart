# ApkStart v0.4.0

> Fixes the Hongguo black-screen regression, opens the main window with one tray click, improves startup time, and hides stray runtime windows.

## 1. Fix: Hongguo would not open or stayed black (regression from v0.3.9)

**Cause:** The previous release waited for the VM network using a helper that could cold-boot the VM again. When networking was slow, the helper stopped and restarted the VM while the app was running `adb install` or `am start`. The device disappeared mid-operation:

```text
adb.exe: device 'emulator-5554' not found
launch failed com.phoenix.read
```

**Fix:**

- On the app-launch path, only wait for networking; never restart the VM. Wait up to 20 seconds, then launch anyway. A slow page is preferable to a failed launch.
- Reserve cold-boot and reset operations for the user-triggered **Repair network** action.
- Do not treat `device-offline` as an immediate failure in `waitForNetwork`. A newly restarted VM may take time for adb to come online; allow a 45-second grace period.

Testing showed that this image connects reliably after `-wipe-data`. **Repair network** now resets Android data (the app list is preserved, and apps reinstall when launched), waits for network readiness, and immediately saves a snapshot so the connected state is restored next time.

Reported test: startup logged `Android VM network ready (10.0.2.16)`; Hongguo opened `MainFragmentActivity` and rendered its episodes and recommendations.

## 2. Tray behavior

A single click now opens the main window. Right-click still opens the menu, and double-click continues to work.

## 3. Startup time

- Remove cold-boot retries from the app-launch path, avoiding waits of three to five minutes.
- Reduce the network wait from 60 to **20 seconds** and return promptly if the device disconnects.
- After network repair, save a network-ready snapshot. A reported full startup (boot, network, install, and embed) took about **48 seconds**, including a 20-second boot.

## 4. Stray runtime windows

Add a fallback in the window agent that hides extra visible top-level windows created by processes under our runtime directory (Qt dialogs, crash dialogs, volume bars, log windows, and similar), retaining the single emulator window to embed. The previous implementation named window classes individually and could miss new ones.

## 5. Hardening

- Restore the **UTF-8 BOM** in `agent.ps1`. Without it, Windows PowerShell 5.1 may decode UTF-8 Chinese comments as ANSI and combine a comment with the next line, causing `Add-Type` compilation to fail and preventing window embedding.
- Add a regression test that fails if the BOM is removed.

## 6. Reported validation

- `npm test`: **114 checks passed** (8 + 25 + 81).
- Hongguo opened from consent to a normally rendered home feed (screenshot verified).
- A single tray click opened the main window.

## 7. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
