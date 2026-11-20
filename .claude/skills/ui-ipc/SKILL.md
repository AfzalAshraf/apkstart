---
name: apkstart-ui-ipc
description: Maintain ApkStart's vanilla renderer, preload API, main-process IPC, and per-app shell UI.
---

# UI and IPC department

## Scope

Own `src/ui/`, `src/preload.js`, renderer-facing IPC handlers in `src/main.js`, and the visible product copy in those surfaces.

## Contract rules

- Keep `contextIsolation: true` and `nodeIntegration: false`. Renderer code may call only named methods exposed in `src/preload.js`.
- Every `ipcRenderer.invoke(channel)` must have exactly the intended `ipcMain.handle(channel)` contract. Validate arguments at the main-process boundary; do not expose generic `send`, `invoke`, filesystem, process, or shell APIs.
- When changing markup, update selectors and stylesheets together. Every `getElementById`/renderer selector must exist in the matching HTML, and every linked CSS/script/image asset must exist.
- Keep UI text in English and accessible: buttons have labels, status updates use live regions where appropriate, and errors say what the user can do next.
- Keep the main app and per-app shell as distinct windows with separate, explicit state messages.

## Verification

- Run a static channel/selector/asset contract check after UI or IPC changes.
- Run `npm test`; add focused tests for any non-trivial renderer-independent logic.
- On Windows, launch the actual Electron app for smoke validation when possible. Report the result separately from static checks.
- Update README/user documentation if settings, key bindings, or user-visible behavior changes.
