---
name: apkstart-orchestrator
description: Plan and coordinate ApkStart work across core runtime, Windows integration, renderer/IPC, release engineering, and QA documentation.
---

# ApkStart orchestrator

Use this skill when a task crosses subsystem boundaries or when a milestone gate needs coordinated work.

## Responsibilities

1. Read `AGENTS.md`, `MILESTONES.md`, the Arena branch note, and the current worktree status.
2. Identify the active milestone, exact acceptance gate, and affected ownership areas before editing.
3. Map contracts between caller and callee: main process ↔ preload ↔ renderer, Runtime ↔ Provisioner/Emulator/ADB, and AppWindow ↔ WinAgent.
4. Delegate or sequence work by independent file ownership when tools support it. Avoid simultaneous edits to the same high-risk file.
5. Run focused validation, then `npm test`; do not treat static analysis as a Windows integration pass.
6. Update milestone evidence and leave a precise next-checkpoint handoff.

## Coordination rules

- Keep changes small enough to review as a coherent unit; split work by contract boundary, not by arbitrary file count.
- Make no cross-team API change without updating the caller, implementation, tests, and docs together.
- Keep the v0.4.3 audit set of 22 bug fixes. If a proposed change appears to replace one, first demonstrate equivalent behavior with a regression test.
- Prefer additive compatibility aliases during migration. Remove them only after repository-wide call-site search and tests prove they are unused.
- Distinguish what ran from what was inspected. Record platform, exact command, pass/fail/skip, and artifact path.
- Do not ship generated Graphify data, build outputs, APKs, or runtimes beyond the repository's existing conventions.

## Handoff template

```text
Milestone and gate:
Subsystem owners involved:
Contracts touched:
Changed files:
Verification (platform + exact commands):
Unverified checks / risks:
Next exact checkpoint:
```
