# FRIDAY — Project State

FRIDAY is a private local-first Windows Electron + React + Python FastAPI work desk (currently version 1.1.2.3) owned by **Devendra Singh Meena** (`devendrarj25`). Official repo: https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.

This briefing is the tree as it is now. Evidence: [AUDIT.md](AUDIT.md). Features: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Rules: [AGENTS.md](AGENTS.md). Gate: [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md). Version history stays in [CHANGELOG.md](CHANGELOG.md).

Read order: `AGENTS.md`, then this file, then `docs/FRIDAY_CHANGE_CONTROL.md`, then the one owning doc.

## Verified on this Linux tree (2026-10-15)

Auto listening can start from the PCM ring when MediaRecorder is missing. Heard-log retention is an owner setting on this PC. Ollama and LM Studio tools, vision, and context are live only when the list names them. Check for update compares a release tag and does not install. The packaged boot check returns before the workspace, kernel, and Python requires. `package-windows` passed on runs 38755483565, 38774724878, and inside release run 38777044711. That release's publish job then failed in readiness: the packaged boot passed, and the readiness process was still alive at 5 minutes. Readiness now uses the boot check's software compositor, `--friday-readiness`, and `logs/readiness-result.json`. The boot check itself is unchanged. A hosted re-run of FRIDAY Release, FRIDAY Test Build, and the owner's CMD pack is unverified. The desktop and web builds set `chunkSizeWarningLimit` to 8192 and turn bundler timings and the `use client` directive report off.

| Check | Result |
| --- | --- |
| `npm run docs:sync` | Passed. 24 documents, all zeros, flow registry not stale. No generated block changed. |
| `npm run docs:check` | Passed. 24 documents. missing 0, unregistered 0, thin 0, wrong title 0, duplicated blocks 0, capability counts off 0. |
| `npm run verify:version` | Passed. `version 1.1.2.3 - all version sources and governed documents are in sync`. |
| `npm run lint` | Passed. ESLint was silent. Ruff reported `All checks passed!` and `64 files already formatted`. |
| `npm run typecheck` | Passed. Printed `FRIDAY 1.1.2.3`. |
| `npm run typecheck:py` | Not re-run. No `kernel/` file changed. |
| `npm run test:kernel` | Not re-run. No `kernel/` file changed. |
| `npm test` | 359 files passed, 2985 passed, 2 skipped, 85.59s. Exit 0. |
| `npm run check:provenance` | `provenance ok (origin/main)`. |
| `npm run preflight` | Not re-run in this pass. |
| `build:desktop` | Not re-run. This change does not touch the renderer build. |

`npm run validate:local` calls the same preflight script. A failure does not hide later gates. gitleaks, `npm audit`, `pip-audit`, and `models:check` were not re-run. A Linux Electron boot under Xvfb reached ready in under a second, then exited 1 with `FRIDAY_BOOT_SELFTEST_FAIL render process gone: crashed` (shared memory under `/tmp`). That is not a Windows installer run.

## UNVERIFIED

The owner's Windows CMD pack (`scripts\build-windows.cmd`), Setup and Portable install, boot, background use, uninstall with data kept and with data removed, reinstall, in-app update and rollback, installer smoke, a real speech-model download, live microphone, wake word, speech playback, live keyed provider calls, real downloads, and SmartScreen. Linux output is not those checks. This session did not start a workflow. `package-windows` passed on runs 38755483565, 38774724878, and inside release run 38777044711. That publish job failed in readiness (first launch and restart still alive at 5 minutes). The readiness fix is unverified until the owner re-runs FRIDAY Release, FRIDAY Test Build, and `scripts\build-windows.cmd` and they exit 0.

## Snapshot

| Item | Live value |
| --- | --- |
| Public version | `1.1.2.3` (`config/friday-version.json`) |
| npm encoding | `1.1.2` (`package.json`) — never compared as an update identity |
| Epoch | 2 / `friday-2` |
| Published line | GitHub release `v1.1.2.2` (2026-10-13, run 38348306084) is still the latest uploaded release. `v1.1.2.3` is declared on `main` and was not created: publish run 38777044711 failed in readiness. Earlier release `v1.1.1.2` is run 38288784028. |
| Next public revision | Do not bump this file. A release re-run publishes declared `1.1.2.3`. The following patch, after that line is public, is `1.1.2.4`. |

