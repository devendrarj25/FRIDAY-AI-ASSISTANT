# FRIDAY — Project State

FRIDAY is a private local-first Windows Electron + React + Python FastAPI work desk (currently version 1.1.2.4) owned by **Devendra Singh Meena** (`devendrarj25`). Official repo: https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.

This briefing is the tree as it is now. Evidence: [AUDIT.md](AUDIT.md). Features: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Rules: [AGENTS.md](AGENTS.md). Gate: [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md). Version history stays in [CHANGELOG.md](CHANGELOG.md).

Read order: `AGENTS.md`, then this file, then `docs/FRIDAY_CHANGE_CONTROL.md`, then the one owning doc.

## Owner-verified (2026-10-18, public line 1.1.2.4, build 2026.10.17)

On the owner's Windows PC: PR Validation, Test Build including publish, Release build and publish, `npm run setup`, `npm run build:win`, install, uninstall, and reinstall. GitHub release `v1.1.2.4` was published 2026-10-17T04:20:37Z (Setup 321311216 bytes, Portable 320933137 bytes). This session read that asset list and did not download the EXEs. Known-good tool versions are recorded once in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

That check does not cover this branch. Shutdown and Restart button behaviour, microphone hearing, speech recognition, live provider calls, model downloads, and in-app update apply were not part of it.

## Checks on this Linux tree

Run on 2026-10-20. Windows pack gates were not run. Hosted Actions were not started.

| Check | Result |
| --- | --- |
| `npm run docs:sync` | Passed. 24 documents, all zeros. |
| `npm run docs:check` | Passed. 24 documents. missing 0, unregistered 0, thin 0, wrong title 0, duplicated blocks 0, capability counts off 0. |
| `npm run verify:version` | Passed. `version 1.1.2.4 - all version sources and governed documents are in sync`. |
| `npm run arrange:check` | Passed. 140 folders, missing 0, duplicates 0, junk 0. |
| `npm run lint` | Passed. ESLint was silent. Ruff reported `All checks passed!` and `65 files already formatted`. |
| `npm run typecheck` | Passed. Printed `FRIDAY 1.1.2.4`. |
| `npm run typecheck:py` | Passed. 4 passed. `kernel/pyright-baseline.txt` ceiling is 70. The test asserts the count does not grow. |
| `npm run test:kernel` | 203 passed in 88.89s. Exit 0. |
| `npm test` | 369 files passed, 3067 passed, 2 skipped, 93.09s. Exit 0. |
| `node scripts/tests-required.cjs origin/main` | Passed. 42 code files, 10 test files. |
| `npm run check:provenance` | Failed. The commits on this branch carry an assistant identity in the author field. History was not rewritten. |
| `node scripts/run-actionlint.cjs` | Passed. `workflow lint: actionlint`. |
| `node scripts/audit-architecture.cjs --strict` | Passed. 733 source files. REVIEW lines remain. No file was deleted. |
| `npm run preflight` | Exit 1. Every gate passed except commit provenance. `test:fast` passed: 151 files, 1262 tests. Windows pack gates were not run. |
| `npm run build:desktop` | Passed in 5.04s. `AppShell-DQyikdLw.js` is 3,674.58 kB (gzip 1,310.48 kB). It was not split. `src/routeTree.gen.ts` was unchanged. |
| `npm audit` | 0 vulnerabilities. |
| `pip-audit` | chromadb 1.5.9: PYSEC-2026-311, PYSEC-2026-3813, PYSEC-2026-3814, PYSEC-2026-3815. No published fix version, so the pin was not moved. |
| `npm run pricing:status` | EXPIRING. Oldest is perplexity, checked 2026-10-07, expires 2026-10-21. Those pages were not re-read, so `checkedAt` was not moved. |

## UNVERIFIED

Live microphone and speech recognition on Windows. A live speech-model download. Live provider calls, including OpenRouter. Shutdown and Restart on the packaged EXE, and process cleanup after them. In-app update apply. This branch's Windows CMD pack (`scripts\build-windows.cmd`), readiness RESTART, installer, and SmartScreen. Hosted Actions for this branch. This session did not start a workflow. Linux output is not those checks.

## Snapshot

| Item | Live value |
| --- | --- |
| Public version | `1.1.2.4` (`config/friday-version.json`) |
| npm encoding | `1.1.2` (`package.json`) — never compared as an update identity |
| Epoch | 2 / `friday-2` |
| Published line | GitHub release `v1.1.2.4` (2026-10-17). The next patch is `1.1.2.5` and is not bumped here. |
| Next public revision | Do not bump this file. Assistants do not bump `config/friday-version.json`. |

