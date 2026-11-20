# ApkStart v0.3.7

> Fixes **app-window close** so Android apps really stop, makes **VM networking self-heal**, and configures the Gitee release token in CI.

## 1. Closing an app window now stops the Android app

**Problem:** Clicking the title-bar × hid the window but left the Android app running in the background. Opening it again looked as though it had never been closed.

**Cause:** `shell:close` called Electron's `win.close()` directly, bypassing `AppWindow.close()` cleanup. The `closed` handler cleared internal state but did not `force-stop` the Android app or detach the emulator window. Alt+F4 and taskbar close had the same issue.

**Fix:**

- Route the × button through `appWin.close()`: detach and hide the emulator window, then `am force-stop` the Android app.
- Add the same cleanup to the `closed` handler for Alt+F4, taskbar close, and system shutdown.
- Rotation, minimize, and maximize behavior is unchanged.

**Reported test:** After sending `WM_CLOSE` to the app window, `pidof com.phoenix.read` changed from `5152` to empty and Android returned to the home screen.

## 2. Network recovery no longer relies on luck

The previous release identified the Hongguo black screen as a VM network problem, but only waited longer. A Wi-Fi connection that never completed could still time out.

Networking now escalates automatically from the least disruptive step:

1. Wait up to 60 seconds for network readiness before launching an app, with visible log progress.
2. If that fails, cold-boot the VM once with `-no-snapshot-load`, then wait up to 180 seconds.
3. Save a snapshot as soon as the network connects so the network-ready state is restored next time.
4. **Settings → Repair network** uses the same flow and resets Android data only if both prior steps fail. The app list is preserved and apps reinstall on launch; in-app logins and data are lost.

This release does not change the Android image. Testing pointed to slow or intermittent emulator Wi-Fi association, not the Android version. Waiting and cold-boot recovery address the same case without making every user download another 1.5 GB image. A more reliable image can be adopted in a separate release if evidence supports it.

## 3. CI Gitee token

The GitHub Actions secret `GITEE_TOKEN` is configured. On future `v*` tags, the Release workflow mirrors the portable package to Gitee automatically.

## 4. Reported validation

- `npm test`: **113 checks passed** (8 + 25 + 80).
- After closing the window, `pidof com.phoenix.read` was empty.
- The network-ready log reported `10.0.2.16`, and Hongguo rendered its home page normally.

## 5. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