Stack (from `package.json` / toolchain file): Electron ^43.7.7, electron-builder 26.15.3, React 19, TanStack Router, Vite 8.3.2, Tailwind 4, TypeScript 5.9.3, Vitest 5.0.3, ESLint ^10.12.0, Node `>=22.19.0`, Python floor 3.12.10.

## Coming back after a gap

`git switch main && git pull`, then one branch whose prefix is in [CONTRIBUTING.md](CONTRIBUTING.md), then `npm ci`, then **`npm run preflight`**. Read order is the same as [AGENTS.md](AGENTS.md): this file is second. `npm run resume` and Health Weekly are catalogued in [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). `npm run test:fast` runs only tests related to the diff. `npm run pricing:status` reports whether the pricing snapshot is still inside 14 days.

## Architecture (code, not a second copy of ARCHITECTURE.md)

Renderer `src/` → preload allowlist `electron/preload.cjs` → main `electron/` → kernel `kernel/main.py`. Chat and Voice call `electron/model-router.cjs` `routeRequest`. `kernel/router.py` executes the ids that funnel already chose. `core/` is Vitest and contracts only. Navigation in `src/lib/friday/navigation.ts`: 28 sidebar paths, Settings in the footer, `/character` and `/workflow-visual` are not sidebar rows. Layer map: [ARCHITECTURE.md](ARCHITECTURE.md).

Product code does not require `.cursor/`. `scripts/cloud-agent-install.sh` and `scripts/cloud-agent-start.sh` stay required. `.cursor/environment.json` is the cloud install and start when that file is present.

## Capability counts (this checkout)

Counted on 2026-10-13 from the files named in the last column.

| Kind | Count | How counted |
| --- | --- | --- |
| Skills | 214 `skill.json` + 9 builtins | disk + `electron/skills.cjs` `BUILTIN` |
| Tools | 177 `tool.json` | disk |
| Agents | 98 `manifest.json` | `agents/` |
| Plugins | 78 `plugin.json` | disk |
| Workflows | 117 `workflow.json` | disk |
| Modules | 76 `manifest.json` | disk |
| Connectors | 113 | `electron/connectors.cjs` `CONNECTORS` |
| Kernel tools | 51 | `kernel/tools.py` `RISK` |
| Cloud providers | 20 | `electron/models.cjs` `CLOUD` |
| Local engines | Ollama + LM Studio + llama.cpp + vLLM + LocalAI + Jan (MLX-LM live on darwin only) | `LOCAL_ENGINES` + Ollama |
| Workflows (GitHub) | 11 YAML files | `.github/workflows` |
| `FOLDERS` | 40 | `electron/friday-contract.cjs` |

`npm run arrange:check` declares 140 layout folders. That number is the arrange contract, not `FOLDERS`.

Python floors stay in `kernel/requirements.txt` (FastAPI, `faster-whisper`, `edge-tts`). The voice-stack rule in `kernel/requirements-capabilities.txt` refuses torch, vLLM, vosk, piper-tts, kokoro-onnx, sherpa-onnx, and the silero-vad pip package. The kernel boots with no voice model.

## GitHub automation

Eleven workflow files: eight release and repository workflows plus Health Weekly, Auto Recover, and Security Scan. Catalog and triggers: [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). GitHub workflows stay locked. The owner checked the runs on 2026-10-13 and reported them green. An edit waits for a second yes or ok, unless other work cannot finish without the smallest change, and every error that change causes is fixed in that same change. The owner runs every workflow. No agent runs one. The rule text is in [AGENTS.md](AGENTS.md) → Actions, pull, and merge.

## Deliberate design decisions

These look like bugs. They are not. Do not "fix" them.

