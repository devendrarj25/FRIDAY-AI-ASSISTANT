# FRIDAY — Project State

FRIDAY is a private local-first Windows Electron + React + Python FastAPI work desk (currently version 1.1.2.2) owned by **Devendra Singh Meena** (`devendrarj25`). Official repo: https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.

This briefing is the tree as it is now. Evidence: [AUDIT.md](AUDIT.md). Features: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Rules: [AGENTS.md](AGENTS.md). Gate: [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md). Version history stays in [CHANGELOG.md](CHANGELOG.md).

Read order: `AGENTS.md`, then this file, then `docs/FRIDAY_CHANGE_CONTROL.md`, then the one owning doc.

## Verified on this Linux tree (2026-10-13)

Baseline `npm run preflight` exited 0 before these docs were edited. Fourteen gates passed. It was not `--full`, so it did not run the Vitest suite, Electron, or the renderer bundle.

| Check | Result |
| --- | --- |
| `npm run preflight` | Exit 0. heal-check, typecheck, docs, version, tests-required, provenance, lint, actionlint, arrange, deps, architecture audit, kernel, pyright, and test:fast all passed. |
| `npm run typecheck` | Passed. Printed `FRIDAY 1.1.2.2`. |
| `npm run verify:version` | Passed. `version 1.1.2.2 - all version sources and governed documents are in sync`. |
| `npm run docs:check` | Passed. 24 documents. missing 0, unregistered 0, thin 0, wrong title 0, duplicated blocks 0, capability counts off 0. |
| `npm run lint` | Passed inside preflight. ESLint was silent. Ruff reported `All checks passed!` and `63 files already formatted`. |
| `npm run typecheck:py` | 4 passed in 5.53s. The ceiling file `kernel/pyright-baseline.txt` is 70. |
| `npm run test:kernel` | 196 passed, 1 Starlette TestClient warning, 21.34s. |
| `npm run arrange:check` | 140 folders declared, missing 0, duplicates 0. |
| `npm run check:provenance` | `provenance ok (origin/main)`. |
| `npm run pricing:status` | FRESH. Oldest source perplexity, checked 2026-10-07, expires 2026-10-21 (7 days left on 2026-10-13). |
| `npm run test:fast` | Exit 0 with `No test files found` because this tree matched `origin/main`. That is not the full suite. |
| `npm test` | 348 files passed, 2892 passed, 2 skipped, 92.68s. Exit 0. |
| `npm audit` / `pip-audit` / `npm run models:check` | Not re-run in this session. |

`npm run validate:local` calls the same preflight script. A failure does not hide later gates.

## UNVERIFIED

The owner's Windows CMD pack (`scripts\build-windows.cmd`), Setup and Portable install, boot, uninstall, reinstall, in-app update and rollback, installer smoke, readiness, a real speech-model download, live microphone, wake word, speech playback, live keyed provider calls, real downloads, and SmartScreen. Linux output is not those checks. Hosted Actions were not dispatched. The owner checked workflow runs on 2026-10-13 and reported them green. That report is not a new run of this branch.

## Snapshot

| Item | Live value |
| --- | --- |
| Public version | `1.1.2.2` (`config/friday-version.json`) |
| npm encoding | `1.1.2` (`package.json`) — never compared as an update identity |
| Epoch | 2 / `friday-2` |
| Published line | GitHub release `v1.1.2.2` (2026-10-13, run 38348306084). Earlier release `v1.1.1.2` is run 38288784028. History from `1.0.0.0` stays in CHANGELOG. Test numbers `1.0.1.0` and `1.0.1.1` are not in that history. |
| Next public revision | `1.1.2.3` (patch). Minor `1.1.3.2`, major `1.2.2.2`, extreme `2.1.2.2`. Do not stage-publish `1.1.2.2` again. |

