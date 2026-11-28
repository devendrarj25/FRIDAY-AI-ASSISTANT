# FRIDAY — Architecture Overview

_FRIDAY - AI ASSISTANT. A Private, Autonomous and Self Learning OS Based on Local & Cloud Models._

**Current shipping version: 1.2.5.7**

🏗️ Layer map for this checkout. The folder baseline is [docs/FRIDAY_ARCHITECTURE_BASELINE.md](docs/FRIDAY_ARCHITECTURE_BASELINE.md). The owner loop is [docs/FRIDAY_MASTER_FLOW.md](docs/FRIDAY_MASTER_FLOW.md). Disk layout is [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

## 1. Layers

| Layer | Path | Job |
| --- | --- | --- |
| Renderer | `src/` | React 19 UI, TanStack Router, chat/voice/settings |
| Preload | `electron/preload.cjs` | Allowlisted `window.friday` via `contextBridge` |
| Main | `electron/` | Windows, IPC handlers, models, updater, toolchains |
| Kernel | `kernel/` | FastAPI on loopback (`kernel/main.py`), WebSocket `/bridge` |
| Contracts / tests | `core/` | Vitest suite and typed contracts — not inside the EXE |
| Scripts | `scripts/` | Setup, pack, docs engine, release engine |

Stack from `package.json` / kernel floors: Electron 45, React 19, TanStack Router 1.170, Vite 8, Tailwind 4, TypeScript 6.0, Vitest 5, Python ≥ 3.12.10, FastAPI 0.115+, uvicorn, httpx, pydantic 2, PyYAML. Voice floors `faster-whisper` and `edge-tts` are in `kernel/requirements.txt`. Optional extras (numpy, chromadb, pywin32, …) are in `kernel/requirements-capabilities.txt`.

## 2. IPC

The renderer never runs shell. Every call is `ipcRenderer.invoke` / `send` on named channels (`app:version`, `chat:send`, `workspace:get`, …). Main process brokers chat streams back as compact events.

## 3. Kernel surface

`kernel/main.py` mounts `GET /health`, `GET /version`, and `WebSocket /bridge`. Companion HTTP routes come from `kernel/companion.py`. `kernel/router.py` is the **model** router, not FastAPI routes. Tools: `kernel/tools.py` (79 entries in the `RISK` table; exec-tier tools wait for desktop approval). `/health` and `/version` are the unauthenticated loopback reads. The bridge checks the per-launch token. Companion routes that change state check the phone switch and the pair token. FastAPI's error envelope is `{ "detail": "..." }`.
<!-- docs-engine: generated kernel routes. Edit scripts/docs-engine.cjs, not this. -->

| Method | Path |
| --- | --- |
| GET | `/companion` |
| GET | `/companion/` |
| GET | `/companion/features` |
| GET | `/companion/icon-192.png` |
| GET | `/companion/icon-512.png` |
| GET | `/companion/manifest.json` |
| POST | `/companion/pair` |
| POST | `/companion/speak` |
| GET | `/companion/sw.js` |
| GET | `/companion/whats-new` |
| GET | `/health` |
| GET | `/version` |
| WEBSOCKET | `/bridge` |
| WEBSOCKET | `/companion/ws` |

<!-- docs-engine: end generated kernel routes -->


## 4. Intelligence

Conversation goes through `src/lib/friday/brain-engine.ts` → `src/lib/friday/brain/core-brain.ts`. Retrieval: `src/lib/friday/brain/retrieval.ts`. Orchestration: `src/lib/friday/brain/orchestrator.ts`. Spec-only graphs under `core/brain/` are tests/contracts, not a second runtime brain.

**Local brain.** FRIDAY Core is the local model FRIDAY runs on this PC, described by `config/friday-core.json` and read by `electron/friday-core.cjs`. FRIDAY Runtime LLM (`electron/llama-runtime.cjs`, started and stopped through `electron/models.cjs`, the one lifecycle owner) serves it on a free loopback port. `kernel/router.py` `escalate()` keeps a turn on Core or sends it to a heavier local model or the cloud after both firewalls; SENSITIVE and private-mode work never reaches the cloud and a model of unknown cost is never taken automatically. Weights come from the FRIDAY Brain, Voice and Recall weight packs (owner-built, see [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md)), release first with the official source as the fallback. Detail: [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md) section 6 and [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). One locality rule decides what is local: a model is local only on a loopback endpoint or an engine host the owner set in the environment (`kernel/privacy.py`, `electron/model-access.cjs`), and the renderer cannot add, sync or remove the Core row. The Brain panel in Settings reads Core's state through the read-only `brain:core-status` channel, which never carries the key, port or address. In the speech worker the own final-pass ears (Ear English, Ear Quick, Ear Swift) sit in front of faster-whisper when their pinned folders are installed (`kernel/stt.py`; routing in [docs/FRIDAY_VOICE_ENGINE.md](docs/FRIDAY_VOICE_ENGINE.md)). Linux tests only; Windows, GPU, a real model start and the release download are unverified; nothing is uploaded yet; Core default off until the A/B gate. The own ears were checked on Linux only; Windows and a real microphone are unverified.

**Turn contract.** `chat.stream` carries `maxTokens`, `ownerText` and `routingSurface`; `chat.cancel` stops a stream in the kernel (`kernel/tests/test_chat_stream_cancel.py`). `task.run`, `task.resume` and `task.approve` return `{done, state, pendingApproval}`, so a task waiting for approval is not reported as done (`kernel/tests/test_task_run_state.py`). A spoken turn is lean: effort low, 180 reply tokens (`VOICE_MAX_TOKENS`), kernel recall deadline 0.4 s (`RECALL_TIMEOUT_VOICE`), the vector recall raced against 250 ms, the six capability routers and the live web search run together under one 1.5 s deadline (`src/lib/friday/brain/core-brain.ts`), and the kernel persona is not prepended on voice. The Ollama context window (`num_ctx`) comes from `config/chat-tiers.json`, clamped by this PC's RAM, with `FRIDAY_OLLAMA_NUM_CTX` as the override (`kernel/router.py`). A long tool is class `long-job` in the IPC budget table, and a wait that ends reads as "still running", not a failure. The tool gate (`electron/tool-gate.cjs`): the Full dial lets write and exec calls run without a prompt, except the app's own shutdown and restart, a tool the owner set to ask, and the kernel's own refusals; Stop everything (halted) refuses write and exec whatever the dial says, so an Allow that arrives after Stop is refused. A `terminal:exec` that FRIDAY itself chose (origin `agent`) goes through the same gate, and a halted FRIDAY denies it. Tests: `core/__tests__/chat-stream-owner-text.test.ts`, `core/__tests__/chat-stream-voice-deadline.test.ts`, `core/__tests__/tool-gate-autonomy-dial.test.ts`, `core/__tests__/ipc-budget-long-jobs.test.ts`. UNVERIFIED: the deadline values (voice first delta 15 s cloud, 20 s local warm, 60 s cold; watchdog 30 s and 75 s on voice), a stalled Ollama and Stop, and the tray ask notification, none run on Windows or against a live model.

**Memory.** One Unicode term contract in `src/lib/friday/brain/retrieval.ts` serves the kernel and the renderer, so Hindi and Devanagari terms match on both sides (`kernel/tests/test_memory_devanagari.py`, `core/__tests__/memory-devanagari-recall.test.ts`). The vector index carries a version stamp and starts at boot, not only from a panel (`core/__tests__/vector-index-boot.test.ts`). Kernel recall has a deadline and a score floor (`RECALL_FLOOR_CHROMA`, `RECALL_FLOOR_NUMPY` in `kernel/memory.py`); the floors are starting values, not measured on real Hindi data. The folder index skips files by rule, and each chunk gets its own privacy screen over a 200-character window. Planner lessons are capped and treated as untrusted. The everyday intercepts do not claim an action they did not run (no fake "Opening" or "forget"), and forget removes the item from the backup and the vector index (`core/__tests__/everyday-intercepts.test.ts`, `core/__tests__/memory-forget-backup.test.ts`). Stored-file durability is in [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

## 5. Navigation

Sidebar, companion, and landing path share `src/lib/friday/navigation.ts`. Settings is footer-only (`SETTINGS_NAV`). `/character` exists as `src/routes/character.tsx` and is not a sidebar row.

## 5a. Program and data

The installed program lives in `<root>\App`; everything the owner or FRIDAY creates sits beside it in the same root. `OWNERSHIP` in `electron/friday-contract.cjs` names each folder as program, shared or data, and the importer, the update safety net and the storage janitor all read it, so an update can replace the program and nothing else. Where each download lands (models, speech weights, Python libraries, tools FRIDAY unpacks, system installs) and what `<root>\inventory.json` records is in [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md). Downloads made before a folder exists are staged in `.friday-dev` and moved in on first launch by `electron/staged-assets.cjs`.

## 6. Build output

`electron-builder.yml` packs `dist-desktop/**`, `electron/**`, `package.json`, `scripts/release-engine.cjs` into the asar, and copies kernel + capability trees + scripts as `extraResources`. Artifact names are overridden to the public four-part version by `scripts/electron-pack.cjs`.

## 7. Repository tree

```text
FRIDAY-AI-ASSISTANT/
├── AGENTS.md CLAUDE.md          working rules for contributors
├── README.md INSTALL.md RELEASE.md VERSIONING.md CHANGELOG.md
├── ARCHITECTURE.md AUDIT.md SECURITY.md CONTRIBUTING.md FRIDAY_STATE.md
├── LICENSE package.json package-lock.json requirements.txt
├── electron-builder.yml vite.config.ts vite.electron.config.ts
├── tsconfig.json eslint.config.js ruff.toml pyrightconfig.json components.json
├── src/                         React UI: routes/, components/, lib/friday/ (brain, models, self)
├── electron/                    Windows main process: windows, IPC, models, updater, credentials
├── kernel/                      Python FastAPI kernel: tools, memory, router, devices, tests/
├── core/                        Vitest contracts (__tests__/) — not shipped in the EXE
├── agents/ skills/ tools/ plugins/ modules/ workflows/   capability trees (extra resources)
├── config/                      version identity, toolchain floors, kernel.yaml, project-structure.json
├── scripts/                     setup, pack pipeline, docs engine, release engine, git-hooks/
├── builder/ installer/ updater/ build manager, NSIS installer and uninstall plan, update channel
├── docs/                        registered documentation set (index: docs/README.md)
├── memory/ database/ brain-data/ conversations/ backup/     local store layout (.gitkeep only)
├── models/ system/ resources/ public/                        model assets, system files, icons, wake word
├── testing/ debug/ temporary/ releases/                      fixtures, scratch layout, published notes
└── .github/                     eleven workflows, three composite actions, CODEOWNERS, templates
```

The same folders are declared in `config/project-structure.json` (generated from `electron/friday-contract.cjs` `SOURCE_LAYOUT`) and checked by `npm run arrange:check`. Build output (`dist-desktop/`, `release/`, `.cache/`) and the local environments (`node_modules/`, `.venv/`) are ignored by Git.
