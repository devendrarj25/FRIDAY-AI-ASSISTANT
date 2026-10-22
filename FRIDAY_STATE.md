# FRIDAY — Project State

FRIDAY is a private local-first Windows Electron + React + Python FastAPI work desk (currently version 1.1.3.4) owned by **Devendra Singh Meena** (`devendrarj25`). Official repo: https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.

This briefing is the tree as it is now. Evidence: [AUDIT.md](AUDIT.md). Features: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Rules: [AGENTS.md](AGENTS.md). Gate: [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md). Version history stays in [CHANGELOG.md](CHANGELOG.md).

Read order: `AGENTS.md`, then this file, then `docs/FRIDAY_CHANGE_CONTROL.md`, then the one owning doc.

## Owner-verified (2026-10-18, public line 1.1.2.4, build 2026.10.17)

On the owner's Windows PC: PR Validation, Test Build including publish, Release build and publish, `npm run setup`, `npm run build:win`, install, uninstall, and reinstall. GitHub release `v1.1.2.4` was published 2026-10-17T04:20:37Z (Setup 321311216 bytes, Portable 320933137 bytes). This session read that asset list and did not download the EXEs. Known-good tool versions are recorded once in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

That check does not cover this branch. Shutdown and Restart button behaviour, microphone hearing, speech recognition, live provider calls, model downloads, and in-app update apply were not part of it.

## Checks on this Linux tree

Run on 2026-10-22 on branch `fix/voice-models-catalogue` (Linux cloud container, not Windows), after `npm ci` and `npm run setup:python` (venv `.venv`, pytest and pyright on PATH). Windows pack gates were skipped on Linux. Hosted Actions were not started. `git status` was clean after `build:desktop`.

| Check | Result |
| --- | --- |
| Branch `fix/build-stt-self-test`, Doctor fixes (2026-10-22, Linux container) | `npm run preflight -- --full` exit 0: 391 files, 3219 passed, 4 skipped; kernel 240 passed, 2 skipped; lint, typecheck, pyright, docs, provenance pass. Windows pack gates skipped on Linux. |
| Branch `fix/build-stt-self-test`, voice fixes (2026-10-22, Linux container) | `npm run preflight -- --full` exit 0: 390 files, 3209 passed, 4 skipped; kernel 240 passed, 2 skipped; lint, typecheck, pyright, docs, provenance pass. Windows pack gates skipped on Linux. |
| Branch `fix/build-stt-self-test` (2026-10-22, Linux container) | `npm run preflight -- --full` exit 0: 389 files, 3195 passed, 4 skipped; kernel 237 passed, 2 skipped; pyright ceiling, lint, typecheck, docs, version, provenance, actionlint, arrange, deps, audit, renderer pass. NSIS, verify-build, and installer smoke skipped on Linux. `python -I kernel/stt.py --self-test` fails on the old file and exits 0 with JSON on the new one. `pip download` for `win_amd64`: ctranslate2 4.8.3 has a `cp314` wheel and no `cp315` one. PowerShell was not available to parse `installer/build/install-python.ps1`. |
| Branch `upgrade/voice-listen-modes` (2026-10-22, Linux container) | `npm run preflight -- --full` exit 0: 388 files, 3186 passed, 4 skipped; kernel pytest, pyright ceiling, lint, typecheck, docs, provenance, verify:version pass. Real-app readiness under xvfb with a fake Ollama passed all 13 stages; the fake log shows 2 `POST /api/chat`. Windows paths unverified. |
| Real app readiness (`node scripts/readiness-test.cjs`, Electron 43 under xvfb as root with a `--no-sandbox` wrapper, fake Ollama on 11434) | PASSED all stages: ENVIRONMENT, INSTALL, START, ROOT, BOOT, KERNEL, DATABASE, MODEL, CHAT, VOICE, BASIC TASK, SHUTDOWN, RESTART. The fake Ollama log shows 2 `POST /api/chat`, so the real app routed a chat to the local model. Before the JSON fix the same run failed VOICE with `speech self-test did not return JSON`. Not a Windows run. |
| `npm run docs:sync` | Passed. 24 documents, all zeros. Provider status stale false. |
| `npm run docs:check` | Passed. 24 documents. missing 0, unregistered 0, thin 0, wrong title 0, duplicated blocks 0, capability counts off 0, provider status stale false. |
| `npm run verify:version` | Passed. `version 1.1.2.4 - all version sources and governed documents are in sync`. Heal check: `version 1.1.2.4 - release-ready, nothing to heal`. |
| `npm run arrange:check` | Passed. 140 folders, missing 0, duplicates 0, junk 0. |
| `npm run lint` | Passed. ESLint was silent. Ruff reported `All checks passed!` and `65 files already formatted`. |
| `npm run typecheck` | Passed. Printed `FRIDAY 1.1.2.4`. |
| `npm run typecheck:py` | Passed. 4 passed in 11.87s. My new test file first pushed the count to 71 and was fixed. `kernel/pyright-baseline.txt` ceiling is 70. The test asserts the count does not grow. |
| `npm run test:kernel` | 231 passed, 2 skipped in 29.06s. Exit 0. The 2 skips are the real-Whisper hearing test (no weights) and one optional-wheel test. |
| `npm test` | 383 files passed, 3156 passed, 4 skipped. Exit 0. The first run found `local-daemon-funnel` failing on `origin/main` too (it pinned the pre-fix LM Studio not-loaded text); that test now pins the documented behaviour. |
| `node scripts/tests-required.cjs origin/main` | 13 code files, 7 test files. |
| `npm run check:provenance` | Passed. `provenance ok (origin/main)`. New commits use the repository owner as author. Assistant-authored commits already on `main` were not rewritten. |
| `node scripts/run-actionlint.cjs` | Passed. `workflow lint: actionlint`. |
| `node scripts/audit-architecture.cjs --strict` | Passed. 751 source files. REVIEW lines remain. No file was deleted. |
| `npm run preflight -- --full` | Exit 0. Every Linux gate passed. `node scripts/verify-deps.cjs` checked 155 files. NSIS, verify-build, and installer smoke were skipped on Linux. |
| `npm run build:desktop` | Passed inside that preflight. 2980 modules, built in 5.50s. `AppShell-DM14ks4s.js` is 3,673.94 kB (gzip 1,310.31 kB). `src/routeTree.gen.ts` was unchanged. |
| `npm audit` | 0 vulnerabilities on 2026-10-21 (info 0, low 0, moderate 0, high 0, critical 0). Vite is already pinned at 8.3.5 in `package.json` and the lock. This change did not bump it. |
| `pip-audit` | Not re-run. chromadb 1.5.9: PYSEC-2026-311, PYSEC-2026-3813, PYSEC-2026-3814, PYSEC-2026-3815. No published fix version, so the pin was not moved. |
| `npm run pricing:status` | Exit 1. EXPIRED. Oldest is deepseek, checked 2026-10-07, expires 2026-10-21 (−1 day). groq, gemini, mistral, nvidia, zhipu, openai, anthropic, and perplexity are fresh (checked 2026-10-21, 13 days). DeepSeek's pricing URL did not contain a price table, so that date was not moved. |

