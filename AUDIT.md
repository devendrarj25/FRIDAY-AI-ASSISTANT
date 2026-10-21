# FRIDAY — Project Audit (v1.1.2.4)

Owner: **Devendra Singh Meena (`devendrarj25`)**
Scope: state of the codebase at version **1.1.2.4**.

📋 What is verified versus not, with the command that is the evidence. Live briefing: [FRIDAY_STATE.md](FRIDAY_STATE.md). Feature map: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## 1. Verification table (Linux check)

First Lint / Types / Tests rows are what Self-Management reads. This table is filled from the command run on this tree. A later row must not put a positive error count in front of these three.

| Check | `command` | result |
| --- | --- | --- |
| Lint | `npm run lint` | **0 errors**. ESLint was silent and ruff reported `All checks passed!` plus `65 files already formatted`. |
| Types | `npm run typecheck` | clean. Printed `FRIDAY 1.1.2.4`. |
| Tests | `npm test` | 375 files passed, 3096 passed, 2 skipped, 92.96s. Exit 0 |
| Kernel tests | `python -m pytest kernel/tests` | 204 passed in 19.12s. Exit 0 |
| Docs registry | `npm run docs:check` | clean (24 documents, 0 duplicates, 0 thin, 0 mistitled, capability counts equal the disk, provider status stale false) |
| Version heal | `npm run verify:version` | in sync at **1.1.2.4** (npm encoding **1.1.2**) |
| Layout | `npm run arrange:check` | **140 folders**, missing 0, duplicates 0 |
| Dependencies | `npm audit` | **1 high** on 2026-10-21: vite 8.3.2 (GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, GHSA-587h-7wmj-h5pm). The published fix is 8.3.5. The Vite 8.3.2 floor was not moved. `pip-audit` was not re-run. chromadb 1.5.9 (PYSEC-2026-311, PYSEC-2026-3813, PYSEC-2026-3814, PYSEC-2026-3815) had no published fix version, so that pin was not moved. |
| Local CI substitute | `npm run preflight` | exit 0 on Linux. `test:fast` passed: 137 files, 1135 tests, 26.91s. Windows pack gates were not run. `npm run validate:local` calls the same script. `npm run build:desktop` passed in 5.96s (2980 modules). |
| Pricing knowledge | `npm run pricing:status` | Exit 1. EXPIRED. Oldest is perplexity, checked 2026-10-07, expires 2026-10-21 (−1 day). groq and gemini are still fresh. `checkedAt` was not moved. |
| Commit provenance | `npm run check:provenance` | passed for this branch. New commits use the repository owner as author. Assistant-authored commits already on `main` were not rewritten |
| Hosted Actions | PR Validation / FRIDAY Release | The owner reported these green for public line 1.1.2.4 on 2026-10-18. This branch's hosted runs were not started |
| Windows CMD pack of this tree | `scripts\build-windows.cmd` | **NOT VERIFIED** on this branch (needs a Windows PC). The owner verified that command for public line 1.1.2.4 on 2026-10-18 |

## 2. Published 1.1.2.4

GitHub release v1.1.2.4 was published 2026-10-17T04:20:37Z. The asset list read here on 2026-10-18 names Setup (321311216 bytes), Portable (320933137 bytes), `friday-update.json`, `latest.yml`, `SHA256SUMS.txt`, and `CHANGELOG.md`. The EXEs were not downloaded here, so the sums file was not recomputed. The owner verified Release build and publish for this line. Version history stays in [CHANGELOG.md](CHANGELOG.md) and `releases/notes/`.

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
- Live keyed provider calls and a live speech-model download: **NOT VERIFIED**.
- Shutdown and Restart on the packaged EXE: **NOT VERIFIED**.
- Dependency updates change the lockfile: let PR Validation rebuild the Windows package before merging them.
- Five React Compiler rules and `react-hooks/exhaustive-deps` are `"error"` in `eslint.config.js`. `react-refresh/only-export-components` stays `"warn"`. FRIDAY does not ship the React Compiler.

## 5. What this file is not

Not a second architecture document. Not a feature catalog. Not a chronological log of prior audits: only the current state is kept.
