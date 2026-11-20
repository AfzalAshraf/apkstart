# ApkStart v0.4.3

> Reworks **rotation/full-screen** to change the emulator's physical panel rather than only its runtime resolution, so landscape is upright and fills the window. Also reduces system-wide stutter and adds **Game / Low Latency** mode for FPS apps.

## 1. Rotation and full-screen now fill the window upright

### Why the previous approaches failed

The emulator image comes from a physical LCD panel. Qt sizes its window from that panel and places the image at the upper left. The prior approaches changed only runtime settings:

| Previous approach | Result |
|---|---|
| Change `wm size` at runtime | Changes Android's logical resolution but leaves the physical panel in portrait: image rotated 90 degrees, partial display, and incorrect click coordinates. |
| Change `wm density` at runtime | Leaves framebuffer dimensions unchanged, so the image does not fill the window and leaves blank space after maximizing. |
| `adb emu rotate` | Rotates image content only; Android remains in portrait layout. |

### New behavior

**Rotation now changes `hw.lcd.width/height` and restarts the emulator** (about 30–60 seconds, only when rotation is requested):

- Portrait panel: `720x1280`; landscape panel: `1280x720`.
- Lock `wm user-rotation` (landscape 1, portrait 0) and disable sensor auto-rotation. If the panel is landscape but rotation remains 0, the image would appear sideways.
- Persist the selected direction in Settings and reuse it on the next ApkStart launch.
- **Full-screen switches to landscape:** maximize the host window and rotate the physical panel, rather than stretching a portrait image.

### Two related bugs fixed

1. **`-no-skin` overrode `-skin`:** both flags were passed at startup, and `-no-skin` caused the panel to use the old `config.ini` dimensions. That directly caused “landscape selected, but portrait still appears.” Remove `-no-skin`.
2. **Maximized image did not fill the window:** Electron's host window became 1936×1048, but the Chrome renderer remained at its old size (measured 532×984). The emulator child was clipped by that renderer. `Fit` now stretches the renderer to the host client area before fitting the emulator. Each window-scan pass also repairs this, even if JavaScript misses a resize event.

## 2. Reduce system-wide stutter

1. **Window scan frequency:** the old agent enumerated every desktop window every 120 ms for the first 90 seconds after boot (four `EnumWindows` calls and process-path lookups per pass). Now scan every 250 ms for the first 10 seconds, then every **1500 ms**; Game mode uses **3000 ms**.
2. **Emulator priority:** Balanced mode previously lowered QEMU to BelowNormal and sometimes Idle after an app closed, causing Android frame drops. Do not force Idle after app close.
3. **Global mouse hook:** `WH_MOUSE_LL` synchronously receives all desktop mouse events and can add pointer latency. Game mode does not install it.

## 3. Game / Low Latency mode

Select **Settings → Performance and resources → VM priority → Game / Low Latency**:

- Raise the emulator process to **High** priority so Android rendering and input receive CPU time first.
- Disable the global mouse hook and use native pointer input.
- Scan windows every 3000 ms to reduce host overhead.
- The **Smooth** resource profile also selects this mode for video and games.

Other applications may run more slowly, so Balanced remains the default.

## 4. Additional hardening

- Accept a **UTF-8 BOM** in `settings.json`. Previously, a BOM caused `JSON.parse` to fail and silently replaced the entire configuration with defaults.
- Add regression checks requiring landscape to use `lcdFor({landscape})` instead of runtime `wm size`, window mode to use `-skin` without `-no-skin`, and Game mode to use High priority without the global hook.

## 5. Reported validation

- `npm test`: **117 checks passed** (8 + 25 + 84).
- Landscape: `wm size` reported `Physical size: 1280x720`, `user_rotation=1`; guest image was upright, correctly laid out, and had no black bars. The maximized host client area was 1920×1032 and the renderer filled it.
- Portrait: `720x1280`, `rotation=0`; the image was upright and filled the window.

## 6. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