## UNVERIFIED

This change (hearing, speaking, local runners, pricing evidence): the Whisper leg of the hearing self-test never ran here, because Hugging Face is blocked from this container and no speech weights exist; only the espeak-ng, WAV, `prepare_audio`, real pyrnnoise 0.4.5 denoise path ran, with a stand-in recogniser. No live Ollama or LM Studio ran (a fake Ollama HTTP server proved detection and the firewall). The Groq free-plan id list could not be re-read (console.groq.com unreachable), so Groq ids stay unknown until the owner marks them free. Hosted Actions, the Windows CMD pack, and every Windows speech and speaker path remain unverified.

Live microphone and speech recognition on Windows. A live speech-model download. A long answer past 30 seconds on a slow free model and on a big local model. A frozen-window recovery message. Moonshine or Windows speech chosen on that PC after the faster-whisper weights are removed. A dead model marked on the Models page before use. Live provider calls, including OpenRouter. Shutdown and Restart on the packaged EXE, and process cleanup after them. In-app update apply. This branch's Windows CMD pack (`scripts\build-windows.cmd`), readiness RESTART, installer, and SmartScreen. Hosted Actions for this branch. This session did not start a workflow. Linux output is not those checks.

## Snapshot

| Item | Live value |
| --- | --- |
| Public version | `1.1.2.4` (`config/friday-version.json`) |
| npm encoding | `1.1.3` (`package.json`) — never compared as an update identity |
| Epoch | 2 / `friday-2` |
| Published line | GitHub release `v1.1.2.4` (2026-10-17). The next patch is `1.1.2.5` and is not bumped here. |
| Next public revision | Do not bump this file. Assistants do not bump `config/friday-version.json`. |

Stack floors stay in `package.json` and `config/toolchain-versions.json`: Electron ^43.7.7, electron-builder 26.15.3, Node `>=22.19.0`, Python floor 3.12.10. Vite is pinned at 8.3.5 in `package.json`. The owner's known-good comparison still names Vite 8.3.2 from 2026-10-17 and is not a new floor.

## Coming back after a gap

`git switch main && git pull`, then one branch whose prefix is in [CONTRIBUTING.md](CONTRIBUTING.md), then `npm ci`, then **`npm run preflight`**. Read order is the same as [AGENTS.md](AGENTS.md): this file is second. `npm run resume` and Health Weekly are catalogued in [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). `npm run test:fast` runs tests for the diff against `origin/main`, and a fast core subset when that range has no related tests. `npm run pricing:status` reports whether the pricing snapshot is still inside 14 days.

