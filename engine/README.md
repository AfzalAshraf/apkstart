# Runtime engine directory (optional manual placement)

**Since v0.2, ApkStart manages its own runtime by default.** The app downloads and installs adb,
QEMU, and Android system images under `%APPDATA%\apkstart\runtime\`; no manual setup is needed.

Use this directory only in the following cases:

## 1. Place QEMU manually (download source unavailable or a pinned version is needed)

```text
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ ... (the remaining QEMU files)
```

Official QEMU Windows builds: <https://qemu.weilnetz.de/w64/>

`qemu-w64-setup-*.exe` is an NSIS installer. ApkStart can silently install it into the runtime
directory with `/S /D=`. You can also extract it with 7-Zip and place the files in the layout above.

## 2. Place adb manually

```text
tools/platform-tools/
└─ adb.exe
```

Download Android platform-tools: <https://developer.android.com/tools/releases/platform-tools>

## System images

- Recommended: Android-x86 9.0-r2 (x86_64), downloadable in the app with mirrors and resume support.
- Or import an installed Android disk image (`qcow2`, `raw`, or `vmdk`) from **Runtime → Import**.
- After importing, ApkStart boots directly from the disk image; no installation step is required.

## Hardware acceleration

QEMU uses WHPX. Open **Control Panel → Turn Windows features on or off**, enable **Virtual Machine
Platform**, then restart Windows. If WHPX is unavailable, ApkStart falls back to software emulation
(TCG), which makes the first boot slower.
