# FRIDAY — Project Audit (v1.1.2.2)

Owner: **Devendra Singh Meena (`devendrarj25`)**
Scope: state of the codebase at version **1.1.2.2**.

📋 What is verified versus not, with the command that is the evidence. Live briefing: [FRIDAY_STATE.md](FRIDAY_STATE.md). Feature map: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## 1. Verification table (Linux check)

First Lint / Types / Tests rows are what Self-Management reads. This table is the 2026-10-13 Linux session. A later row must not put a positive error count in front of these three.

| Check | `command` | result |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errors**. Inside `npm run preflight`, ESLint was silent and ruff reported `All checks passed!` plus `63 files already formatted`. |
| Types | `npm run typecheck` | clean. Printed `FRIDAY 1.1.2.2`. |
| Tests | `npm test` | 348 files passed, 2892 passed, 2 skipped, 92.68s |
| Kernel tests | `python -m pytest kernel/tests` | 196 passed; 1 third-party Starlette/FastAPI `TestClient` deprecation warning; 21.34s |
| Docs registry | `npm run docs:check` | clean (24 documents, 0 duplicates, 0 thin, 0 mistitled, capability counts equal the disk) |
| Version heal | `npm run verify:version` | in sync at **1.1.2.2** (npm encoding **1.1.2**) |
| Layout | `npm run arrange:check` | **140 folders**, missing 0, duplicates 0 |
| Dependencies | `npm audit` | not re-run this session. The advisory database changes daily, so a previous zero is not this row |
| Local CI substitute | `npm run preflight` | exit 0 on Linux. Fourteen gates passed. This run was not `--full`, so NSIS, packaged verify, installer smoke, Electron, and the renderer bundle were not run. `npm run validate:local` calls the same script |
| Pricing knowledge | `npm run pricing:status` | FRESH. Oldest source perplexity, checked 2026-10-07, expires 2026-10-21 |
| Hosted Actions | PR Validation / FRIDAY Release | Release `v1.1.2.2` is run 38348306084. Docs-only run 38372554640 on this branch stopped in `npm test` with 18 EACCES errors from root-owned sandbox files. Docker wraps now pass `--user` for a non-root caller. A re-run of that job is unverified. Eleven workflow files stay locked |
| Windows CMD pack of this tree | `scripts\build-windows.cmd` | **NOT VERIFIED** on this tree (needs a Windows PC; this Linux host has no `cmd.exe`) |

## 2. Published 1.1.2.2

GitHub release **v1.1.2.2** (published 2026-10-13, run 38348306084): Setup (325604495 bytes), Portable (325226416 bytes), `friday-update.json`, `latest.yml`, `SHA256SUMS.txt`, CHANGELOG. The earlier release `v1.1.1.2` is run 38288784028. The Setup and Portable hashes in `SHA256SUMS.txt` were not recomputed on this Linux tree. Version history starts at 1.0.0.0 and runs through the current public line in [CHANGELOG.md](CHANGELOG.md) and `releases/notes/`.

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
- Hands-free Auto defaults off.
- numpy / chromadb / device extras are optional at kernel boot; missing extras must not abort FastAPI startup.
- Physical microphone / wake word / barge-in: **NOT VERIFIED** (needs a Windows desktop with capture hardware).
- Dependency updates change the lockfile: let PR Validation rebuild the Windows package before merging them.
- Five React Compiler rules and `react-hooks/exhaustive-deps` are `"error"` in `eslint.config.js`. `react-refresh/only-export-components` stays `"warn"`. FRIDAY does not ship the React Compiler.

## 5. What this file is not

Not a second architecture document. Not a feature catalog. Not a chronological log of prior audits: only the current state is kept.