## Architecture (code, not a second copy of ARCHITECTURE.md)

Renderer `src/` → preload allowlist `electron/preload.cjs` → main `electron/` → kernel `kernel/main.py`. Chat and Voice call `electron/model-router.cjs` `routeRequest`. The persisted catalogue is `electron/model-catalogue-store.cjs`. Side lane lists are pure. `kernel/router.py` executes the ids that funnel already chose. Desktop start, hide, restart, and exit go through `electron/app-lifecycle.cjs`. `electron/main.cjs` wires the steps and does not call quit, exit, or relaunch itself. Readiness asks that lifecycle to shut down so the kernel process tree is gone before exit, and `/health` must carry this launch's `instance_id`. `core/` is Vitest and contracts only. Navigation in `src/lib/friday/navigation.ts`: 28 sidebar paths, Settings in the footer, `/character` and `/workflow-visual` are not sidebar rows. Layer map: [ARCHITECTURE.md](ARCHITECTURE.md).

Speech downloads use source families in `config/download-hosts.json`. The live STT ladder, the voice self-heal policy, and the choice not to bundle a speech model are in [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Provider gates, error class, and the OpenRouter privacy setting are in [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md). IPC calls use one budget table: a quick call waits 30 seconds, a long job has no total deadline, and a stream ends only after 120 seconds without output. The error names that budget. The work keeps running, and that error alone does not start a voice-heal retry or a model fallback. A stalled main window is written into the Doctor, then the lifecycle reloads the renderer and leaves the kernel process alone. A local model listed in `config/models.yaml` stays unavailable until discovery marks it installed. Chat then says `no installed local model`, and the pack still continues.

Product code does not require `.cursor/`. `scripts/cloud-agent-install.sh` and `scripts/cloud-agent-start.sh` stay required. `.cursor/environment.json` is the cloud install and start when that file is present. Build outputs and run state (`release/`, `dist-desktop/`, `debug/`, `.venv/`, `.friday-dev/`, `.friday-readiness-root/`, `node_modules/`) stay ignored and are not packed.

## Capability counts (this checkout)

Counted from the files named in the last column. `docs:sync` rewrites the six disk counts when they drift.

| Kind | Count | How counted |
| --- | --- | --- |
| Skills | 214 `skill.json` + 9 builtins | disk + `electron/skills.cjs` `BUILTIN` |
| Tools | 178 `tool.json` | disk |
| Agents | 98 `manifest.json` | `agents/` |
| Plugins | 78 `plugin.json` | disk |
| Workflows | 117 `workflow.json` | disk |
| Modules | 76 `manifest.json` | disk |
| Connectors | 113 | `electron/connectors.cjs` `CONNECTORS` |
| Kernel tools | 53 | `kernel/tools.py` `RISK` |
| Cloud providers | 20 | `electron/models.cjs` `CLOUD` |
| Local engines | Ollama + LM Studio + llama.cpp + vLLM + LocalAI + Jan (MLX-LM live on darwin only) | `LOCAL_ENGINES` + Ollama |
| Workflows (GitHub) | 11 YAML files | `.github/workflows` |
| `FOLDERS` | 40 | `electron/friday-contract.cjs` |

`npm run arrange:check` declares 140 layout folders. That number is the arrange contract, not `FOLDERS`.

Python floors stay in `kernel/requirements.txt` (FastAPI, `faster-whisper`, `edge-tts`). The voice-stack rule in `kernel/requirements-capabilities.txt` refuses torch, vLLM, vosk, piper-tts, kokoro-onnx, sherpa-onnx, and the silero-vad pip package. The kernel boots with no voice model.

## GitHub automation

Eleven workflow files: eight release and repository workflows plus Health Weekly, Auto Recover, and Security Scan. Catalog and triggers: [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). GitHub workflows stay locked. The owner reported PR Validation, Test Build including publish, and Release build and publish green for 1.1.2.4 on 2026-10-18. An edit waits for a second yes or ok, unless other work cannot finish without the smallest change, and every error that change causes is fixed in that same change. The owner runs every workflow. No agent runs one. The rule text is in [AGENTS.md](AGENTS.md) → Actions, pull, and merge.

## Deliberate design decisions

These look like bugs. They are not. Do not "fix" them.

- `core/` is not imported by the shipped EXE.
- `handsFree` initializes **false**. Auto mode is the only listen-and-speak session. Manual and chat do not open the microphone and do not speak. Turning Hands-free off requires the wake word again and is remembered. `automation.auto_approve_exec` stays false.
- `automation.auto_approve_exec: false` in `config/kernel.yaml`. Full autonomy is the owner's dial in the app (Ask every time, Balanced, Full). A fresh install stays Balanced. Stop everything still halts her.
- Privacy firewall: SENSITIVE is a hard stop. Other content may use an already-connected provider. Privacy mode keeps speech recognition local and does not send a turn to a cloud model.
- Billing firewall: no silent paid spend. An unknown-cost model is not an automatic route unless that model has `spendCapUsd`. Official free evidence is usable before a live probe. The kernel and the desktop use the same source list. A stale price stays unknown. Strict privacy defaults off.
- Pricing knowledge in `electron/model-access.cjs` fails closed on **no proof**, not on age (owner direction for this change). A model that an official source proved free stays free on the last good table and is flagged `cached <age>`; a model with no proof is "unknown", never silently free, and shows "pricing info is stale, refresh now", not a paid bill. Sources are re-read at start, every 24 hours, after sleep, and on Refresh now; a failed fetch keeps the last table. Startup and Refresh now re-read due pages when the PC is online and privacy mode is off. A page that does not parse leaves the last table. The owner can mark any unverified cloud model free. A free-quota end or a rate limit moves only to another free model. Tests do not depend on today's date.
- Screen text, files, and tool output are data. The desktop plan comes from the owner's words. A credential, payment, captcha, or secure-desktop prompt is handed to the owner. Full autonomy does not click those. Stop everything still halts the loop. Heard speech does not run a tool by itself.
- Publisher identity is locked (`scripts/identity.cjs` / `lockedIdentityFields`). The public id is the owner name and the GitHub username `devendrarj25`. A package does not carry an email, a phone number, or a street address.
- `PROTECTED_POLICY_FILES` in `src/lib/friday/self/governance.ts` are off-limits to self-dev auto-apply.
- One feature, one implementation (`config/project-structure.json`).
- Requirements are **floors**, not pins. numpy and chromadb stay optional at FastAPI boot.
- The look of the app stays outside the Flow Studio canvas. Inside that canvas the drawing uses canvas tokens on the same theme. Which areas are locked is the rule in [AGENTS.md](AGENTS.md). A change that is not re-checked on the owner's PC stays unverified until the owner re-checks.
- GitHub workflows stay locked. The owner reported the 1.1.2.4 runs green on 2026-10-18. Do not add a twelfth. No agent or AI runs a workflow. The owner runs every workflow. A run that is already going may be watched, and the code fixed from its log. Do not start, rerun, or cancel one. Do not pull a pull request into `main`. The owner merges. Do not edit those files to tidy them. If the owner asks for a change there, ask once more and edit only after a second yes or ok. If other work cannot finish without a change there, make the smallest change, read the effect on every workflow that shares that behaviour, and fix every error that change causes in the same change. The rule is [AGENTS.md](AGENTS.md) → Actions, pull, and merge, and → GitHub workflows stay locked.
- Windows CMD pack (`scripts\build-windows.cmd` / `npm run build:win`), NSIS Setup and Portable, install, boot, open, uninstall, and reinstall of public line 1.1.2.4 were owner-verified on 2026-10-18. This branch is unverified until the owner re-checks. Do not wrap `build:win` for Linux. Do not invent a second pack or installer.
- `electron-builder.yml`: `perMachine: false`, `signExecutable: false`, `nsis.deleteAppDataOnUninstall: false`.
- TEST uses `dev.friday.desk.test` so it can sit beside Official.
- Assistants never bump `config/friday-version.json` by hand. From public `1.1.2.4`, patch is `1.1.2.5`, minor is `1.1.3.4`, major is `1.2.2.4`, and extreme is `2.1.2.4`. `mode` auto with `release_type` auto does not invent a number. `stage` publish with `mode` auto publishes an unpublished line once and stops once that GitHub release exists. `mode` rebuild is the only path that replaces those assets. An explicit patch, minor, major, or extreme moves that one counter, including when the line has never been published. A stable git tag and a GitHub release both consume a number. `release_type` auto on an update chooses patch, minor, or major and never extreme. `revision` is a rebuild of the same version. The release workflow applies the number and heals the docs.
- Session `media` is allowed at Chromium so Windows can show its own privacy prompt. It is not a silent skip of that prompt.
- Connectors publish on the companion `live` object (`knownConnectors()`), not as `capabilityRegistry` resource rows.

## Known gaps (honest)

- Owner's 2026-10-22 Self-Management report: "58 issues, 23 critical". The critical items were optional add-ons and unprobed toolchain packs.
  - Graphviz, D2, comtypes, and the llama.cpp rows were hardcoded Missing. Install Manager rows ended with a "key, driver, account" line.
  - The platform read "browser" in the desktop app.
  - The 165 "broken imports" were imports inside generated-script template strings, Vite `?url` and `?inline` suffixes, and test fixtures. This checkout now indexes with 0 broken.
  - On the owner's folder (4749 files) the new count is unverified until a rescan after rebuilding.

- Owner's 2026-10-22 Doctor report (installed app v1.1.2.4) was mostly false alarms, now fixed on this branch:
  - 382 "errors" were uvicorn `INFO:` lines.
  - "No outbound connection" and Gemini/OpenRouter "fetch failed" came from Node's fetch and a 2.5 s single-host ping, while chat answered through OpenRouter.
  - The CSP warnings were the status bar network meter's own hosts.
  - Bundled packs read Missing although they are an unextracted fallback.
  - The 12 voice warnings were never given results.
  - A single event-loop lag stayed a Warning for the whole session.
  - Whether Gemini and OpenRouter probes pass through Chromium on that PC is unverified until the owner rescans after rebuilding.
  - PowerShell 7 and Tesseract OCR are really not installed (Install Manager). The speaker-match file stays optional.

- Owner's 2026-10-22 voice test: 21 of 22 live utterances were dropped as `vad kept 0 ms`, because the PCM ring held 600 ms and each segment was its trailing silence. The ring now holds 30 s, and a test pins a 5 s utterance. The self-tests now use the live model folder. Prompt echoes are dropped. The turn trace names why a heard line was not routed. Chat answers voice questions from the live session, and the Voice Agent role match is a skip. All of this ran on Linux tests only. Live hearing on the owner's microphone is unverified until step 0 below runs.

- Release `v1.1.3.4` was prepared and merged into `main` on 2026-10-22 and is not published. FRIDAY Release run 39794578719 failed in publish, Prepare the build environment: the runner's Python 3.15 had no ctranslate2 wheel. Setup and the installer helper now prefer the newest installed series at or below `pythonWheelProven` (3.14) and take a newer series once a pip dry run proves its kernel wheels. The local `npm run build:win` stop at `stt-self-test failed (1)` was the embeddable Python not finding `voice_runtime`; `kernel/stt.py` now adds its own folder. A hosted FRIDAY Release, a Windows CMD pack, and the installer helper on Windows are unverified until the owner runs them. The release pull request's own PR Validation `startup_failure` (actor `github-actions[bot]`) is expected and documented.

- Push-to-talk, the ComfyUI client and image tool, the meant-for-me work mentions, and the new document formats are tested on Linux (unit tests, a fake ComfyUI HTTP server, ZIP fixtures built in the test). The global shortcut, a real microphone, and a real ComfyUI install on Windows are unverified.

- The readiness run above had no Whisper weights (VOICE reports a visible skip) and no cloud keys (CHAT used the fake local runner). Real provider calls, real speech, and Windows runner installs through the Install Manager (winget, direct download) are unverified here.
- Not audited in this pass: PC-control tools against a real Windows desktop, web-search ladder against the live web, and each cloud provider's live list and chat. They need the owner's PC and keys.

- Hearing: denoise scale was already fixed on `main`; this change added the single clip, the 4x loudness guard, one no-speech constant with the confidence rule, drop codes and counters, and the spoken self-test. Whether those fix the owner's silent mic on real speech is unverified until step 0.1 runs on Windows.
- Pricing: proven-free models now outlive the 14-day table age. Risk accepted by the owner direction: a provider that moves a model from free to paid is caught by the daily refresh, a live probe, or a billing-required error, not by age. The old `pricing:status` EXPIRED exit still reports source age and still exits 1 for an old source.
- The per-model free, unknown, or paid reason is shown per pricing source on the Models page, not as a line under every model row.
- Provider fixtures in `core/fixtures/provider-model-lists.json` are list shapes written from each provider's docs, not live recordings.

- Live provider calls are unverified. A cloud failure keeps the HTTP status and a redacted body. OpenRouter's data-policy 404 is an account setting (`https://openrouter.ai/settings/privacy`). `npm run models:check --live` was not run. No owner keys are in this environment.
- A live Windows speech download, microphone, Windows speech pack, and Shutdown or Restart on the packaged EXE are unverified. `hf-mirror.com` is off unless `FRIDAY_HF_MIRROR=1`.
- This branch's Windows CMD pack, readiness RESTART, installer, and in-app update apply are unverified. The owner's 1.1.2.4 pack is the verified line. Silent uninstall keeps the data folder. The get-pip pin read from bootstrap.pypa.io on 2026-10-21 (2234489 bytes) is on main. Hosted Actions for this branch were not started.
- Local models: an Ollama tag list and an LM Studio OpenAI list become ready chat routes. A native LM Studio row that is not loaded stays visible as `model not loaded in LM Studio` and is not routed. Embedding names are not chosen to answer. A live Ollama or LM Studio process was not running here.
- Official free cloud evidence is allowed while verification is still `UNVERIFIED`. That includes a zero OpenRouter catalogue price and `openrouter/free`. The kernel previously required `VERIFIED`, so the same record was blocked. A stale price, a paid price, and a cost that is still unknown stay blocked with paid access off. The chat selector puts `openrouter/free` and a priced `:free` id in a Free group. A `:free` name without a price stays unknown. Live OpenRouter calls were not run. OpenRouter's model list and free-router pages were read on 2026-10-22.
- Hearing: the empty Auto transcript after av 18 was confirmed on this machine. pyrnnoise 0.4.5 returns int16 frames (a 0.2 sine came back with peak 6846). `denoise_pcm` now scales those frames to [-1, 1] and drops a denoise result that collapses speech-level energy. An empty pass above -50 dBFS retries without VAD and the prompt, then on the original audio. Segment text is kept when no-speech is high. Voice diagnostics can run a 3 second mic test and a speak test, and can keep the last five WAVs. The self-test still skips when speech weights are absent. A Windows microphone, a spoken command, Windows speech, and CUDA were not run. Missing Supertonic, Silero, and smart-turn read `optional - not installed`. The speaker file still has no pinned checksum, so it is not downloaded. The PyAV pin `av>=17.0.0,<19` stays.
- Readiness no longer reads the recorded FRIDAY folder. The default root is a new temp directory, with its own userData and a free kernel port (`FRIDAY_KERNEL_PORT`, default 8765 when that port is free). `--use-recorded-root` is the only way back, and it refuses a live app on 8765. A checkout (`package.json` name `friday` plus `.git`) warns once and points at the existing Copy my data path, which copies, checks file counts, and does not delete. Root runtime folders in `scripts/friday-root.cjs` `RUNTIME_FOLDERS` are gitignored. A Windows run with the installed app in the tray is unverified.
- Voice smoothness, addressing quality, and flicker on a real GPU are unverified. The checks are in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md) under Voice smoothness and Live listening.
- Each provider catalogue is a JSON file under the cache `model-catalogue` folder. Startup loads those files before a network refresh. A refresh runs when a file is missing or older than 24 hours, on Refresh now, after a model 404, and after sleep once that age has passed. Privacy mode and a local-only route keep the disk copy and mark it stale. The light tick only notes expired cooldowns and does not call a models endpoint. Zero-spend probes run with the 24 hour refresh. Live catalogue refresh was not run. `npm run models:check --live` was not run. No owner keys are in this environment. Groq, Gemini, OpenRouter, Hugging Face, OpenAI, NVIDIA, Ollama, and LM Studio docs were re-read on 2026-10-21 for list shape and protocol. Price pages for Groq, Gemini, Z.ai, OpenAI, Anthropic, Perplexity, Mistral, and NVIDIA were re-read the same day and those `checkedAt` values moved to 2026-10-21. `glm-4.6v-flash` is free on that Z.ai table. DeepSeek's pricing URL returned the quick-start article, so that date stays 2026-10-07.
- `src/routeTree.gen.ts` uses one footer (`scripts/route-tree-footer.cjs`). The 2026-10-21 `build:desktop` left that file unchanged.
- The default pack stays unsigned (`signExecutable: false`). SmartScreen may warn on the owner's PC.
- chromadb 1.5.9 has four advisories and no published fix, so it stays. Eight pricing sources were re-read on 2026-10-21 and their dates moved. DeepSeek stays 2026-10-07 because that URL did not contain a price table, so `npm run pricing:status` can still report EXPIRED on that one source. A stale model is unverified, not billed as paid. Assistant-authored commits that are already on `main` were not rewritten.
- The Doctor catalogue row reports freshness and does not rewrite `fetchedAt`. `staggerPlan` and conditional request headers are helpers with tests. The live refresh is still one `refreshRoutable` fan-out.
- `package.json` and the lock already pin Vite 8.3.5. This change did not bump it again. The owner-verified comparison in the build doc still records Vite 8.3.2 from 2026-10-17. That comparison is not a new floor.
- `kernel/router.py` and `electron/model-router.cjs` kept their names. The flow registry, tests, and docs pin those paths. Existing duplicate basenames stay on the allowlist in `core/__tests__/duplicate-stems.test.ts`. A new duplicate basename fails that test.