Stack (from `package.json` / toolchain file): Electron ^43.7.7, electron-builder 26.15.3, React 19, TanStack Router, Vite 8.3.2, Tailwind 4, TypeScript 5.9.3, Vitest 5.0.3, ESLint ^10.12.0, Node `>=22.19.0`, Python floor 3.12.10.

## Coming back after a gap

`git switch main && git pull`, then one branch whose prefix is in [CONTRIBUTING.md](CONTRIBUTING.md), then `npm ci`, then **`npm run preflight`**. Read order is the same as [AGENTS.md](AGENTS.md): this file is second. `npm run resume` and Health Weekly are catalogued in [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). `npm run test:fast` runs only tests related to the diff. `npm run pricing:status` reports whether the pricing snapshot is still inside 14 days.

## Architecture (code, not a second copy of ARCHITECTURE.md)

Renderer `src/` → preload allowlist `electron/preload.cjs` → main `electron/` → kernel `kernel/main.py`. `kernel/router.py` is the model router. `core/` is Vitest and contracts only. Navigation in `src/lib/friday/navigation.ts`: 28 sidebar paths, Settings in the footer, `/character` and `/workflow-visual` are not sidebar rows. Layer map: [ARCHITECTURE.md](ARCHITECTURE.md).

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

Eleven workflow files: eight release and repository workflows plus Health Weekly, Auto Recover, and Security Scan. Catalog and triggers: [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). GitHub workflows stay locked. The owner checked the runs on 2026-10-13 and reported them green. An edit waits for a second yes or ok, unless other work cannot finish without the smallest change, and every error that change causes is fixed in that same change. The rule text is in [AGENTS.md](AGENTS.md).

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
- GitHub workflows stay locked. The owner checked the runs on 2026-10-13 and reported them green. Do not add a twelfth. Do not dispatch a workflow from an assistant session. Do not edit those files to tidy them. If the owner asks for a change there, ask once more and edit only after a second yes or ok. If other work cannot finish without a change there, make the smallest change, read the effect on every workflow that shares that behaviour, and fix every error that change causes in the same change. The rule is [AGENTS.md](AGENTS.md) → GitHub workflows stay locked.
- Windows CMD pack (`scripts\build-windows.cmd` / `npm run build:win`), NSIS Setup and Portable, install, boot, open, uninstall, reinstall, and in-app update/rollback were owner-verified on an earlier tree. After a later change they are unverified until the owner re-checks. Do not wrap `build:win` for Linux. Do not invent a second pack or installer.
- `electron-builder.yml`: `perMachine: false`, `signExecutable: false`, `nsis.deleteAppDataOnUninstall: false`.
- TEST uses `dev.friday.desk.test` so it can sit beside Official.
- Assistants never bump `config/friday-version.json` by hand. From published `1.1.2.2`, patch is `1.1.2.3`, minor is `1.1.3.2`, major is `1.2.2.2`, and extreme is `2.1.2.2`. `mode` auto with `release_type` auto does not invent a number. `stage` publish with `mode` auto publishes an unpublished line once and stops once that GitHub release exists. `mode` rebuild is the only path that replaces those assets. An explicit patch, minor, major, or extreme moves that one counter, including when the line has never been published. A stable git tag and a GitHub release both consume a number. `release_type` auto on an update chooses patch, minor, or major and never extreme. `revision` is a rebuild of the same version. The release workflow applies the number and heals the docs.
- Session `media` is allowed at Chromium so Windows can show its own privacy prompt. It is not a silent skip of that prompt.
- Connectors publish on the companion `live` object (`knownConnectors()`), not as `capabilityRegistry` resource rows.

## Known gaps (honest)

