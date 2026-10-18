# FRIDAY — Project Audit (v1.1.2.4)

Owner: **Devendra Singh Meena (`devendrarj25`)**
Scope: state of the codebase at version **1.1.2.4**.

📋 What is verified versus not, with the command that is the evidence. Live briefing: [FRIDAY_STATE.md](FRIDAY_STATE.md). Feature map: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md).

## 1. Verification table (Linux check)

First Lint / Types / Tests rows are what Self-Management reads. This table is filled from the command run on this tree. A later row must not put a positive error count in front of these three.

| Check | `command` | result |
| --- | --- | --- |
| Lint | `npm run lint` | re-run pending for this tree. No failing count is recorded. |
| Types | `npm run typecheck` | re-run pending for this tree. |
| Tests | `npm test` | re-run pending for this tree. |
| Kernel tests | `python -m pytest kernel/tests` | re-run pending for this tree. |
| Docs registry | `npm run docs:check` | re-run pending for this tree. |
| Version heal | `npm run verify:version` | expected in sync at **1.1.2.4** (npm encoding **1.1.2**). The command result is written when it runs. |
| Layout | `npm run arrange:check` | re-run pending for this tree. |
| Dependencies | `npm audit` | not re-run this session. The advisory database changes daily, so a previous zero is not this row |
| Local CI substitute | `npm run preflight` | re-run pending. `npm run validate:local` calls the same script |
| Pricing knowledge | `npm run pricing:status` | not re-run this session |
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
