# ApkStart v0.3.8

> Adds a **startup welcome card**, fixes update checks that failed for some users, adds **old-version cleanup**, and refreshes the interface styling.

## 1. Startup welcome card

Show a lightweight welcome card when ApkStart starts at sign-in or is opened manually:

- Branded gradient artwork and a time-of-day greeting.
- At-a-glance counts/status for installed apps, Android runtime, and device port.
- Two useful tips: how to install an app when the list is empty, or how to control app windows when apps are installed.
- Show new-version information here instead of an extra desktop notification.
- Offer **Do not show automatically next time** and **Open Settings** actions.

The card always appears on sign-in startup, appears at most once per day when opened manually, and stays hidden after the user opts out.

## 2. Fix update checks that failed for some users

**Cause:** Version checks used APIs from both providers. GitHub's anonymous API allows 60 requests per IP per hour, while Gitee's anonymous API is more restrictive and can return `403 Rate Limit Exceeded` after only a few requests. Shared company, campus, or carrier NAT addresses could be throttled by both sources, leaving only “Update check failed.”

**Fix:**

- Add an API-independent fallback: follow the `releases/latest` 302 redirect to get the version from the CDN without consuming API quota, then construct the download URL according to the release naming convention.
- Construct standard GitHub and Gitee `/releases/download/<tag>/<filename>` URLs. Testing confirmed that Gitee redirects to the attachment and returns the complete file.
- On failure, show an **Open download page** button instead of a blank panel. `app:updateOpen` now allows `gitee.com` so users on networks where GitHub is inaccessible can continue.

## 3. Remove old-version leftovers

**Settings → System integration → Clean up old versions** can scan for:

- Old app directories such as `ApkStart-vX.Y.Z-win64-portable`, only when they contain `ApkStart.exe` and are not the running version.
- Stale uninstall registry entries whose `InstallLocation` or uninstaller no longer exists.
- Temporary update packages under `%APPDATA%\apkstart\update` and the temporary directory.

The cleanup lists candidates and estimated space before deletion, then reports files it could not remove because they were in use. It avoids user data and the current version.

## 4. Reduce small startup popups

- Move startup update notifications into the welcome card.
- Replace scattered startup toasts with the single card.
- Keep the existing console-window hiding for the emulator, netsimd, and adb.

## 5. Visual refresh

- Emerald branding, a soft neutral background, and a subtle brand glow.
- Frosted-glass title bar and a vector brand mark that remains recognizable at small sizes.
- App cards with larger corners, hover lift, brand outlines, and icon shadows.
- Refined primary and secondary buttons, dialogs, section headers, scrollbars, and status bar.
- The welcome card uses the same gradient, glow, and dot-grid language.

## 6. Reported validation

- `npm test`: **113 checks passed** (8 + 25 + 80).
- Smoke screenshots confirmed the main screen and welcome card rendered normally.
- Old-version cleanup found six old app directories (about 1.3 GB) on the development machine and correctly excluded the running version.

## 7. Upgrade

- Portable: extract over the existing app; keep the data directory (default `%APPDATA%\apkstart`).
- Installer: install over the existing version.
