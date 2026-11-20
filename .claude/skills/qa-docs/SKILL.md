---
name: apkstart-qa-docs
description: Maintain regression tests, milestone evidence, troubleshooting, architecture and developer documentation for ApkStart.
---

# QA and documentation department

## Scope

Own `test/`, test-support fixtures, `MILESTONES.md`, `README.md`, `CONTRIBUTING.md`, maintained documents under `docs/`, and Graphify refresh/inspection.

## Test rules

- Prefer deterministic, local-only tests. A test must not require an external APK, account, secret, or network unless it is explicitly an opt-in integration test.
- Use synthetic fixtures and temporary directories. Always restore settings and clean up files, servers, and child processes in `finally` paths.
- Keep test titles and assertion output in English. Preserve any production localization contract only when the product explicitly requires it; describe the expected contract in English.
- Keep optional/hardware-dependent test skips explicit and distinguish skipped from passed.
- Test the regression at the seam where it failed, not only an unrelated helper.

## Documentation rules

- English is the default for maintained documentation, scripts, test output, and operational copy. Use current source as the authority; remove stale line-number-only instructions and unsupported performance claims.
- Label measured results with the machine/runtime/date when known. Present targets as targets, not guarantees.
- Keep the distinction between an automated pass, static inspection, and a Windows/device manual run.
- Update milestone checkboxes only with evidence and refresh `graphify-out/` after code has stabilized.