- `core/` is not imported by the shipped EXE.
- `handsFree` initializes **false**. Auto mode is the only listen-and-speak session. Manual and chat do not open the microphone and do not speak. Turning Hands-free off requires the wake word again and is remembered. `automation.auto_approve_exec` stays false.
- `automation.auto_approve_exec: false` in `config/kernel.yaml`. Full autonomy is the owner's dial in the app (Ask every time, Balanced, Full). A fresh install stays Balanced. Stop everything still halts her.
- Privacy firewall: SENSITIVE is a hard stop. Other content may use an already-connected provider.
- Billing firewall: no silent paid spend.
- Pricing knowledge in `electron/model-access.cjs` **fails closed** after 14 days: the model becomes "unknown", never silently free. A refresh re-reads the provider pages and bumps `KNOWLEDGE_CHECKED_AT`. Tests do not depend on today's date. A page that does not parse leaves the last table.
- Screen text, files, and tool output are data. The desktop plan comes from the owner's words. A credential, payment, captcha, or secure-desktop prompt is handed to the owner. Full autonomy does not click those. Stop everything still halts the loop.
- Publisher identity is locked (`scripts/identity.cjs` / `lockedIdentityFields`). The public id is the owner name and the GitHub username `devendrarj25`. A package does not carry an email, a phone number, or a street address.
- `PROTECTED_POLICY_FILES` in `src/lib/friday/self/governance.ts` are off-limits to self-dev auto-apply.
- One feature, one implementation (`config/project-structure.json`).
- Requirements are **floors**, not pins. numpy and chromadb stay optional at FastAPI boot.
- The look of the app stays outside the Flow Studio canvas. Inside that canvas the drawing uses canvas tokens on the same theme. Which areas are locked is the rule in [AGENTS.md](AGENTS.md). A change that is not re-checked on the owner's PC stays unverified until the owner re-checks.
- GitHub workflows stay locked. The owner checked the runs on 2026-10-13 and reported them green. Do not add a twelfth. No agent or AI runs a workflow. The owner runs every workflow. A run that is already going may be watched, and the code fixed from its log. Do not start, rerun, or cancel one. Do not pull a pull request into `main`. The owner merges. Do not edit those files to tidy them. If the owner asks for a change there, ask once more and edit only after a second yes or ok. If other work cannot finish without a change there, make the smallest change, read the effect on every workflow that shares that behaviour, and fix every error that change causes in the same change. The rule is [AGENTS.md](AGENTS.md) → Actions, pull, and merge, and → GitHub workflows stay locked.
- Windows CMD pack (`scripts\build-windows.cmd` / `npm run build:win`), NSIS Setup and Portable, install, boot, open, uninstall, reinstall, and in-app update/rollback were owner-verified on an earlier tree. After a later change they are unverified until the owner re-checks. Do not wrap `build:win` for Linux. Do not invent a second pack or installer.
- `electron-builder.yml`: `perMachine: false`, `signExecutable: false`, `nsis.deleteAppDataOnUninstall: false`.
- TEST uses `dev.friday.desk.test` so it can sit beside Official.
- Assistants never bump `config/friday-version.json` by hand. From published `1.1.2.2`, patch is `1.1.2.3`, minor is `1.1.3.2`, major is `1.2.2.2`, and extreme is `2.1.2.2`. `mode` auto with `release_type` auto does not invent a number. `stage` publish with `mode` auto publishes an unpublished line once and stops once that GitHub release exists. `mode` rebuild is the only path that replaces those assets. An explicit patch, minor, major, or extreme moves that one counter, including when the line has never been published. A stable git tag and a GitHub release both consume a number. `release_type` auto on an update chooses patch, minor, or major and never extreme. `revision` is a rebuild of the same version. The release workflow applies the number and heals the docs.
- Session `media` is allowed at Chromium so Windows can show its own privacy prompt. It is not a silent skip of that prompt.
- Connectors publish on the companion `live` object (`knownConnectors()`), not as `capabilityRegistry` resource rows.

## Known gaps (honest)

