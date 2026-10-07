# FRIDAY change

## What changed

<!-- One short paragraph: what this upgrades and why. -->

## Safe merge flow

- [ ] Work happened on a branch — nothing was pushed directly to `main`
- [ ] **PR Validation** passed on this branch (typecheck, tests, kernel tests, layout, architecture audit, secret scan, NSIS installer, install/boot smoke)
- [ ] A **Test EXE Build** was run for this branch/PR (Actions → Test EXE Build → this ref)
- [ ] I installed/ran that test EXE and confirmed the change works
- [ ] New behaviour has its own new or updated test, and it does not depend on today's date, the network or git history (PR Validation warns when code changed without a test)
- [ ] Tests, `FRIDAY_STATE.md`, and affected docs in this PR match the code ([AGENTS.md](../AGENTS.md) landing bar) — not a follow-up after merge
- [ ] Windows CMD EXE build / install / uninstall / reinstall / update / repository Actions / publishing were not left stale (or, if this PR had to change them, their tests and docs were updated here)
- [ ] No existing feature, section, setting or user data was removed or broken
- [ ] No duplicate component, service, worker, timer, IPC channel or config was introduced

## Existing behaviour verified

<!-- Which existing FRIDAY areas were re-tested after this change. -->

## Release

Merging this PR does **not** publish anything. An official release is a
separate, explicit action: Actions → **Release / Build** on `main`
(or FRIDAY → Friday Hub → Build & Release).
