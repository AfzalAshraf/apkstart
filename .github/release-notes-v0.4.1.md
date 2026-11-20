# ApkStart v0.4.1

> Fixes the related rotation black bars, incomplete app layout, and unresponsive clicks. The root cause was that the embedded emulator and Electron web layer were sibling windows, leaving the web layer in front.

## 1. Root cause

A `WindowFromPoint` hit test at the center of the app returned `Chrome_RenderWidgetHostHWND` (Electron's web renderer), not the emulator. The renderer's black background covered the Android image and consumed mouse input.

| Symptom | Cause |
|---|---|
| Black bars or an incomplete image | The web layer covered the embedded image or only part of it was visible. |
| Clicks did nothing or landed incorrectly | Clicks hit the web layer instead of Android. |
| “Agree and continue” could not be tapped | Same cause (`adb input tap` worked because it uses Android logical coordinates). |
| Worse after rotation or full-screen | Resizing caused Chromium to repaint and raise its web layer again. |

The v0.3.9 `SetWindowRgn` workaround also broke Qt/GL child-window hit testing and left a region that no longer matched the window after resizing. That was the direct source of this release's symptoms.

## 2. Fixes

1. **Remove `SetWindowRgn` clipping.** Clear any region left by an older version during `Embed()`; the host-drawn title bar naturally covers the small overflow.
2. **Parent the emulator under the web renderer** rather than making both windows children of the host. Child-window Z order and hit testing then take precedence, preventing the web layer from covering the image or consuming clicks.
   - The renderer may not exist when `embed` first runs, so `Fit()` and the persistent scan retry parenting until it succeeds.
3. **Narrow `HideStrayWindows`:** hide only known popup classes (Qt tool windows and consoles), never `QWindowIcon` or `subWin`, which can be the LCD currently being displayed.
4. **Raise the app window after startup** using a brief topmost state, then remove it, so another window cannot cover the embedded image.
5. **Fix sizing during rotation:**
   - `setContentSize` does not work while maximized; unmaximize before resizing, then restore as needed.
   - Constrain target dimensions to the available screen area.
   - Qt may relayout several times after `wm size`; run six `Fit` passes to settle and remove remaining bars.

## 3. Reported end-to-end validation

- Use a **real mouse** to click “Agree and continue,” open `MainFragmentActivity`, then launch the `ShortSeriesActivity` playback screen.
- `PrintWindow` capture showed the Android image filling the area below the title bar, with no bars or blank space. Video, likes, comments, episode selection, and title-bar buttons worked.
- `WindowFromPoint` at the center returned the emulator (it returned the renderer before the fix).
- `npm test`: **115 checks passed** (8 + 25 + 82); two regression checks ensure the emulator is parented to the renderer and no window region is set.

## 4. Hardening

- Keep the UTF-8 BOM in `agent.ps1`; without it, Windows PowerShell 5.1 may misread UTF-8 comments and cause `Add-Type` compilation to fail.
- Add regression checks for `SetParent(emu, parent)` and `FindChromeRender`, the absence of `CreateRectRgn(0, clipTop)`, and clearing old regions during embed.

## 5. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