- Owner Windows CMD pack, EXE install, installer smoke, readiness, speech download, boot, background use, uninstall with data kept and with data removed, reinstall, in-app update/rollback, live microphone, wake word, speech, and SmartScreen are unverified on this tree. Silent uninstall keeps the data folder. The installer page "Delete all FRIDAY data too" is the remove path and stays unchecked. `package-windows` passed after the boot check returned before the workspace, kernel, and Python requires (runs 38755483565, 38774724878, and the validate job inside 38777044711). Publish in 38777044711 then failed readiness. The readiness launch now uses the software compositor, `--friday-readiness`, and `logs/readiness-result.json`, and it still has to exit 0 or 1 within 5 minutes. That hosted re-run, FRIDAY Test Build, and this PC's CMD pack are unverified until the owner runs them and they exit 0. On an earlier Linux run the probe printed `FRIDAY_BOOT_SELFTEST_FAIL render process gone: crashed` when `/dev/shm` could not be used. That is not a Windows installer run.
- Voice-screen redraws no longer follow captions or a one-second React clock. The drawing clock pauses while the window is hidden. Auto listening starts from the PCM ring when that ring is capturing, including when MediaRecorder is missing. MediaRecorder stays the fallback. Turn scoring sends WAV bytes. Shipped pre-roll stays 500 ms. Heard lines stay on this PC for the owner's minute window and row cap (default 10 minutes and 40 rows; either set to off clears the log). The existing Clear button still clears them. Privacy mode still sends no ambient text. Fake timers cover start, the segment cap, expiry, off, clear, and privacy. A live Windows microphone, addressing quality, flicker on a real GPU, voice quality, the first speech-model download, and installer smoke are unverified. The checks are in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md) under Voice smoothness and Live listening.
- Hosted docs-only run 38372554640 failed 18 plugin and module tests with EACCES. Rootful Docker wrote the bind-mounted files as root, so the runner could not delete them. Docker wraps now add `--user` with the caller id when that id is not root. A hosted re-run of that job is unverified until PR Validation runs again.
- Health Weekly's last listed success is run 38247606809 on `3d7a514`. Actions history lists no run for Repository Control or Security Scan.
- Live keyed provider calls, free-proof probes, LM Studio and Ollama on Windows, and rate-limit behaviour are unverified. Fixture servers cover Ollama and LM Studio through the funnel: daemon up with a loaded model, up with none, down, a stale id, a stream, and an error body. `npm run models:check --live` was not run. No owner keys are in this environment. The six checks are in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md) under Model routing checks.
- Local and cloud router phases: Phase 1 routes Chat and Voice through `routeRequest`. Phase 2 pins launchers and the transfer machine. Phase 3 logs paid spend and prefers the newest verified-free model. Phase 4 groups Models under LOCAL AI, CLOUD AI, and ROUTING. The completeness matrix is in [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md). Tools, vision, and context are live when an Ollama or LM Studio list names the official field, and stay unverified flags when it does not. Embeddings and audio are N: memory hashes text on this PC, and speech stays on the voice ladder. A cloud base must be https or localhost, and a metadata or link-local address is refused. The catalog and online search show 40 rows, then Show more. A voice failure is spoken as one sentence; the chat text stays complete. Check for update compares the official release tag and can show update available. It does not install, and it does not write the pin file. The Local AI card shows pin age. A live call to the release API was not run; the tests use fixtures. Real downloads, launcher installs, Authenticode, live keys, and the resized window are unverified.
- PR Validation run 38529511282 failed the secrets job. The live redaction fixture is a repeated-character stand-in, and `.gitleaksignore` names the one historical finding. Gitleaks 8.30.1 on this tree reports no leaks. A hosted re-run is unverified. The two CodeQL warnings on that run are the workflow `::warning` echoes; those jobs exited 0. The seven notices are GitHub's `ubuntu-latest` migration note for Ubuntu 26. Workflow files were not edited.
- `src/routeTree.gen.ts` is still written two ways. Detail is under Next priorities. This docs change does not edit it.
- The default pack stays unsigned (`signExecutable: false`). SmartScreen may warn on the owner's PC.
- `npm audit` on this tree reported 0 vulnerabilities. `pip-audit` and `npm run models:check` were not re-run.