Stack floors stay in `package.json` and `config/toolchain-versions.json`: Electron ^43.7.7, electron-builder 26.15.3, Vite 8.3.2, Node `>=22.19.0`, Python floor 3.12.10. The owner's known-good line is higher and is not a new floor.

## Coming back after a gap

`git switch main && git pull`, then one branch whose prefix is in [CONTRIBUTING.md](CONTRIBUTING.md), then `npm ci`, then **`npm run preflight`**. Read order is the same as [AGENTS.md](AGENTS.md): this file is second. `npm run resume` and Health Weekly are catalogued in [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). `npm run test:fast` runs tests for the diff against `origin/main`, and a fast core subset when that range has no related tests. `npm run pricing:status` reports whether the pricing snapshot is still inside 14 days.

## Architecture (code, not a second copy of ARCHITECTURE.md)

Renderer `src/` → preload allowlist `electron/preload.cjs` → main `electron/` → kernel `kernel/main.py`. Chat and Voice call `electron/model-router.cjs` `routeRequest`. `kernel/router.py` executes the ids that funnel already chose. Desktop start, hide, restart, and exit go through `electron/app-lifecycle.cjs`. `electron/main.cjs` wires the steps and does not call quit, exit, or relaunch itself. Readiness asks that lifecycle to shut down so the kernel process tree is gone before exit, and `/health` must carry this launch's `instance_id`. `core/` is Vitest and contracts only. Navigation in `src/lib/friday/navigation.ts`: 28 sidebar paths, Settings in the footer, `/character` and `/workflow-visual` are not sidebar rows. Layer map: [ARCHITECTURE.md](ARCHITECTURE.md).

Speech downloads use source families in `config/download-hosts.json`. The live STT ladder, the voice self-heal policy, and the choice not to bundle a speech model are in [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Provider gates, error class, and the OpenRouter privacy setting are in [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md). A local model listed in `config/models.yaml` stays unavailable until discovery marks it installed. Chat then says `no installed local model`, and the pack still continues.

Product code does not require `.cursor/`. `scripts/cloud-agent-install.sh` and `scripts/cloud-agent-start.sh` stay required. `.cursor/environment.json` is the cloud install and start when that file is present. Build outputs and run state (`release/`, `dist-desktop/`, `debug/`, `.venv/`, `.friday-dev/`, `.friday-readiness-root/`, `node_modules/`) stay ignored and are not packed.

## Capability counts (this checkout)

Counted from the files named in the last column. `docs:sync` rewrites the six disk counts when they drift.

| Kind | Count | How counted |
| --- | --- | --- |
| Skills | 214 `skill.json` + 9 builtins | disk + `electron/skills.cjs` `BUILTIN` |
| Tools | 177 `tool.json` | disk |
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
- Billing firewall: no silent paid spend. An unknown-cost model is not an automatic route unless that model has `spendCapUsd`. Strict privacy defaults off.
- Pricing knowledge in `electron/model-access.cjs` **fails closed** after 14 days: the model becomes "unknown", never silently free. A refresh re-reads the provider pages and bumps `KNOWLEDGE_CHECKED_AT`. Tests do not depend on today's date. A page that does not parse leaves the last table.
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

- Live provider calls are unverified. A cloud failure keeps the HTTP status and a redacted body. OpenRouter's data-policy 404 is an account setting (`https://openrouter.ai/settings/privacy`). `npm run models:check --live` was not run. No owner keys are in this environment.
- A live Windows speech download, microphone, Windows speech pack, and Shutdown or Restart on the packaged EXE are unverified. `hf-mirror.com` is off unless `FRIDAY_HF_MIRROR=1`.
- This branch's Windows CMD pack, readiness RESTART, installer, and in-app update apply are unverified. The owner's 1.1.2.4 pack is the verified line. Silent uninstall keeps the data folder.
- Voice smoothness, addressing quality, and flicker on a real GPU are unverified. The checks are in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md) under Voice smoothness and Live listening.
- A background health probe is `planHealthProbe`: cached, jittered, zero-spend, and off in Privacy mode. A removed model id logs a catalogue refresh. Groq's models page was re-read on 2026-10-20. The other provider pages in the unverified row were not opened on this run.
- `src/routeTree.gen.ts` uses one footer (`scripts/route-tree-footer.cjs`). The 2026-10-20 `build:desktop` left that file unchanged.
- The default pack stays unsigned (`signExecutable: false`). SmartScreen may warn on the owner's PC.
- Commit provenance fails on this branch because earlier commits carry an assistant identity in the author field. Those commits were not rewritten. chromadb 1.5.9 has four advisories and no published fix, so it stays. Pricing pages other than Groq were not re-read on 2026-10-20.

