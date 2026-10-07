# FRIDAY — Feature & Capability Catalog

**Current shipping version: 1.0.0.2**

What ships in this checkout, the file that implements it, and a test that covers it. How to click the UI: [FRIDAY_USER_GUIDE.md](../../../../../docs/FRIDAY_USER_GUIDE.md). Providers/keys: [FRIDAY_PROVIDERS_AND_SECRETS.md](../../../../../docs/FRIDAY_PROVIDERS_AND_SECRETS.md). Operating loop: [FRIDAY_MASTER_FLOW.md](../../../../../docs/FRIDAY_MASTER_FLOW.md).

Discovery: `listCapabilities()` in `src/lib/friday/capability-trees.ts`. Disk trees: `electron/friday-contract.cjs` `TREES`. Landing path: `resolveLandingPath()` in `src/lib/friday/navigation.ts`. Root folders: `ensureStructure()` in `electron/friday-paths.cjs`. Public identity: `readCanonicalIdentity()` in `scripts/release-engine.cjs`.

Checkout counts (manifest files on disk, plus 9 builtins in `electron/skills.cjs`): Skills **214** `skill.json`, Tools **177** `tool.json`, Agents **98** `manifest.json`, Plugins **78** `plugin.json`, Workflows **116** `workflow.json`, Modules **76** `manifest.json`. Connectors **113** in `electron/connectors.cjs`. Kernel tools **27** in `kernel/tools.py`.

## 1. Shell and routes

| Surface | Implementation | Verified by |
| --- | --- | --- |
| Sidebar + companion menu | `src/lib/friday/navigation.ts`, `src/components/friday/AppShell.tsx`, `src/routes/__root.tsx` | `core/__tests__/navigation-registry.test.ts`, `core/__tests__/app-shell-startup.test.ts` |
| Title strip | `src/components/friday/TitleStrip.tsx`, `electron/main.cjs` | `core/__tests__/window-ipc-parity.test.ts` |
| Stage / orb | `src/components/friday/Stage.tsx`, `src/lib/friday/stage.ts` | `core/__tests__/stage-background.test.ts` |
| Boot | `src/components/friday/BootScreen.tsx`, `src/lib/friday/startup.ts` | `core/__tests__/startup-flow.test.ts` |
| Live wiring | `src/lib/friday/wiring.ts`, `src/components/friday/WiringVisualizer.tsx` | `core/__tests__/wiring-visualizer.test.ts` |
| Honesty of live badges | renderer engines | `core/__tests__/ui-live-honesty.test.ts` |

Pages (every `src/routes/*.tsx` except `__root.tsx`):

| Path | File |
| --- | --- |
| `/` Friday (Main Window) | `src/routes/index.tsx` |
| `/brain` | `src/routes/brain.tsx` |
| `/memory` | `src/routes/memory.tsx` |
| `/library` | `src/routes/library.tsx` |
| `/self-management` | `src/routes/self-management.tsx` |
| `/status` | `src/routes/status.tsx` |
| `/system` | `src/routes/system.tsx` |
| `/skills` | `src/routes/skills.tsx` |
| `/plugins` | `src/routes/plugins.tsx` |
| `/modules` | `src/routes/modules.tsx` |
| `/agents` | `src/routes/agents.tsx` |
| `/workflows` | `src/routes/workflows.tsx` |
| `/workflow-visual` (not sidebar) | `src/routes/workflow-visual.tsx` |
| `/models` | `src/routes/models.tsx` |
| `/tools` | `src/routes/tools.tsx` |
| `/browser` | `src/routes/browser.tsx` |
| `/connectors` | `src/routes/connectors.tsx` |
| `/devices` | `src/routes/devices.tsx` |
| `/n8n` | `src/routes/n8n.tsx` |
| `/hub` | `src/routes/hub.tsx` |
| `/import` | `src/routes/import.tsx` |
| `/doctor` | `src/routes/doctor.tsx` |
| `/install-manager` | `src/routes/install-manager.tsx` |
| `/tasks` | `src/routes/tasks.tsx` |
| `/projects` | `src/routes/projects.tsx` |
| `/workspace` | `src/routes/workspace.tsx` |
| `/sandbox` | `src/routes/sandbox.tsx` |
| `/terminal` | `src/routes/terminal.tsx` |
| `/logs` | `src/routes/logs.tsx` |
| `/settings` (footer) | `src/routes/settings.tsx` |
| `/character` (not sidebar) | `src/routes/character.tsx` |

## 2. Chat, voice, models