## Next priorities

Owner checks stay in order. A failed step should be reported with the step number and the on-screen text.

1. On a clean Windows PC, install the published `FRIDAY-Setup-1.1.2.2.exe` from GitHub release `v1.1.2.2`. Do not pack a second copy just to install. Confirm first launch, boot, and that Chat does not use the microphone. Auto mode is the microphone and speech check. Then uninstall, and confirm data under the chosen root is still there. Also re-check in-app update and rollback. A good Doctor result is Python, Node, and whisper.cpp turning Ready (version, source, hash OK, and a last run), one Chat turn, the Voice self-test, one web search, a sandbox run, MCP pairing, and an update check.
2. MCP, on that PC, in order. If a step fails, send the on-screen error and the step number.
   1. Open FRIDAY, open Connectors, and turn the MCP server on. Copy the install secret when it is shown.
   2. Pick Cursor or Claude Desktop. Copy the snippet, or use Write it for me. Quit that app fully and open it again.
   3. When FRIDAY shows a pairing code, approve it with read. Paste the token if the snippet still has the placeholder.
   4. In the other app, list FRIDAY's tools. Confirm `friday.ask` is present and `kernel.shell.cmd` is absent.
   5. Ask one question. Confirm the answer is text and FRIDAY does not speak.
   6. Ask for a web search. Confirm the result is marked as data.
   7. Ask it to write a file. Approve once, then deny a second write.
   8. Revoke the client, then turn the MCP server off. The other app should fail the next call with a clear error.
