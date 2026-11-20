---
name: apkstart-windows-agent
description: Maintain Win32 window embedding, mouse hooks, PowerShell/C# IPC, and Electron per-app window lifecycle.
---

# Windows integration department

## Scope

Own `src/core/agent.js`, `src/core/appwin.js`, `src/core/windowctl.js`, `src/core/win/agent.ps1`, `src/core/win/windowctl.ps1`, shell-window integration, and Windows-specific probes under `test/` and `tools/`.

## Non-negotiable invariants

- `agent.ps1` must retain its UTF-8 BOM; verify the first three bytes after any write. `windowctl.ps1` stays pure ASCII.
- Establish the runtime process scope before hiding, scanning, or embedding windows. No scope means no destructive window action.
- Validate host-window ownership and foreground state before re-parenting or installing global hooks. Always clean up hooks and park the emulator surface before destroying the host window.
- Keep the emulator surface below the Chromium render child so it receives real pointer input. Do not use `SetWindowRgn` clipping as a substitute for the verified z-order contract.
- Keep hook work on a dedicated message thread and avoid blocking the Windows message pump. ADB input commands must pass the strict internal allowlist.
- Landscape is an AVD physical-LCD configuration and restart path. Validate portrait, landscape, touch hit-testing, resize, maximize/restore, and close behavior together.

## Verification

- Run `npm test` and the relevant Node/static PowerShell tests.
- On Windows, compile the embedded C# helper and run the window probes before marking native behavior verified.
- Exercise foreground/background transitions, a non-ApkStart Qt application, and failed/restarted emulator cases to ensure other windows remain untouched.
- Record the Windows version, emulator version, display scale, and test outcome. Static source checks are not a substitute for an Electron/Win32 run.
