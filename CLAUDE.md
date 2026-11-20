# Claude Code entry point

Follow the repository-wide instructions in [`AGENTS.md`](AGENTS.md) and the active gate in [`MILESTONES.md`](MILESTONES.md). Do not duplicate or override those rules.

For coordinated multi-area work, read [the ApkStart orchestrator skill](.claude/skills/apkstart-orchestrator/SKILL.md). For a focused task, read only the relevant department skill:

- Core/runtime contracts: `.claude/skills/core-runtime/SKILL.md`
- Windows agent and window embedding: `.claude/skills/windows-agent/SKILL.md`
- Renderer, preload, and IPC: `.claude/skills/ui-ipc/SKILL.md`
- Packaging and release operations: `.claude/skills/build-release/SKILL.md`
- Tests, documentation, and evidence: `.claude/skills/qa-docs/SKILL.md`

Start by checking the current branch and worktree. Use `npm test` as the required automated regression gate. Never claim Windows/Electron-only behavior was tested unless it was run on Windows.