## Next priorities

0. Voice re-test on the Windows PC after this branch: Auto mode, hands-free on, say "Friday, what time is it". The voice pipeline log should show a segment longer than 600 ms and a transcript. Voice diagnostics should show `heard` rising and the hearing levels as PASS, or `misheard` with the recogniser name. In chat, "voice me baat kyu nahi ho rahi?" should return the live voice report.
0. Owner checks for push-to-talk and ComfyUI, on the Windows PC after `npm run setup` and `npm run build:win`:
   1. Voice settings, How Auto mode listens: Push to talk. In Auto mode, talk without the key: nothing is transcribed and the voice log says `push-to-talk: talk key is up`. Hold Ctrl+Space and say "Friday, what time is it", or just "what time is it": FRIDAY answers without the wake word.
   2. With FRIDAY in the background, press Ctrl+Alt+Space, speak, press it again. Switch back to Always listening: the shortcut is released (another app can use it).
   3. Install and start ComfyUI yourself, then Models, Local, ComfyUI: Check shows its version; paste a Save (API) workflow and Run; the images land in `assets\comfyui`. Then enable the ComfyUI image tool in Tools and ask in chat: "make an image of a red fox in the snow".
   4. Voice settings: Respond to anything meant for me. After FRIDAY finishes a task, say something about that task without her name: she answers. Unrelated chatter stays ambient.
   5. Attach a .pptx, .odt, .epub, .rtf, and .eml in chat and ask for a summary.
   6. Talk to FRIDAY normally for a few turns, then once in a clearly stressed or raised voice. Voice diagnostics, voice tone: it should read `tense` or `energetic` and her spoken reply should soften. It reads `still learning this voice` for the first five utterances.
   Not built yet, from the research: agent work on an isolated virtual desktop (UFO2 style) so FRIDAY and the owner can use the PC at the same time, full-duplex voice (listen while speaking, beyond today's barge-in) and a Windows key-up hook for a global hold-to-talk (Electron's global shortcut reports no release; a native keyboard hook would change the EXE pack, a locked area). OmniVoice was rejected (torch and voice cloning).

