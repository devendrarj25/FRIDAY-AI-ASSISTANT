# FRIDAY — Project Audit (v1.1.4.6)

Owner: **Devendra Singh Meena (`devendrarj25`)**
Scope: state of the codebase at version **1.1.4.6**.

📋 What is verified versus not, with the command that is the evidence. Live briefing: [FRIDAY_STATE.md](FRIDAY_STATE.md). Feature map: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## 1. Verification table (Linux check)

First Lint / Types / Tests rows are what Self-Management reads. This table is filled from the commands run on this tree. A later row must not put a positive error count in front of these three.

| Check | `command` | result |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errors**. ESLint was silent and ruff reported `All checks passed!` plus `75 files already formatted`. |
| Types | `npm run typecheck` | clean. Printed `FRIDAY 1.1.4.6`. |
| Tests | `npm test` | 458 files passed, 3998 passed, 5 skipped. Exit 0 |
| Kernel tests | `npm run test:kernel` | 276 passed, 5 skipped in 32.35s. Exit 0 |
| Kernel types | `npm run typecheck:py` | 4 passed (pyright baseline) |
| Docs registry | `npm run docs:check` | clean (24 documents, 0 missing, 0 unregistered, 0 duplicated blocks, 0 thin, 0 mistitled, index, map and kernel routes in sync, capability counts equal the disk, provider status stale false) |
| Version heal | `npm run verify:version` | in sync at **1.1.4.6** (npm encoding **1.1.4**) |
| Layout | `npm run arrange:check` | **140 folders**, missing 0, duplicates 0 |
| Architecture audit | `node scripts/audit-architecture.cjs --strict` | pass |
| Commit provenance | `npm run check:provenance` | pass |
| Renderer build | `npm run build:desktop` | pass; `src/routeTree.gen.ts` unchanged |
| Local CI substitute | `npm run preflight -- --full` | every Linux gate passed. Windows NSIS pack, packaged verify, and installer smoke were skipped on Linux |
| Hosted Actions | all eleven workflows | green and working, from the owner's runs on 2026-10-25: PR Validation (pull request run 245, manual run 247 on `main`), FRIDAY Release (run 33, `v1.1.4.6` published and its assets read back), FRIDAY Test Build (run 5), Maintenance Cleanup (run 8), Branch Cleanup and Main Safety Recovery on every merge, and the scheduled Auto Recover, Security Scan and Health Weekly. Repository Control is reported working by the owner; its run result was not read here. The workflows are not changed ([FRIDAY_STATE.md](FRIDAY_STATE.md)) |
| Windows CMD pack of this tree | `scripts\build-windows.cmd` | **NOT VERIFIED** (needs a Windows PC) |
| Real-PC `npm run setup`, `npm run doctor`, `npm run build:win` | the three commands in `cmd.exe` | the owner's run on Windows 11 Home ended in FAIL (Windows Sandbox counted as a failed install, winget results mislabelled, Rust launcher mistaken for a compiler, stale PATH after installs); each cause is fixed in code and pinned by `core/__tests__/real-pc-setup-fixes.test.ts`. A rerun on that PC is **NOT VERIFIED** |
| Build downloads reach the installed app | `electron/staged-assets.cjs`, `electron/install-inventory.cjs`, `OWNERSHIP` in `electron/friday-contract.cjs` | Linux tests only (`staged-assets`, `install-inventory`, `ownership-contract`). First launch after a build with no folder chosen, and an update over a real install: **NOT VERIFIED** |

## 2. Published line

GitHub release v1.1.4.6 is published (FRIDAY Release run 30: Setup 321406580 bytes, Portable 321028417 bytes, `friday-update.json`, `latest.yml`, `SHA256SUMS.txt`, `CHANGELOG.md`); the EXEs were not downloaded or installed here. Version history stays in [CHANGELOG.md](CHANGELOG.md) and `releases/notes/`.

## 3. How the tests stay green without attention

- No test depends on today's date: pricing / free-plan classification is tested with a pinned clock; freshness itself is reported by `npm run pricing:status`.
- No test depends on this checkout's git history: release-range logic is tested in a throwaway repository.
- A missing environment (offline, no `netstat`, no `.git`) skips visibly; a wrong result still fails.
- Health Weekly runs the same checks as `npm run resume` every Monday and keeps one issue open while anything is broken. Auto Recover re-runs validation runs that never started because Actions minutes ran out.

## 4. Open limitations that still match the code

- Unsigned default (`signExecutable: false`). SmartScreen may warn.
- Exec-tier kernel tools wait for desktop approval (`auto_approve_exec: false`).
- LocalAI on Windows has no vendor-documented native EXE (Docker). FRIDAY will not fake a winget install or a successful start without `local-ai` on PATH.
- llama.cpp / vLLM are not fully automatic: they need exactly one matching model file in `<FRIDAY_ROOT>/models` before `startEngine` builds a command.
- Cloudflare Workers AI is not wired (account id in the chat URL; no OpenAI `/v1/models` on that base).
- DeepSeek has no readable price table, so its models stay unknown until one is published.
- `chromadb` 1.5.9 advisories have no published fix version.
- Hands-free Auto defaults off.
- numpy / chromadb / device extras are optional at kernel boot; missing extras must not abort FastAPI startup.
- Physical microphone / wake word / barge-in: **NOT VERIFIED** (needs a Windows desktop with capture hardware).
- Live keyed provider calls and a live speech-model download: **NOT VERIFIED**.
- Shutdown and Restart on the packaged EXE: **NOT VERIFIED**.
- Dependency updates change the lockfile: let PR Validation rebuild the Windows package before merging them.
- Five React Compiler rules and `react-hooks/exhaustive-deps` are `"error"` in `eslint.config.js`. `react-refresh/only-export-components` stays `"warn"`. FRIDAY does not ship the React Compiler.

## 5. What this file is not

Not a second architecture document. Not a feature catalog. Not a chronological log of prior audits: only the current state is kept.
