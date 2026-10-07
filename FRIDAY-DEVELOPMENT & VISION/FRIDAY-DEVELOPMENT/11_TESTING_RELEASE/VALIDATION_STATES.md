# Validation States — SOURCE_READY vs BUILD_READY

Two different questions, two different states. Don't conflate them, and
don't let either count as evidence for the other.

## SOURCE_READY
"Does this checkout's source pass its own checks?" — typecheck, lint, unit
tests, docs/registry validation, JSON validation, the development/vision
independence test. None of these require a compiled artifact to exist.

A checkout with no `dist-desktop/`, no `release/*.exe`, and no
`node_modules/` yet is not broken — it just hasn't been built. Missing
build output is expected on a fresh clone or a source-only ZIP; it is not a
SOURCE_READY failure. Existing tests already respect this: checks that
mention `.exe`/`dist-desktop` verify that *source scripts contain the right
string or logic* (e.g. `expect(closer).toContain("FRIDAY.exe")`), not that
a compiled binary is present on disk — confirmed by a clean SOURCE_READY
run with zero build output present (2323/2331 tests passing on a pure
source checkout; the handful of unrelated failures need real `git` history
or real network access, not a build).

**Gate:** `npm ci` (or `npm install` where `ci` isn't available), then
`npm run typecheck`, then `npm test`. All must pass without a build step.

## BUILD_READY
"Does this checkout produce a working installer/EXE?" — the actual NSIS
build, install, boot, readiness, and uninstall smoke path. This requires
Windows, a full `npm install`, and the packaging step; it is a different,
heavier gate than SOURCE_READY and is what CI's build/release workflows
check (see `RELEASE_GATES.md`).

**Gate:** whatever `pr-validation.yml` / `release.yml` already run — a real
NSIS installer, install/boot/uninstall smoke test. Do not simulate this on
a Linux agent and call it verified; say NOT VERIFIED instead (see
`AGENTS.md`'s Linux-agent honesty rule).

## Reporting rule
When reporting a validation result (to the owner or in a change ledger
entry), name which state you're reporting — "SOURCE_READY: pass" is not the
same claim as "BUILD_READY: pass," and claiming the second without actually
running a build is a false PASS.