0. Owner checks for this change, on the Windows PC after `npm run setup` and `npm run build:win`:
   1. Voice diagnostics, run voice self-test: three `hearing at peak 0.5 / 0.05 / 0.008` rows must read PASS. Send any FAIL row and the newest `debug\reports\voice-hearing.jsonl`.
   2. In Auto mode say "Friday, what time is it". Confirm it answers aloud. If not, copy the `last turn` row (heard, routed, model, reply, spoken) from Voice diagnostics: the stage marked with a cross is where it stopped. Run speak test and note which engine it names.
   3. Models, Local: start Ollama or LM Studio with the Start button (second click confirms), then confirm the model line says `serving` and the next chat uses it.
   4. Models, Catalogue: press Refresh now. Each pricing source shows its basis and `read Nh ago` or `cached`. Turn Wi-Fi off and press it again: sources stay `cached` and proven-free models stay free.
   5. Open a chat with every model blocked (Paid-only with paid access off) and confirm the reply and the spoken line name the real reason.

Owner checks stay in order. A failed step should be reported with the step number and the on-screen text.

1. On the Windows PC after `npm run setup` and `npm run build:win`:
   1. Ask a long question to a slow free model and to a big local model. The answer arrives, and the screen does not say `ipc timed out` at 30 seconds.
   2. First-run speech model install shows progress for several minutes without an error.
   3. Make the UI busy or freeze it (open a huge page in Browser) and see the recovery message.
   4. Turn the speech model off or delete it. She falls back to Moonshine or Windows speech by herself.
   5. Models: a dead model is marked before use.
   6. PR Validation, Test Build and Release once more.
   Any failing step: send the step number, the on-screen text and the newest `debug\reports\*` file.
   These stay unverified until that PC runs them: live microphone hearing, Shutdown and Restart leaving no FRIDAY, python, or helper process, and an OpenRouter reconnect with the privacy setting.
