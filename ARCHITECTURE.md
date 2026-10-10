# FRIDAY — Architecture Overview

**Current shipping version: 1.0.1.2**

🏗️ Layer map for this checkout. The locked folder baseline is [docs/FRIDAY_ARCHITECTURE_BASELINE.md](docs/FRIDAY_ARCHITECTURE_BASELINE.md). The owner loop is [docs/FRIDAY_MASTER_FLOW.md](docs/FRIDAY_MASTER_FLOW.md). Disk layout is [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

## 1. Layers

| Layer | Path | Job |
| --- | --- | --- |
| Renderer | `src/` | React 19 UI, TanStack Router, chat/voice/settings |
| Preload | `electron/preload.cjs` | Allowlisted `window.friday` via `contextBridge` |
| Main | `electron/` | Windows, IPC handlers, models, updater, toolchains |
| Kernel | `kernel/` | FastAPI on loopback (`kernel/main.py`), WebSocket `/bridge` |
| Contracts / tests | `core/` | Vitest suite and typed contracts — not inside the EXE |
| Scripts | `scripts/` | Setup, pack, docs engine, release engine |

Stack from `package.json` / kernel floors: Electron 43, React 19, TanStack Router 1.170, Vite 8, Tailwind 4, TypeScript 5.9, Vitest 5, Python ≥ 3.12.10, FastAPI 0.115+, uvicorn, httpx, pydantic 2, PyYAML. Voice floors `faster-whisper` and `edge-tts` are in `kernel/requirements.txt`. Optional extras (numpy, chromadb, pywin32, …) are in `kernel/requirements-capabilities.txt`.

## 2. IPC

The renderer never runs shell. Every call is `ipcRenderer.invoke` / `send` on named channels (`app:version`, `chat:send`, `workspace:get`, …). Main process brokers chat streams back as compact events.

## 3. Kernel surface

`kernel/main.py` mounts `GET /health`, `GET /version`, and `WebSocket /bridge`. Companion HTTP routes come from `kernel/companion.py`. `kernel/router.py` is the **model** router, not FastAPI routes. Tools: `kernel/tools.py` (32 named tools, exec-tier for PC control). `/health` and `/version` are the unauthenticated loopback reads. The bridge checks the per-launch token. Companion routes that change state check the phone switch and the pair token. FastAPI's error envelope is `{ "detail": "..." }`.
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

## 5. Navigation

Sidebar, companion, and landing path share `src/lib/friday/navigation.ts`. Settings is footer-only (`SETTINGS_NAV`). `/character` exists as `src/routes/character.tsx` and is not a sidebar row.

## 6. Build output

`electron-builder.yml` packs `dist-desktop/**`, `electron/**`, `package.json`, `scripts/release-engine.cjs` into the asar, and copies kernel + capability trees + scripts as `extraResources`. Artifact names are overridden to the public four-part version by `scripts/electron-pack.cjs`.
