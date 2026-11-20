# ApkStart v0.3.9

> Reworks **portrait/landscape switching** as a real phone/tablet layout change, fixes landscape/full-screen layout and input issues, removes black strips near the title bar, and reclaims storage.

## 1. Portrait, landscape, and full-screen layout

**Previous problem:** Rotation or full-screen turned the whole image sideways; Android did not reflow the app, and full-screen did not reliably switch to landscape.

**Cause:** The old code changed `wm size` and sent Ctrl+Left through the window agent. Ctrl+Left rotates only the emulator image, not Android's layout, so the image appeared sideways. Generated AVD configuration also set `hw.sensors.orientation=no`, preventing Android from rotating at all.

**New behavior:**

- Change Android's **logical display size** with `wm size` so apps reflow:
  - Portrait: 720×1280 at 320 dpi, about **360 dp wide** (phone layout).
  - Landscape: 1280×720 at 320 dpi, about **640 dp wide** (tablet or split-pane layout; Android uses 600 dp as the tablet threshold).
- Lock `wm user-rotation` at 0 so content remains upright.
- Remove the image-rotation step; image orientation and Android layout now agree.
- Recalculate the app-window aspect ratio after resolution changes so no black bars remain.
- The full-screen button switches to landscape/tablet layout; leaving full screen returns to portrait/phone layout. The Settings display-mode selector behaves the same way.
- New AVDs enable `hw.sensors.orientation` and `hw.sensors.accelerometer` rather than locking orientation off.

## 2. Remove black strips when using title-bar buttons

The Qt emulator window is about 8 px larger than the LCD on each side. The previous workaround shifted it up and left, placing part of it under the title bar. When a title-bar button raised the emulator window, that overflow appeared as a black strip.

Add a window-region clip (`SetWindowRgn`) to exclude the 8 px overflow from the embedded emulator window.

## 3. Restore clicks and network readiness

After rotating only the image, the window agent still mapped clicks as if the display were in portrait, so taps landed at the wrong coordinates. Correctly reflowing the Android layout restores input.

Reduce network-wait overhead: attempt a cold-boot retry only once per process and reduce the initial wait from 60 to 25 seconds. A normal launch should no longer wait several minutes.

## 4. Reclaim storage

Old-version cleanup now also removes obsolete quick-boot snapshots:

- Legacy `default_boot` snapshots (a `ram.img` can be about **3 GB**).
- `*.stale-*` snapshots renamed after failed deletion.
- The currently used `apkstart` snapshot is never removed.

Reported reclaimable space on the development machine was about **4.65 GB** (six old app directories plus one obsolete snapshot).

## 5. Reported validation

- `npm test`: **113 checks passed** (8 + 25 + 80).
- After `wm size 1280x720`, the framebuffer measured **1280×720** and the screenshot was upright.
- The app window reported `embedded=true`; after closing, `pidof` was empty.

## 6. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
