# ApkStart release milestones

This roadmap starts at the audited **v0.4.3** baseline and proceeds through **v0.5.0 → v0.6.0 → v0.8.0 → v1.0.0**. A milestone is complete only when its gates have recorded evidence; an implementation that has not been exercised on the required platform is not considered verified.

## Status at the v0.4.3 audit checkpoint

| Area | Status | Evidence / remaining work |
|---|---|---|
| Audited defect set | Complete: fixes #1–#22 are present in the working tree | Regressions are covered by the Node suites and source-level assertions. Keep these fixes intact while refactoring. |
| Automated tests | Passing | `npm test`: 117 passed, 0 failed (8 parser/runtime tests, 25 engine tests, 84 focused regression tests). |
| Renderer / preload / main IPC contracts | Static contract check passes | 63 preload `invoke` channels match 63 `ipcMain.handle` registrations; renderer and shell element references resolve. Electron end-to-end behavior still needs a Windows run. |
| English operational material | Complete for the audited working tree | A repository-wide UTF-8 text scan found no Han characters in source, workflows, tests, documentation, guidance, or promotional copy; the English promotional graphics were regenerated from source. |
| Graphify | Refreshed | Code-only graph regenerated from the current working tree; report and freshness metadata inspected in `graphify-out/`. |
| Dependency advisories | Follow-up required before the next runtime release | `npm audit` reports 8 advisories (6 moderate, 2 high) in development/build dependencies, including the Electron 33.4.11 runtime shipped with the app. `npm audit --omit=dev` reports zero because Electron is a devDependency; the audit's Electron fix path is a major upgrade. No upgrade was attempted without Windows build and smoke validation. |

## v0.4.3 — audited and documented baseline

**Goal:** Preserve the 22 audited bug fixes, establish a trustworthy test baseline, and make the current code and operational guidance understandable in English.

**Release gates**

- [x] Retain fixes #1–#22; do not regress the AXML/ARSC, ZIP64/streaming, installer, runtime, window-agent, display, packaging, or boot-overlay behavior covered by the regression suite.
- [x] `npm test` passes with **117 tests and zero failures** at this audit checkpoint.
- [x] Static contract check: all preload invokes have matching main-process handlers; all renderer/shell DOM IDs resolve; linked shell stylesheets exist.
- [ ] Electron application smoke test on Windows: launch main window, install or open a test APK, embed the emulator window, rotate, minimize/maximize, close, and verify cleanup.
- [x] English documentation, milestones, contributor guidance, and agent instructions are complete and internally consistent. A full repository text scan returned no Han-character matches.
- [x] Graphify output is regenerated from the reconciled code tree and contains no stale code snapshot (`graphify update /home/user/apkstart --force`: 1,090 nodes, 2,446 edges, 65 communities; report and build metadata inspected).

**Exit evidence:** attach the exact commands, platform/build used, and observed outcome to the session handoff. Do not mark the Windows-only gate complete from Node tests or static inspection alone.

## v0.5.0 — reliability and supported installation paths

**Goal:** Turn the audited working tree into a repeatable Windows release candidate with predictable install, launch, update, and shutdown behavior.

**Measurable gates**

- [ ] CI is green on Windows with Node 20 and Node 22 for `npm ci` and `npm test`.
- [ ] One packaged portable build and one NSIS setup build complete from a clean checkout; record artifact names and byte sizes, and confirm the portable archive stays within the configured release limit or document the intentional exception.
- [ ] On Windows 10 and Windows 11 x64, complete at least **10 consecutive** launch → embed → close cycles per OS without a stray emulator/console window, orphaned app process, or failed cleanup.
- [ ] Verify both supported install inputs: a single `.apk` and a split `.apks` or `.xapk`; verify a newly created shortcut launches the intended app.
- [ ] Verify one in-place upgrade on both install flavors and confirm app records, user data, and AVD data remain intact.
- [ ] No open release-blocking (P0/P1) regressions; every P2 issue has an owner and an explicit decision.
- [ ] Publish a release checklist with artifact verification, release notes, rollback steps, and the required external credentials/secrets (never place secret values in the repository).

## v0.6.0 — contract coverage and maintainable boundaries

**Goal:** Make high-risk module and process boundaries executable contracts, reducing reliance on manual review.

**Measurable gates**

