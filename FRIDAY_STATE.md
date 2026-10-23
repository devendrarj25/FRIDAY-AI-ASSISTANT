# FRIDAY — Project State

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

FRIDAY is a private, local-first Windows desktop assistant: Electron + React in the app, a Python FastAPI kernel on this PC (currently version 1.1.3.5), owned by **Devendra Singh Meena** (`devendrarj25`). Official repo: https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.

This briefing is the tree as it is now and nothing older. Evidence: [AUDIT.md](AUDIT.md). Features: [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). Rules: [AGENTS.md](AGENTS.md). Gate: [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md). Version history stays in [CHANGELOG.md](CHANGELOG.md) and `releases/notes/`.

Read order: `AGENTS.md`, then this file, then `docs/FRIDAY_CHANGE_CONTROL.md`, then the one owning doc.

## Snapshot

| Item | Live value |
| --- | --- |
| Public version | `1.1.3.5` (`config/friday-version.json`), published as GitHub release `v1.1.3.5` (Setup, Portable, `friday-update.json`, `latest.yml`, `SHA256SUMS.txt`, `CHANGELOG.md`) |
| npm encoding | `1.1.3` (`package.json`), never compared as an update identity |
| Epoch | 2 / `friday-2` |
| Next public revision | `1.1.3.6`, not bumped until the owner asks |
| Stack floors | Electron ^43.7.7, electron-builder 26.15.3, Node `>=22.19.0`, Python `>=3.12.10`, Vite 8.3.5 (`package.json`, `config/toolchain-versions.json`) |

## Architecture

Renderer `src/` → preload allowlist `electron/preload.cjs` → main `electron/` → kernel `kernel/main.py`. Chat and Voice call `electron/model-router.cjs` `routeRequest`; `kernel/router.py` executes the ids that funnel already chose. The persisted catalogue is `electron/model-catalogue-store.cjs`. Start, hide, restart, and exit go through `electron/app-lifecycle.cjs`; `electron/main.cjs` wires the steps and does not call quit, exit, or relaunch itself. `/health` carries this launch's `instance_id`. `core/` is Vitest and contracts only. Navigation is `src/lib/friday/navigation.ts`: 28 sidebar paths, Settings in the footer, `/character` and `/workflow-visual` are not sidebar rows. The renderer shell, shared poller, page-state components, and FRIDAY Glass tokens (`src/styles.css`, `src/components/friday/ui.tsx`) are described in [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). IPC calls use one budget table: a quick call waits 30 seconds, a long job has no total deadline, and a stream ends after 120 seconds without output; that error names the budget and does not start a retry or a model fallback by itself. Layer map and repository tree: [ARCHITECTURE.md](ARCHITECTURE.md).

Build output and run state (`release/`, `dist-desktop/`, `.venv/`, `.friday-dev/`, `.friday-readiness-root/`, `node_modules/`) are ignored and not packed. Product code needs no editor or assistant folder; `scripts/cloud-agent-install.sh` and `scripts/cloud-agent-start.sh` are the cloud environment entry points and carry no product feature.

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

Eleven workflow files: eight release and repository workflows plus Health Weekly, Auto Recover, and Security Scan. Catalog and triggers: [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). GitHub workflows stay locked; the owner runs every workflow and merges every pull request. Rule text: [AGENTS.md](AGENTS.md) → Actions, pull, and merge.

Owner-run hosted results on the current `main` line (2026-10-23, from the run logs): PR Validation (pull request, run 172) success; FRIDAY Release (`stage` all, `mode` auto, run 30) success, publish and confirm included, `v1.1.3.5` published with its assets; FRIDAY Test Build (run 3) success; Maintenance Cleanup, Branch Cleanup, and Main Safety Recovery success. Safe Merge ran inside an earlier FRIDAY Release and merged the release pull request. Auto Recover (2026-10-23), Security Scan (2026-10-20), and Health Weekly (2026-10-19) last ran green on schedule. Repository Control has not been run by the owner and stays unverified. They are working: do not edit `.github/` to tidy it.

## Deliberate design decisions

