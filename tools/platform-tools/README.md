# Portable adb

Extract Android platform-tools into this directory so that `adb.exe` is present. ApkStart prefers it:

```text
tools/platform-tools/
└─ adb.exe
```

Download: <https://developer.android.com/tools/releases/platform-tools>

If this directory is empty, ApkStart checks these locations in order:

1. The adb path selected manually in Settings
2. This directory
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. adb bundled with common emulators (LDPlayer, MuMu, or BlueStacks)
5. The system `PATH`