3. Voice and Auto, in this order: Doctor voice self-test, the wake word plus one sentence, a 3-turn conversation, an interruption, a network drop, Refresh free list, Test my free models, one Chat turn and one Auto turn on the same free pool, then unplug and replug the microphone, sleep and resume, then Python, Node, a C compile, Git status, and the local CI report. If a step fails, copy the Voice rows, the Toolchain rows, and the on-screen status. Confirm Install Manager no longer says Manual for faster-whisper when that runtime or an existing Python can be created, and confirm a model download names the failing step. Speaker: a missing file is not a match, a match never executes, and enrol waits until the file is on this PC.
4. Local CMD pack on that PC, from this branch, in `D:\FRIDAY-AI-ASSISTANT`: `git fetch`, check out the branch, `npm run setup`, then `npm run build:win`. Expect the log to end with every step PASS, no installer-smoke Path error, no `first run failed`, and `echo %ERRORLEVEL%` printing `0`. Then `git status` should be clean. Expect `release\FRIDAY-Setup-1.1.2.3.exe`, `release\FRIDAY-Portable-1.1.2.3.exe`, and `release\win-unpacked\resources\toolchain\python-embed\pack.bin` (and the other staged packs beside it, not under a second `resources` folder). That pack is not a GitHub release. If a step fails, keep the log tail and the newest `debug\reports\readiness-*.json`.
5. With the owner's keys, run the six steps under Model routing checks in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md), then `npm run models:check --live`. Offline classification is already covered by tests. A live keyed call, a free-proof probe, LM Studio, Ollama, and a real rate limit are not. A failing step needs the step number, the on-screen text, and the newest `debug\reports` file.
6. Do not bump `config/friday-version.json`. `v1.1.2.3` is already declared and was not uploaded. Re-run FRIDAY Release so that publish can finish. Do not dispatch a workflow from a cloud session. Workflow files stay locked. That includes silencing the two CodeQL `::warning` echoes and pinning `ubuntu-24.04` so the Ubuntu 26 runner notice stops.
7. Finding, not fixed here. `src/routeTree.gen.ts` is generated by Vite (`vite dev`, `vite build`, Vitest) with a trailing `declare module` block, and `npm run build:desktop` removes that block. After a desktop build, restore the committed file. Impact: a one-block diff that is not a product change. Owner area: build and packaging, [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).
8. Finding, not fixed here. No `Content-Security-Policy` header is set on the packaged page (`electron/` has no such string). Impact: the packaged window relies on the existing sandbox and navigation allow-list. Owner area: Electron security, already noted in [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md).
9. Finding, not fixed here. `npm run test:fast` is `vitest run --changed`. On a clean committed tree, and on a markdown-only diff, it printed `No test files found` and exited 0. Impact: the tests that read these docs are not selected until `npm test`. Owner area: the local gate, `scripts/test-fast.cjs`.
10. Owner decision. recharts 2.15.4 to 3.x is a UI change and was not done. Latest 3.10.1. Breaking notes from the [3.0 migration guide](https://github.com/recharts/recharts/wiki/3.0-migration-guide): `CategoricalChartState` is gone, `Customized` no longer receives internal state, internal props such as `activeIndex` were removed, `ResponsiveContainer` `ref.current.current` is gone, and `accessibilityLayer` is on by default. The only import is `src/components/ui/chart.tsx`. `core/__tests__/project-governance.test.ts` pins `dependencies.recharts` to `^2.`. Impact: the install warns that 2.x is deprecated. Owner area: UI, a separate task.
11. Waiting on a parent. `tsconfck` 3.1.6 (unmaintained) is required by `vite-tsconfig-paths` 6.1.1, which is the latest 6.x. `rcedit` 5.0.2 is the latest and is marked unsupported; `scripts/brand-windows.cjs` still imports it. No override. Owner area: build, [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).
12. The desktop and web Vite builds set `chunkSizeWarningLimit` to 8192, `checks.bundlerTimings` to false, and `checks.moduleLevelDirective` to false. AppShell is still one chunk (3,672.05 kB on run 38726685910). Splitting `src/components/friday/AppShell.tsx` was not done. `npm warn deprecated` for `tsconfck`, `rcedit`, and `recharts` still prints on `npm ci`. Owner area: build, [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).
13. Finding, not a change. A constraints file that pins Node, npm, Python, and PowerShell would fight the `>=` floors (newer versions are reused). The 2026-10-13 known-good line is in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md). Owner area: toolchain floors.
14. Voice smoothness on the owner's PC is unverified. After `npm run setup` and `npm run build:win`, run the seven steps under Voice smoothness in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md). A failure needs the step number, the on-screen text, and the newest `debug\reports` file.
15. Finding, not fixed here. faster-whisper stays on CPU int8. CUDA float16 and a larger model need extra libraries, and a failed load looks like a dead microphone. Impact: Hindi stays on the small model. Owner area: speech, `kernel/stt.py`.
16. Owner decision. An offline Hindi voice is not bundled. Supertonic 3 F2 speaks Hindi when it is installed. With the network off and that model missing, Windows needs a female Indian voice or the status says how to add Hindi (India). Owner area: voice.
17. Finding, not added. Embeddings and speech are not a chat route. Memory hashes text on this PC. Speech stays on the voice ladder. `baseRouting()` still leaves rerank empty. Impact: a rerank ask is not dispatched. Owner area: Models.
18. Finding, not changed. `src/lib/friday/models-engine.ts` `baseInstalled` still marks `qwen2.5-32b`, `llama3.1-8b`, `llama3.2-3b`, and `deepseek-coder-v2` installed before a scan. Refresh clears a missing Ollama tag only. Impact: the Models page can show those rows installed until inventory returns. Owner area: Models.
19. Owner decision. Groq still publishes a Free plan, but the 2026-10-13 rate-limits table is the Developer plan and does not list free ids. Declare the account free in Models if that key is on the Free plan. No new provider was added. Mistral Experiment, Cohere trial limits, and Hugging Face `:cheapest` were not re-read on 2026-10-13.
20. The four router phases are in this tree. Still unverified on the owner's PC: launcher download and install, a real model download with pause and resume, a live key, Chat and Voice on the same lane, Privacy mode, a paid cap, two local models on one job, and the minimum window. The eight checks are in the pull request report. Owner area: Models.