- [ ] Add at least **30 focused assertions** across the currently high-risk seams: ZIP/ZIP64 and streamed extraction, AXML/ARSC metadata resolution, APK bundle installation, settings migrations, display/orientation, AppWindow lifecycle, and IPC/preload allowlists.
- [ ] The test suite includes deterministic synthetic fixtures for parser and bundle paths; no commercial APK or user data is committed.
- [ ] Every public export consumed by `src/main.js`, `scripts/selftest.js`, and the renderer has a contract test or a documented Windows-only integration check.
- [ ] Security review passes for IPC input validation, shell command construction, archive extraction paths, external URL handling, and PowerShell agent scope. No arbitrary renderer-controlled shell command is permitted.
- [ ] `npm test` remains green; CI runs the same suite. Any new test is deterministic, local-only, and cleans up temporary state.
- [ ] Module extraction/refactoring (if undertaken) preserves compatibility aliases until call sites and tests have migrated.

## v0.8.0 — compatibility, recovery, and performance

**Goal:** Validate realistic workloads and recovery paths on a documented reference matrix before the 1.0 stability freeze.

**Measurable gates**

- [ ] Document and run a Windows 10/11 x64 matrix with at least **5 representative apps**: x86/x86_64 native libraries, ARM-only native libraries, a large APK, a split bundle, and an app with a landscape preference. Record app/API/ABI and results without redistributing copyrighted APKs.
- [ ] On a named reference PC, measure **20 cold starts and 20 warm snapshot starts**. Report median and p95. Target p95 ≤ **60 s cold** and ≤ **20 s warm**; deviations require a documented hardware-specific explanation and a user-visible expectation.
- [ ] Exercise GPU/hypervisor fallback paths, interrupted downloads, corrupted snapshot recovery, runtime relocation, offline startup after setup, and update rollback; each scenario has a repeatable check and a recorded result.
- [ ] Complete **10 consecutive** update/restore cycles in a clean test profile without losing the app registry or user data.
- [ ] No unresolved data-loss, privilege-boundary, arbitrary-command, or window-isolation defects. All remaining known limitations are documented in English.

## v1.0.0 — stable release

**Goal:** Ship a supportable, documented Windows Android app runner with a clear compatibility and recovery policy.

**Measurable gates**

- [ ] All v0.5.0–v0.8.0 gates are complete, with evidence linked from the release issue or pull request.
- [ ] CI and the complete automated suite are green on Windows / Node 20 and 22 from a clean dependency install.
- [ ] The supported OS, CPU architecture, storage requirements, runtime download requirements, and known emulator/app limitations are stated in the README and release page.
- [ ] Install, launch, shortcut, rotation, file-sharing, update, uninstall, and data-preservation paths have a checked acceptance scenario. At least **30 consecutive** lifecycle runs on the release-candidate machine complete without a P0/P1 failure or leaked emulator window.
- [ ] Security and privacy review is complete; no open critical/high-severity issue remains. User data deletion and destructive repair/reset actions are explicit and confirmed.
- [ ] Release artifacts are reproducible from the tagged source to the extent supported by Electron Builder; versions and checksums are published. If code signing is unavailable, the release documentation explicitly states that the Windows binaries are unsigned.
- [ ] Final README, architecture, developer walkthroughs, troubleshooting, contributor instructions, and release notes are English and match the shipped code.

## Per-chat progression protocol

Use this protocol every time work continues in a new chat or agent session. It is intentionally incremental: complete one coherent checkpoint and leave the next one obvious.

1. **Re-establish context.** Read this file, the root `AGENTS.md`, the current branch/status supplied by Arena, `git status --short`, and the latest test result. Do not infer that earlier branch notes or a passing test still apply to the current working tree.
2. **Choose one checkpoint.** Name the active milestone and the exact unchecked gate(s) to address. Prefer the smallest dependency-complete slice. Do not start unrelated refactors just because they are nearby.
3. **Preserve completed behavior.** Before changing a contract, locate its production caller and tests. Keep the 22 audited fixes and the Windows invariants. Do not mark a gate complete based only on code being present.
4. **Implement and verify.** Run focused tests first, then `npm test`; run Windows/Electron checks when relevant and available. Record skipped checks as skipped, not passed. Keep tests local and deterministic.
5. **Update evidence.** Change a checkbox only after the gate is satisfied. Add the command, platform, result, and any artifact/report path in the relevant status row or handoff. Keep the audit count honest if tests are added or removed.
6. **Hand off cleanly.** Summarize completed gates, changed files, test results, unresolved risks, and the single next recommended checkpoint. Do not switch branches, rewrite history, or claim a release is ready without the applicable gates.

**Suggested handoff format**

```text
Milestone/checkpoint: v0.x — <gate>
Completed: <behavior or artifact>
Evidence: <commands, platform, results>
Not verified: <Windows/Electron/manual checks that remain>
Risks: <known issue or “none identified”>
Next chat: <one exact unchecked gate>
```
