# FRIDAY — Project Audit (v1.0.1.2)

Owner: **Devendra Singh Meena (`devendrarj25`)**
Scope: state of the codebase at version **1.0.1.2**.

📋 What is verified versus not, with the command that is the evidence. Live briefing (architecture, counts, next): [FRIDAY_STATE.md](FRIDAY_STATE.md). Feature map: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## 1. Verification table (Linux check)

First Lint / Types / Tests rows are what Self-Management reads.

| Check | `command` | result |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errors**, warnings only (prettier clean; the warnings are five React Compiler advisory rules kept visible on purpose, see FRIDAY_STATE.md). PR Validation does not run eslint. |
| Types | `npm run typecheck` | clean (`tsc --noEmit`) |
| Tests | `npm test` | all passed; skips are network, OS-tool or git-clone checks that run where those exist |
| Kernel tests | `python -m pytest kernel/tests` | all passed; 1 third-party Starlette/FastAPI `TestClient` deprecation warning |
| Docs registry | `npm run docs:check` | clean (registered docs, 0 duplicates, 0 thin, 0 mistitled, capability counts equal the disk) |
| Version heal | `npm run verify:version` | in sync at **1.0.1.2** (npm encoding **1.0.1**) |
| Layout | `npm run arrange:check` | **139 folders**, missing 0, duplicates 0 |
| Dependencies | `npm audit` | 0 vulnerabilities when checked; the advisory database changes daily, so re-run it |
| Local CI substitute | `npm run validate:local` | passes on Linux; NSIS / verify-build / installer smoke need Windows and are skipped |
| Pricing knowledge | `npm run pricing:status` | reports FRESH or EXPIRED against a 14-day TTL; when EXPIRED, affected models classify as "unknown" until the provider pages are re-read and `KNOWLEDGE_CHECKED_AT` is bumped |
| Hosted Actions | PR Validation / FRIDAY Test Build / FRIDAY Release | **NOT VERIFIED** on this checkout. Eleven workflow files exist. An older `main` commit has a finished green PR Validation; that run is not evidence for this head. FRIDAY Release on this tree has not been dispatched. |
| Windows CMD pack of this tree | `scripts\build-windows.cmd` | **NOT VERIFIED** on this tree (needs a Windows PC; this Linux host has no `cmd.exe`) |

## 2. Published 1.0.1.2

GitHub Latest **v1.0.1.2** (2026-10-05): Setup, Portable, `friday-update.json`, `latest.yml`, `SHA256SUMS.txt`, CHANGELOG. Version history starts at 1.0.0.0 and runs through the current public line in [CHANGELOG.md](CHANGELOG.md) and `releases/notes/`.

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