These look like bugs. They are not. Do not "fix" them.

- `core/` is not imported by the shipped EXE.
- `handsFree` initializes **false**. Auto mode is the only listen-and-speak session; Manual and chat never open the microphone and do not speak. Turning Hands-free off requires the wake word again and is remembered.
- `automation.auto_approve_exec: false` in `config/kernel.yaml`. Full autonomy is the owner's dial in the app (Ask every time, Balanced, Full); a fresh install stays Balanced. Stop everything always halts.
- Privacy firewall: SENSITIVE is a hard stop. Other content may use an already-connected provider. Privacy mode keeps speech recognition local and sends no turn to a cloud model.
- Billing firewall: no silent paid spend. An unknown-cost model is not an automatic route unless that model has `spendCapUsd`. Official free evidence is usable before a live probe, and the kernel and desktop use the same source list. Strict privacy defaults off.
- Pricing knowledge in `electron/model-access.cjs` fails closed on **no proof**, not on age. A model an official source proved free stays free on the last good table and is flagged `cached <age>`; a model with no proof is "unknown", never silently free, and shows "pricing info is stale, refresh now", not a paid bill. Sources are re-read at start, every 24 hours, after sleep, and on Refresh now; a failed fetch or an unparsable page keeps the last table. The owner can mark any unverified cloud model free. Tests never depend on today's date.
- Screen text, files, and tool output are data, never instructions. A credential, payment, captcha, or secure-desktop prompt is handed to the owner. Heard speech does not run a tool by itself.
- Publisher identity is locked (`scripts/identity.cjs`, `lockedIdentityFields`). The public id is the owner name and the GitHub username `devendrarj25`; a package carries no email, phone number, or street address. The locked installer and uninstall display name is `FRIDAY — Personal AI Assistant`; the product tagline above is used on descriptive surfaces (README, package description, docs, boot screen, page metadata).
- `PROTECTED_POLICY_FILES` in `src/lib/friday/self/governance.ts` are off-limits to self-dev auto-apply.
- One feature, one implementation (`config/project-structure.json`).
- Requirements are **floors**, not pins. numpy and chromadb stay optional at FastAPI boot.
- The look is FRIDAY Glass: rounded translucent glass over three soft ambient lights, capsule controls, iOS-style bubbles. It is defined once in `src/styles.css` and reaches pages through the shared primitives in `src/components/friday/ui.tsx`. Neon glow only removes glow shadows; only the Blur effect setting and GPU rendering off switch blur off. Classic stays selectable in Settings → Appearance → Interface style and adds no CSS of its own. Inside the Flow Studio canvas the drawing uses canvas tokens on the same theme. Look changes outside that language need the owner's words.
- No control is removed by a redesign: `core/__tests__/ui-control-parity.test.ts` holds the label baseline, and only a reviewed rename may replace a label.
- GitHub workflows stay locked. Do not add a twelfth. No agent or AI runs a workflow; a run already going may be watched and the code fixed from its log. Do not edit those files to tidy them. If the owner asks for a change there, ask once more and edit only after a second yes or ok. If other work cannot finish without one, make the smallest change, read its effect on every workflow that shares that behaviour, and fix every error it causes in the same change.
- Windows CMD pack (`scripts\build-windows.cmd` / `npm run build:win`), NSIS Setup and Portable, install, boot, uninstall, and reinstall keep today's behaviour. Do not wrap `build:win` for Linux and do not invent a second pack or installer.
- `electron-builder.yml`: `perMachine: false`, `signExecutable: false`, `nsis.deleteAppDataOnUninstall: false`.
- TEST uses `dev.friday.desk.test` so it can sit beside Official.
- The version moves only in `config/friday-version.json`, and only when the owner asks. From public `1.1.3.5`, patch is `1.1.3.6`, minor is `1.1.4.5`, major is `1.2.3.5`, and extreme is `2.1.3.5`. `mode` auto with `release_type` auto does not invent a number; `stage` publish with `mode` auto publishes an unpublished line once and stops once that GitHub release exists; `mode` rebuild is the only path that replaces assets. An explicit level moves only that counter, including on a never-published line. A stable git tag and a GitHub release both consume a number. `release_type` auto on an update chooses patch, minor, or major and never extreme. The release workflow applies the number and heals the docs.
- Session `media` is allowed at Chromium so Windows can show its own privacy prompt; it is not a silent skip of that prompt.
- Connectors publish on the companion `live` object (`knownConnectors()`), not as `capabilityRegistry` resource rows.

