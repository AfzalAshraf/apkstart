# Contributing to ApkStart

Issues and pull requests are welcome. ApkStart aims for predictable behavior, a small renderer, and explicit runtime/process boundaries. Please read the relevant sections below before changing those contracts.

## Development setup

- Windows 10 or 11, x64 is the supported development target.
- Node.js 20 or newer and npm are required.
- Install dependencies and run the regression suite:

```powershell
npm ci
npm test
```

To launch the application during development, use `npm start`. Runtime provisioning may download large Android components on first use.

## Before submitting

- Run the smallest relevant test while iterating, then run `npm test`.
- For renderer or IPC changes, verify preload channels, main handlers, HTML selectors, and linked assets.
- For UI changes, run the Electron application on Windows and attach a screenshot or describe the smoke scenario when practical.
- For Win32, PowerShell, display, or emulator-window changes, state which Windows version and emulator build were tested. Do not present static checks as an end-to-end pass.
- Keep generated builds, runtime binaries, AVDs, APKs, private logs, and credentials out of the patch.

## Code conventions

- Keep maintained comments, user-facing text, tests, and operational messages in English.
- The renderer is plain HTML/CSS/JavaScript; do not introduce a framework for a small interaction.
- Route Android operations through `src/core/adb.js`; avoid constructing ad hoc ADB invocations in unrelated modules.
- Keep `contextIsolation` enabled and `nodeIntegration` disabled. Add renderer capabilities through narrow named methods in `src/preload.js`, not a generic IPC or shell bridge.
- Preserve compatibility aliases when a public export is used by the main process, scripts, tests, or other core modules. Search all call sites before removing one.
- Prefer synthetic test fixtures for binary formats. Do not commit proprietary or user-supplied APKs.
- Validate untrusted paths and values at process boundaries; archive extraction must not escape the destination directory.

## Windows-specific invariants

- Preserve the UTF-8 BOM in `src/core/win/agent.ps1`; it is required by the embedded PowerShell/C# compilation path.
- Keep `src/core/win/windowctl.ps1` ASCII-only.
- The Win32 agent must be scoped to ApkStart runtime processes and must never hide or re-parent unrelated application windows.
- Park/detach the emulator surface and remove input hooks during cleanup. Do not reintroduce `SetWindowRgn` clipping for the embedded surface.
- A landscape/display change must preserve physical LCD profile, Android orientation, touch coordinates, and the host window layout together.

## Tests

The default suite is local and does not require a real APK or network access:

```powershell
npm test
```

To include an optional real APK fixture for parser validation:

```powershell
$env:APKSTART_TEST_APK = 'C:\path\to\test.apk'
npm test
Remove-Item Env:APKSTART_TEST_APK
```

Do not add that fixture to the repository. Tests that need network behavior should use a local HTTP server. Tests that need Windows APIs or a real Android runtime must be clearly marked opt-in and must isolate settings, data directories, and child processes.

## Commit messages

Use Conventional Commit-style messages, for example:

```text
fix(apk): handle aliased launcher activities
fix(ui): align renderer selectors with shell markup
 test(runtime): cover interrupted image materialization
docs: refresh runtime lifecycle guide
```

(Do not include the leading space in a commit subject.)

## Licensing and safety

- Do not add Android system images, emulator binaries, Google components, commercial APKs, cracked software, or other content you are not authorized to redistribute.
- Do not include tokens, credentials, personal paths, or private user data in source, tests, logs, screenshots, or documentation.
- Destructive reset, cleanup, and release operations require an isolated target and explicit task authorization.
