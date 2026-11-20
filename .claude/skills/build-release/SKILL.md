---
name: apkstart-build-release
description: Maintain portable and NSIS packaging, runtime preparation, CI workflows, release assets, and build-time checks.
---

# Build and release department

## Scope

Own `build/`, `electron-builder.yml`, `.github/workflows/`, and packaging/release scripts under `scripts/` and `tools/`.

## Safety and reproducibility

- Keep build outputs and runtime binaries out of Git; follow `.gitignore` and the established `build/runtime/` generation flow.
- Keep `@napi-rs/lzma` and its Windows x64 native package in the packaged app when runtime `.xz` extraction uses them. Verify dependency and electron-builder file filters together.
- Preserve the distinction between the portable shell package, the bundled-runtime setup package, and the runtime archive. The updater must never select a runtime archive as an application update.
- Validate archive entry paths before extraction, check expected assets, and fail loudly when a release artifact is missing or malformed.
- Keep release credentials in GitHub Actions secrets/environment only. Never print token values or write them into generated files.
- Build comments, logs, installer text, and workflow step names in English.

## Verification

- Run tests and syntax checks after build-script changes.
- Use a clean output directory for packaging checks; report artifact names and sizes, not just “build succeeded.”
- Verify the resulting package contains required source, preload, native dependencies, shell assets, and the intended runtime resources.
- Run the Windows CI workflows or clearly record why they could not be run. Do not create or publish a release unless asked.
