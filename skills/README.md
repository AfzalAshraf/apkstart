# ApkStart agent skills

The role-specific guides live under `.claude/skills/` and are intended to be used alongside the repository-wide rules in [`AGENTS.md`](../AGENTS.md) and the release gates in [`MILESTONES.md`](../MILESTONES.md).

- `apkstart-orchestrator`: coordinate work across departments and maintain a precise milestone handoff.
- `core-runtime`: Node core modules, APK parsing, ADB, provisioning, and runtime lifecycle.
- `windows-agent`: PowerShell/C# Win32 agent, window embedding, mouse input, and per-app window lifecycle.
- `ui-ipc`: renderer, preload allowlist, main-process IPC, and English UI copy.
- `build-release`: portable/NSIS packaging, runtime preparation, CI, and release operations.
- `qa-docs`: deterministic tests, milestone evidence, maintained docs, and Graphify outputs.

For a task spanning multiple areas, use the orchestrator first, then apply the narrowest relevant department guide(s). These are instructions, not separate release approval; user authorization and milestone evidence still govern destructive or publishing actions.