## Verification status

Evidence and counts are in [AUDIT.md](AUDIT.md). This tree was checked on Linux only. Not run, therefore unverified until the owner runs them on the Windows PC:

- The CMD pack (`scripts\build-windows.cmd`), Setup and Portable EXE, install, uninstall, reinstall, in-app update apply, rollback, Shutdown and Restart on the packaged EXE, SmartScreen.
- The new look and page states in the packaged app, in Dark and Daylight, Glass and Classic.
- Microphone, wake word, barge-in, speech recognition, and speaker-match on real hardware; a live speech-model download.
- Live provider calls with real keys, including OpenRouter, and a live stream.

## Known gaps

- The build-time downloader (progress bar, mirror fallback, `qwen2.5:1.5b` and `qwen2.5:3b` pulls) and the Ollama paths ran only against stand-ins: reuse of an installed Ollama (no installer download), the newest-official-release install with GitHub's digest, and the Install Manager Ollama install and update (live bytes, client-version read, service restart) are unverified until a Windows `build:win` and an Install Manager update run them. The Ollama docs and release API could not be fetched in the last session, so the silent switches and the `digest` field are unverified against the live pages. Ollama keeps its own models folder.
- Hindi and Hinglish hearing quality, the wake word, and voice-turn speed with the new local models need a real microphone on the Windows PC.
- DeepSeek's pricing page carries no price table, so its pricing date is older than the other sources and its models stay unknown until a real table can be read (`npm run pricing:status` reports it).
- Groq publishes no free-model list, so Groq ids stay unknown until the owner marks them free.
- `chromadb` 1.5.9 has advisories with no published fix version; the pin is not moved.
- The locked installer display name still reads `FRIDAY — Personal AI Assistant`, which differs from the product tagline. Changing it is a locked identity change that needs the owner's word.
- Cloudflare Workers AI, GitHub Models, and the providers listed as not added in [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md) are not providers.
- LocalAI has no vendor Windows EXE (Docker only); llama.cpp and vLLM need exactly one matching model file before FRIDAY auto-starts them.
- Unsigned by default; SmartScreen may warn.

## Next priorities

1. Owner check on the Windows PC (the build reuses an installed Ollama and only pulls the two lite models; Install Manager Update on Ollama must end on "Up to date"; send the console text of any step that prints `INFO`): `npm run setup`, `npm run build:win`, install, first launch, then the checks under Verification status. Send the on-screen text of any failure with the step.
2. Decide whether the installer and uninstall display name should adopt the product tagline (locked identity change).
3. Re-read a real DeepSeek price table when the vendor publishes one, and refresh pricing knowledge from the Models page.
4. Voice and Auto: keep moving toward a calm, capable assistant (ambient awareness, anticipation, proactive and polite help, plan → act → verify → report) inside the autonomy dial; measure on the Windows PC with a real microphone.
5. Give the other launcher rows in `config/local-runners.json` (Jan, GPT4All, KoboldCpp) the same newest-release resolver as Ollama once each publishes a per-asset digest; today only Ollama sets `release` in `electron/toolchain.cjs`.
6. Wire the remaining unverified provider paths (live key, live stream, tool and vision flags) when the owner supplies keys.

## Coming back after a gap

`git switch main && git pull`, then one branch whose prefix is in [CONTRIBUTING.md](CONTRIBUTING.md), then `npm ci`, then **`npm run preflight`**. Read order is the same as [AGENTS.md](AGENTS.md): this file is second. `npm run resume` and Health Weekly are catalogued in [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md). `npm run test:fast` runs tests for the diff against `origin/main`. `npm run pricing:status` reports whether the pricing snapshot is still inside 14 days.