## Next priorities

Owner checks stay in order. A failed step should be reported with the step number and the on-screen text.

1. On the Windows PC in `D:\FRIDAY-AI-ASSISTANT` after pulling the branch:
   1. If provenance fails: `git rebase origin/main --exec "git commit --amend --no-edit --reset-author"` then `git push --force-with-lease`.
   2. `npm run setup`, `npm run build:win` (ends all PASS incl. RESTART, `echo %ERRORLEVEL%` is 0); then `git status` is clean.
   3. Run the app: Auto mode on; speech model installs with progress (GPU path used if available); speak 5 sentences, a short word and a long paragraph: each appears in Live Captions; say "FRIDAY, kal ka schedule batao": she answers fast. Interrupt her mid-sentence: she stops at once.
   4. Break things on purpose (unplug mic, switch default input, sleep/wake, delete the speech model folder): she recovers by herself with one short message.
   5. Models: reconnect OpenRouter, Test connection, Refresh, Test selected models, set the OpenRouter privacy setting if shown; run the live check once and send the redacted report from `debug\reports`.
   6. Ask the same request in Chat and in Voice: same plan, same tools, same model lane in the Doctor; kill a model and see her fall back by herself.
   7. Click through every sidebar section and main buttons for a few minutes: no freeze, no stutter.
   8. Restart and Shutdown (sidebar and by asking, approve the card): Task Manager shows no FRIDAY/python/helper left.
   9. After merge, run PR Validation, Test Build and Release once and send any failing log.
   Any failing step: send the step number, on-screen text and newest `debug\reports\*` file.
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
8. AppShell stays one chunk. Splitting `src/components/friday/AppShell.tsx` was not done. This Linux `build:desktop` wrote `AppShell-DQyikdLw.js` at 3,674.58 kB (gzip 1,310.48 kB). In-process `/health` on this machine was 1.84 ms at the median. Click latency and idle CPU on the Windows EXE were not measured.
9. Finding, not a change. A constraints file that pins Node, npm, Python, and PowerShell would fight the `>=` floors. The known-good line is in the build doc.
10. faster-whisper uses CUDA float16 only when the GPU flag is set and cuBLAS plus cuDNN 9 are on PATH. Otherwise it stays on CPU int8. A failed CUDA load falls back the same way. A Windows GPU run is unverified.
11. Owner decision. An offline Hindi voice is not bundled. Supertonic 3 F2 speaks Hindi when it is installed.
12. Embeddings and speech are not a chat route. `baseRouting()` still leaves rerank empty.
13. A local catalog row is not installed until a scan has run, or an install job finishes. A scanned local provider clears a row that is no longer present. The browser preview has no scan, so the brain still treats a catalog version as reachable there. The Models page does not.
14. Groq's public models page, re-read 2026-10-20, still has no free-id list. Models shows that, and the owner can mark one Groq model free. Priced ids stay paid until that mark.
15. Owner decision. Shutdown does not change start-at-login. Restart and shutdown from voice still use the approval card. Full autonomy does not skip those two tools.
16. Owner decision. Do not bundle a speech model in the installer until the owner asks. Published Hub sizes, not measured here: tiny `model.bin` 75.5 MB, base `model.bin` 145 MB, plus about 2.7 MB of tokenizer and vocabulary.
17. Owner decision. `hf-mirror.com` stays opt-in through `FRIDAY_HF_MIRROR=1`. There is no settings switch for it.
18. Owner decision. An unknown model is not used automatically. `spendCapUsd` on that model is what allows it, under the billing firewall. Strict privacy stays off unless the owner turns it on.
19. Owner decision. [CHANGELOG.md](CHANGELOG.md) and `releases/notes/` were not trimmed.
20. No product file was deleted in this pass. `node scripts/audit-architecture.cjs --strict` exits 0 and still prints REVIEW lines for same-name files and for files with no static importer, including `electron/preload.cjs`. Those stay. A file is removed only after grep shows that no test, doc registry, workflow, package script, or runtime path needs it.

## Owner decisions

- Content-Security-Policy enforcement: not turned on. Report-only is the shipped mode.
- Bundling a speech model in the installer: not done. Size note is priority 16.
- `hf-mirror.com`: environment opt-in only.
- Unknown-model spend cap: off until `spendCapUsd` is set on that model.
- Strict privacy: off.
- Changelog and release notes: left untouched.
- recharts 3: not started.