| Capability | Implementation | Verified by |
| --- | --- | --- |
| Streaming chat | `src/components/friday/ChatDock.tsx`, IPC `chat:send` | `core/__tests__/conversation-intelligence.test.ts`, `core/__tests__/main-window-live.test.ts` |
| Manual / Auto | `src/lib/friday/assistant-mode.ts` | `core/__tests__/voice-auto-mode.test.ts` |
| Phone companion chat | same Core Brain as typed/voice; busy desktop acks and fails (no silent kernel brain); `chat.replace` keeps phone history in step | `core/__tests__/phone-live-parity.test.ts` |
| Wake / STT / TTS | `kernel/stt.py` + `electron/stt.cjs` (persistent worker, model loaded once), `electron/neural-voice.cjs` (edge-tts, network), `electron/wake-engine.cjs` + `kernel/wake_word.py` (persistent worker; configured `.onnx` only — no silent friday.onnx fallback) | `core/__tests__/wake-word.test.ts`, `core/__tests__/desktop-stt.test.ts`, `core/__tests__/voice-state.test.ts`, `kernel/tests/test_wake_word.py` |
| Local engines | Ollama plus `LOCAL_ENGINES`: LM Studio, llama.cpp, vLLM, LocalAI, Jan (MLX-LM on macOS only). GGUF install does not require Ollama. | `core/__tests__/provider-registry.test.ts`, `core/__tests__/engine-control.test.ts`, `core/__tests__/model-sources.test.ts` |
| Cloud dispatch | `electron/models.cjs` `CLOUD`, `kernel/router.py`. Health probes use the same chat URL builder as live turns. Free-tier keys work without paid unlock. | `core/__tests__/provider-dispatch-contract.test.ts`, `core/__tests__/billing-firewall.test.ts` |
| IPC version / prefs / workspace / voice / bridge | `app:version`, `prefs:get`, `workspace:get`, `voice:state`, `bridge:config` | `core/__tests__/window-ipc-parity.test.ts` |

## 3. Capabilities, connectors, Windows control

| Capability | Implementation | Verified by |
| --- | --- | --- |
| Skill/tool/plugin runtime | `electron/skills.cjs`, `electron/capabilities.cjs` | `core/__tests__/skills-runtime-wiring.test.ts`, `core/__tests__/tools-runtime-wiring.test.ts`, `core/__tests__/plugins-runtime-wiring.test.ts` |
| Import packs | `electron/pack-shape.cjs` | `core/__tests__/tool-pack-import.test.ts`, `core/__tests__/workflow-pack-import.test.ts` |
| Workflow visual builder | `src/routes/workflow-visual.tsx` | `core/__tests__/workflow-visual-builder.test.ts` |
| Connectors (113) | `electron/connectors.cjs` | `core/__tests__/connectors-oauth.test.ts` |
| Browser | `src/lib/friday/browser-engine.ts` | `core/__tests__/live-browser.test.ts`, `core/__tests__/browser-observe.test.ts` |
| Terminal / sandbox | `src/routes/terminal.tsx`, `src/routes/sandbox.tsx` | `core/__tests__/terminal-observe.test.ts`, `core/__tests__/sandbox-observe.test.ts` |
| Tasks / Doctor / Logs | `src/lib/friday/self/task-graph.ts`, doctor/ops engines | `core/__tests__/tasks-observe.test.ts`, `core/__tests__/doctor-observe.test.ts`, `core/__tests__/logs-observe.test.ts` |
| Library / projects | `src/lib/friday/library-engine.ts`, `src/lib/friday/project-workspace-engine.ts` | `core/__tests__/library-chat.test.ts`, `core/__tests__/project-workspaces.test.ts` |
| PC control (exec-tier) | `kernel/tools.py` (`app.launch`, `input.click`, …) | `core/__tests__/tools-catalog.test.ts` |
| 2D companion | `electron/character/runtime.cjs` | `core/__tests__/companion-live.test.ts` |
| Independence / install | `electron/update-safety.cjs` | `core/__tests__/project-independence.test.ts`, `core/__tests__/safe-update.test.ts`, `core/__tests__/github-release-installer.test.ts`, `core/__tests__/clean-install-contract.test.ts` |
| Stable section contract | navigation + settings | `core/__tests__/stable-section.test.ts` |
| Owner flow chart | `src/lib/friday/flow-chart.ts` | `core/__tests__/owner-flow-chart.test.ts` |
| Network meter | `src/lib/friday/network.ts`, `electron/net-status.cjs` | `core/__tests__/connectivity.test.ts` |
| Camera ingest | devices/camera path | `core/__tests__/camera-ingest.test.ts` |
| Conversation continuity | chat sessions | `core/__tests__/conversation-continuity.test.ts` |