- Owner Windows CMD pack, EXE install, installer smoke, readiness, speech download, boot, uninstall, reinstall, in-app update/rollback, live microphone, wake word, speech, and SmartScreen are unverified on this tree. The smoke script no longer passes a null `RUNNER_TEMP` to `Join-Path`. That fix has not been run on Windows.
- Hosted docs-only run 38372554640 failed 18 plugin and module tests with EACCES. Rootful Docker wrote the bind-mounted files as root, so the runner could not delete them. Docker wraps now add `--user` with the caller id when that id is not root. A hosted re-run of that job is unverified until PR Validation runs again.
- Health Weekly's last listed success is run 38247606809 on `3d7a514`. Actions history lists no run for Repository Control or Security Scan.
- Live keyed provider calls and `npm run models:check --live` were not run. No owner keys are in this environment.
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
4. Local CMD pack on that PC, from this branch, in `D:\FRIDAY-AI-ASSISTANT`: `git fetch`, check out the branch, `npm run setup`, then `npm run build:win`. Expect the log to end with every step PASS, no installer-smoke Path error, no `first run failed`, and `echo %ERRORLEVEL%` printing `0`. Then `git status` should be clean. Expect `release\FRIDAY-Setup-1.1.2.2.exe`, `release\FRIDAY-Portable-1.1.2.2.exe`, and `release\win-unpacked\resources\toolchain\python-embed\pack.bin` (and the other staged packs beside it, not under a second `resources` folder). That pack is not a GitHub release. If a step fails, keep the log tail and the newest `debug\reports\readiness-*.json`.
5. With the owner's keys, run `npm run models:check --live`. Offline classification is already covered by tests. A live keyed call is not.
6. Do not stage-publish `1.1.2.2` again. The next update is a separate owner run. With no stronger change, the patch is `1.1.2.3`. Do not open a second non-release pull request while one into `main` is open. Do not dispatch a workflow. Workflow files stay locked until a second yes or ok.
7. Finding, not fixed here. `src/routeTree.gen.ts` is generated by Vite (`vite dev`, `vite build`, Vitest) with a trailing `declare module` block, and `npm run build:desktop` removes that block. After a desktop build, restore the committed file. Impact: a one-block diff that is not a product change. Owner area: build and packaging, [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).
8. Finding, not fixed here. No `Content-Security-Policy` header is set on the packaged page (`electron/` has no such string). Impact: the packaged window relies on the existing sandbox and navigation allow-list. Owner area: Electron security, already noted in [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md).
9. Finding, not fixed here. `npm run test:fast` is `vitest run --changed`. On a markdown-only diff it printed `No test files found` and exited 0. Impact: the tests that read these docs are not selected until `npm test`. Owner area: the local gate, `scripts/test-fast.cjs`.
10. Owner decision. recharts 2.15.4 to 3.x is a UI change and was not done. Latest 3.10.1. Breaking notes from the [3.0 migration guide](https://github.com/recharts/recharts/wiki/3.0-migration-guide): `CategoricalChartState` is gone, `Customized` no longer receives internal state, internal props such as `activeIndex` were removed, `ResponsiveContainer` `ref.current.current` is gone, and `accessibilityLayer` is on by default. The only import is `src/components/ui/chart.tsx`. `core/__tests__/project-governance.test.ts` pins `dependencies.recharts` to `^2.`. Impact: the install warns that 2.x is deprecated. Owner area: UI, a separate task.
11. Waiting on a parent. `tsconfck` 3.1.6 (unmaintained) is required by `vite-tsconfig-paths` 6.1.1, which is the latest 6.x. `rcedit` 5.0.2 is the latest and is marked unsupported; `scripts/brand-windows.cjs` still imports it. No override. Owner area: build, [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).
12. Finding, not fixed here. The desktop Vite build warns that the AppShell chunk is over 500 kB. `autoCodeSplitting` is already on. `chunkSizeWarningLimit` was not raised. Further splits would edit `src/components/friday/AppShell.tsx`. Impact: a slower first paint of the shell. Owner area: UI.
13. Finding, not a change. A constraints file that pins Node, npm, Python, and PowerShell would fight the `>=` floors (newer versions are reused). The 2026-10-13 known-good line is in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md). Owner area: toolchain floors.