2. MCP, on that PC, in order. If a step fails, send the on-screen error and the step number.
   1. Open FRIDAY, open Connectors, and turn the MCP server on. Copy the install secret when it is shown.
   2. Pick Cursor or Claude Desktop. Copy the snippet, or use Write it for me. Quit that app fully and open it again.
   3. When FRIDAY shows a pairing code, approve it with read. Paste the token if the snippet still has the placeholder.
   4. In the other app, list FRIDAY's tools. Confirm `friday.ask` is present and `kernel.shell.cmd` is absent.
   5. Ask one question. Confirm the answer is text and FRIDAY does not speak.
   6. Ask for a web search. Confirm the result is marked as data.
   7. Ask it to write a file. Approve once, then deny a second write.
   8. Revoke the client, then turn the MCP server off. The other app should fail the next call with a clear error.
3. Report-only Content-Security-Policy is on. Enforcing mode is an owner decision (`FRIDAY_CSP_ENFORCE=1`) after a real Windows run. Do not turn it on from this tree.
4. `npm run test:fast` uses the diff against `origin/main`, then a fast core subset when Vitest finds no related files. `npm test` is still the full suite.
5. The desktop route tree writes the same Start footer as the web plugin. After `npm run build:desktop` or `npm run build:win`, `git status` must be clean.
6. Owner decision. recharts stays on 2.x. A 3.x migration is a UI change and was not done. `core/__tests__/project-governance.test.ts` pins `dependencies.recharts` to `^2.`. The migration notes stay here: `CategoricalChartState` is gone, `Customized` no longer receives internal state, internal props such as `activeIndex` were removed, `ResponsiveContainer` `ref.current.current` is gone, and `accessibilityLayer` is on by default. The only import is `src/components/ui/chart.tsx`.
7. Waiting on a parent. `tsconfck` 3.1.6 is required by `vite-tsconfig-paths` 6.1.1. `rcedit` 5.0.2 is still imported by `scripts/brand-windows.cjs`. No override. Detail: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).
8. AppShell stays one chunk. Splitting `src/components/friday/AppShell.tsx` was not done. This Linux `build:desktop` on 2026-10-21 wrote `AppShell-DM14ks4s.js` at 3,673.94 kB (gzip 1,310.31 kB). In-process `/health` was not re-measured on this run. Click latency and idle CPU on the Windows EXE were not measured.
9. Finding, not a change. A constraints file that pins Node, npm, Python, and PowerShell would fight the `>=` floors. The known-good line is in the build doc.
10. faster-whisper uses CUDA float16 only when the GPU flag is set and cuBLAS plus cuDNN 9 are on PATH. Otherwise it stays on CPU int8. A failed CUDA load falls back the same way. A Windows GPU run is unverified.
11. Owner decision. An offline Hindi voice is not bundled. Supertonic 3 F2 speaks Hindi when it is installed.
12. Embeddings and speech are not a chat route. `baseRouting()` still leaves rerank empty.
13. A local catalog row is not installed until a scan has run, or an install job finishes. A scanned local provider clears a row that is no longer present. The browser preview has no scan, so the brain still treats a catalog version as reachable there. The Models page does not.
14. Groq's public models page, re-read 2026-10-21, still has no free-id list. Models shows that. The owner can mark any provider's unverified model free. A published paid price stays paid until that mark. A stale snapshot asks for a refresh and does not present itself as a bill.
15. Owner decision. Shutdown does not change start-at-login. Restart and shutdown from voice still use the approval card. Full autonomy does not skip those two tools.
16. Owner decision. Do not bundle a speech model in the installer until the owner asks. Published Hub sizes, not measured here: tiny `model.bin` 75.5 MB, base `model.bin` 145 MB, plus about 2.7 MB of tokenizer and vocabulary.
17. Owner decision. `hf-mirror.com` stays opt-in through `FRIDAY_HF_MIRROR=1`. There is no settings switch for it.
18. Owner decision. An unknown model is not used automatically. `spendCapUsd` on that model is what allows it, under the billing firewall. Strict privacy stays off unless the owner turns it on.
19. Owner decision. [CHANGELOG.md](CHANGELOG.md) and `releases/notes/` were not trimmed.
20. No product file was deleted in this pass. `node scripts/audit-architecture.cjs --strict` exits 0 and still prints REVIEW lines for same-name files and for files with no static importer, including `electron/preload.cjs`. Those stay. A file is removed only after grep shows that no test, doc registry, workflow, package script, or runtime path needs it.
21. Provider catalogue, on the Windows PC after `npm run setup` and `npm run build:win`, with real keys. Live calls from this tree were not run.
   1. For each provider with a key: Connect, Test connection, Refresh now. Models show context, modalities, pricing, and free, unknown, or paid with evidence. The status matrix says what is verified.
   2. Close and reopen with Wi-Fi off. The catalogue loads from disk and is labelled stale when it is older than 24 hours. Reopen with Wi-Fi on. A refresh runs only when the file is older than 24 hours. The Doctor row reports that age and does not change it. Refresh now runs immediately. The interval path waits up to 60 seconds, then one catalogue refresh runs. Per-provider stagger is not wired into that fetch.
   3. Hugging Face cloud: set the token, pick a model with a routing suffix, and chat. Hugging Face local: search a small GGUF, download, pause, resume, restart mid-way, install into Ollama or LM Studio, load it, and chat.
   4. The same request in Chat and in Voice shows the same lane, model, and reason in the Doctor. The decision trace names the catalogue record and the evidence level.
   5. A simulated free-quota end moves to another free model and never to a paid one. Paid stays off. Privacy mode makes no cloud call and no catalogue refresh.
   6. Run `npm run models:check -- --live` once and send the redacted report from `debug\reports`.
   Any failing step: send the step number, the on-screen text, and the newest `debug\reports\*` file.

## Owner decisions

- Content-Security-Policy enforcement: not turned on. Report-only is the shipped mode.
- Bundling a speech model in the installer: not done. Size note is priority 16.
- `hf-mirror.com`: environment opt-in only.
- Unknown-model spend cap: off until `spendCapUsd` is set on that model.
- Strict privacy: off.
- Changelog and release notes: left untouched.
- recharts 3: not started.
- Coverage-expansion providers were not added. The list is `electron/provider-coverage.cjs`.
- Pinned router filenames stayed: `kernel/router.py` and `electron/model-router.cjs`.
- Pricing fails closed on no proof, not on age. Eight sources moved to 2026-10-21 after a real page read. DeepSeek stayed 2026-10-07 because that page had no price table. The date was not typed in by hand.
- Vite is already 8.3.5 in `package.json` and the lock. This change did not bump it. The 2026-10-17 owner-verified line still names 8.3.2.
