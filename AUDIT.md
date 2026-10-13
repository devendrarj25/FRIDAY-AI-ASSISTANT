# FRIDAY — Project Audit (v1.1.2.2)

Owner: **Devendra Singh Meena (`devendrarj25`)**
Scope: state of the codebase at version **1.1.2.2**.

📋 What is verified versus not, with the command that is the evidence. Live briefing (architecture, counts, next): [FRIDAY_STATE.md](FRIDAY_STATE.md). Feature map: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## 1. Verification table (Linux check)

First Lint / Types / Tests rows are what Self-Management reads.

| Check | `command` | result |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errors**. ESLint and kernel ruff passed inside `npm run preflight -- --full`. The `static` job runs the same command. |
| Types | `npm run typecheck` | clean (`tsc --noEmit`). `core/__tests__/actionlint-pin.test.ts` typechecks. |
| Tests | `npm test` | 348 files, 2892 passed, 2 skipped |
| Kernel tests | `python -m pytest kernel/tests` | 196 passed; 1 third-party Starlette/FastAPI `TestClient` deprecation warning |
| Docs registry | `npm run docs:check` | clean (registered docs, 0 duplicates, 0 thin, 0 mistitled, capability counts equal the disk) |
| Version heal | `npm run verify:version` | in sync at **1.1.2.2** (npm encoding **1.1.2**) |
| Layout | `npm run arrange:check` | **140 folders**, missing 0, duplicates 0 |
| Dependencies | `npm audit` | 0 vulnerabilities when checked; the advisory database changes daily, so re-run it |
| Local CI substitute | `npm run preflight -- --full` | passed on Linux. NSIS, verify-build, and installer smoke were skipped. Electron and the renderer bundle passed. `npm run validate:local` calls the same script. |
| Pricing knowledge | `npm run pricing:status` | reports FRESH or EXPIRED against a 14-day TTL; when EXPIRED, affected models classify as "unknown" until the provider pages are re-read and `KNOWLEDGE_CHECKED_AT` is bumped. Not re-run in this session. |
| Hosted Actions | PR Validation / FRIDAY Release | PR Validation run 38286374788 and FRIDAY Release run 38288784028 succeeded on `2ad9a83`. Pull-request run 38306698165 on `17d619b` failed in `docs-only`. Workflow dispatch run 38312765069 of that SHA passed the Windows jobs. FRIDAY Release runs 38321724754 and 38321908412 on `4067247` failed in `pin` after prepare skipped the pull request. Eleven workflow files. A hosted re-run of the prepare mode fix is unverified. |
| Windows CMD pack of this tree | `scripts\build-windows.cmd` | **NOT VERIFIED** on this tree (needs a Windows PC; this Linux host has no `cmd.exe`) |

## 2. Published 1.1.2.2

GitHub release **v1.1.2.2** (published 2026-10-12, run 38288784028): Setup (325603802 bytes), Portable (325225718 bytes), `friday-update.json`, `latest.yml`, `SHA256SUMS.txt`, CHANGELOG. `latest.yml` matches the checksum file. The Setup and Portable hashes in that file were not recomputed on this Linux tree. Version history starts at 1.0.0.0 and runs through the current public line in [CHANGELOG.md](CHANGELOG.md) and `releases/notes/`.

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
- Five React Compiler advisory lint rules are set to `warn`, not fixed: FRIDAY does not ship the React Compiler and fixing them rewrites locked UI logic.

## 5. What this file is not

Not a second architecture document. Not a feature catalog. Not a chronological log of prior audits: only the current state is kept.
