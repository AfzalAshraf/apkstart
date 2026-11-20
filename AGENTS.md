# Agent guidance for ApkStart

This file applies to the whole repository. Read `MILESTONES.md` before beginning milestone work. For focused tasks, also use the relevant role guide under `.claude/skills/` (the orchestrator guide can route work to the department guides).

## Repository and product

ApkStart is a Windows 10/11 x64 Electron application that provisions or attaches to an Android runtime, installs APK and split-APK bundles, and hosts Android app surfaces in per-app Windows windows. The renderer is vanilla HTML/CSS/JavaScript. The main process owns orchestration and communicates with the renderer through the allowlisted API in `src/preload.js`.

## Working rules

- Stay on the current Arena branch. Do not rename or switch branches. Do not commit or push unless the user explicitly asks.
- Inspect `git status --short` before editing. Preserve unrelated user changes and generated files that are already part of the task.
- Keep code comments, UI text, build output, tests, and maintained documentation in English. Do not silently change a tested product contract merely to improve wording.
- Prefer small, auditable changes. Trace a production call site before changing an export, settings key, IPC channel, or runtime method. Keep compatibility aliases until all call sites and tests have migrated.
- Do not add APKs, runtime binaries, AVDs, credentials, tokens, or private user data to Git. Use synthetic fixtures under `test/` and temporary directories for tests.
- Do not run release, registry, installer, destructive cleanup, or device-reset actions unless the task requires them and the target is clearly isolated.

## Required verification

- Main regression gate: `npm test`.
- For module changes: run the narrowest relevant test first, then the full suite.
- For main/preload/renderer changes, check the contract in both directions: every `ipcRenderer.invoke` channel is handled in `src/main.js`, renderer and shell selectors exist in their HTML, and every linked asset exists.
- For archive/parser changes: use synthetic fixtures; retain ZIP64, path-safety, memory-bounded reading, namespace, and cleanup behavior.
- For native Windows behavior, distinguish Node tests and static inspection from actual Electron/Windows verification. Record unavailable hardware checks as unverified.
- After changing PowerShell/C# sources, preserve the UTF-8 BOM on `src/core/win/agent.ps1`. `src/core/win/windowctl.ps1` must remain pure ASCII.
- Refresh `graphify-out/` only after the code changes for the current checkpoint are stable; inspect the generated report and freshness metadata.

## Invariants worth protecting

- `src/preload.js` exposes a deliberate allowlist; renderer code must not gain Node access or arbitrary IPC/shell access.
- The Win32 agent only operates on processes/windows inside its explicit runtime scope. It must not hide or re-parent unrelated Qt windows.
- The emulator surface is embedded beneath the Chromium render child. Do not reintroduce a clipping window region that breaks hit testing.
- Landscape startup uses the physical AVD LCD profile and a controlled runtime restart; do not substitute a rotated framebuffer shortcut without validating touch coordinates and layout.
- `input` shell commands are generated internally and validated; never pass arbitrary renderer-provided shell text to ADB.
- User data and AVD data must not be deleted by automatic retry or update behavior.
- Keep the 22 audited v0.4.3 bug fixes intact. See `MILESTONES.md` for their acceptance baseline and `docs/ARCHITECTURE.md` for the current component map.

## Definition of done

A change is complete when it has a clear user or maintenance outcome, production callers and tests agree on the contract, applicable automated tests pass, documentation is accurate, and remaining platform-only checks are explicitly recorded. Update milestone checkboxes only when their evidence exists.
