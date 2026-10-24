# FRIDAY — Feature & Capability Catalog

**Current shipping version: 1.1.3.5**

FRIDAY - AI ASSISTANT: A Private, Autonomous and Self Learning OS Based on Local & Cloud Models.

What ships in this checkout, the file that implements it, and a test that covers it. How to use the app: [FRIDAY_USER_GUIDE.md](FRIDAY_USER_GUIDE.md). Keys and providers: [FRIDAY_PROVIDERS_AND_SECRETS.md](FRIDAY_PROVIDERS_AND_SECRETS.md). The operating loop: [FRIDAY_MASTER_FLOW.md](FRIDAY_MASTER_FLOW.md). This catalog does not repeat those pages. Design and dependency decisions are at the end, once.

Discovery: `listCapabilities()` in `src/lib/friday/capability-trees.ts`. Disk trees: `electron/friday-contract.cjs` `TREES`. Landing path: `resolveLandingPath()` in `src/lib/friday/navigation.ts`. Root folders: `ensureStructure()` in `electron/friday-paths.cjs`. Public identity: `readCanonicalIdentity()` in `scripts/release-engine.cjs`.

Checkout counts (manifest files on disk, plus 9 builtins in `electron/skills.cjs`): Skills **214** `skill.json`, Tools **178** `tool.json`, Agents **98** `manifest.json`, Plugins **78** `plugin.json`, Workflows **117** `workflow.json`, Modules **76** `manifest.json`. Connectors **113** in `electron/connectors.cjs`. Kernel tools **53** in `kernel/tools.py`.

## 1. Shell, design, and pages

| Surface | Implementation | Verified by |
| --- | --- | --- |
| Sidebar + companion menu | `src/lib/friday/navigation.ts`, `src/components/friday/AppShell.tsx`, `src/routes/__root.tsx` | `core/__tests__/navigation-registry.test.ts`, `core/__tests__/app-shell-startup.test.ts` |
| Title strip | `src/components/friday/TitleStrip.tsx`, `electron/main.cjs` | `core/__tests__/window-ipc-parity.test.ts` |
| Stage / orb | `src/components/friday/Stage.tsx`, `src/lib/friday/stage.ts` | `core/__tests__/stage-background.test.ts` |
| Boot | `src/components/friday/BootScreen.tsx`, `src/lib/friday/startup.ts` | `core/__tests__/startup-flow.test.ts` |
| Live wiring | `src/lib/friday/wiring.ts`, `src/components/friday/WiringVisualizer.tsx` | `core/__tests__/wiring-visualizer.test.ts` |
| Flow Studio | `src/lib/friday/flow-graph.ts`, `flow-adapters.ts`, `flow-bind.ts`, `flow-codec.ts`, `flow-coverage.ts`, `flow-depth.ts`, `flow-edit.ts`, `flow-layout.ts`, `flow-tools.ts`, `flow-modes.ts`, `flow-diagram.ts`, `flow-pdf.ts`, `diagram-raster.ts`, `diagram-ocr.ts`, `flow-registry.gen.ts`, `flow-render.ts`, `electron/diagram-ocr.cjs`, `src/components/friday/FlowStudio.tsx`, `FlowCanvas.tsx`, and `FlowStudioLazy.tsx` (the dialog and its layout, PDF, and editor engines load on first open). One graph feeds List, Blocks, graph, and code. Watch shows the turn the brain already recorded and Replay never runs a step again. Boxes move, wires reconnect, and a real binding can change a setting, the router strategy, the wake phrase, or the autonomy level; a wire that cannot act shows why. An attached diagram or a photo of a flowchart opens on the same canvas. | `core/__tests__/flow-studio.test.ts`, `core/__tests__/flow-studio-deep.test.ts`, `core/__tests__/flow-studio-live.test.ts`, `core/__tests__/flow-studio-chat-voice.test.ts`, `core/__tests__/flow-photo-pdf.test.ts` |
| Honesty of live badges | renderer engines | `core/__tests__/ui-live-honesty.test.ts` |
| FRIDAY Glass design language | `src/styles.css` (tokens, glass levels, motion, focus and press states, cursor rules), `src/components/friday/ui.tsx` (HudPanel, StatTile, StatusPill, FilterTabs, SectionTabs, SegmentedControl, DataTable, ToggleRow, ActionButton, Toolbar, EmptyState, LoadingState), `src/components/friday/button-icons.ts`, `src/components/ui/*`. Futuristic Glass (default) is applied through `html[data-ui-style="glass"]`; Classic is the earlier look on the same tokens and adds no CSS of its own. Pages use shared caption and corner tokens (`text-meta`, `text-note`, `text-data`, `rounded-ctl`, `rounded-surface`) instead of hard-coded sizes. Glass: rounded translucent panels over three soft ambient lights, capsule controls, iOS segmented controls with a sliding thumb, a sliding sidebar highlight (`nav-thumb.ts`), buttons at least 32 px tall, 12 px sentence-case captions, blur only on large chrome and toasts (the Blur effect setting and GPU rendering off switch it off). Every text button gets an icon from one verb vocabulary and every panel header one from its title. Text, icon, and button contrast is checked in all 8 mode and accent combinations plus High contrast. | `core/__tests__/ui-primitives.test.ts`, `core/__tests__/ui-glass-tokens.test.ts`, `core/__tests__/ui-control-parity.test.ts` |
| Appearance settings | `src/lib/friday/appearance.ts` (`appearanceState()` is the pure description; `applyAppearance()` writes it), `src/components/friday/settings/AppearanceSettings.tsx`. Theme, Look, Motion, Text and layout, and Chat groups with a live preview built from the real classes: Interface style (Futuristic Glass or Classic), Glass depth, Corner style, Ambient light, Ambient motion, Button labels, color mode and accent (8 combinations), fonts, text size, density, sidebar default, bubble style, animations, blur, live circuit, glow, scanlines, GPU rendering, reduce motion, high contrast, chat timestamps, graphic intensity, panel opacity, and Reset. | `core/__tests__/appearance-settings.test.ts`, `core/__tests__/settings-section.test.ts` |
| Page states and live sync | `src/lib/friday/live-poll.ts` and `use-live-poll.ts` (one shared poller that pauses while the window is hidden, backs off a failing job to 8 times its period, and stops with its last subscriber), `use-kernel-status.ts` (one shared kernel store that reconnects by itself and on kernel exit), `use-clock-tick.ts`, `page-state.ts`, `src/components/friday/PageStates.tsx` (ErrorState with Retry and the real error text, the kernel-down and offline banner above every page, the Live badge, the route error screen), `rejection-toast.ts` (an unhandled rejection becomes a toast), `pending-action.ts` with `src/components/ui/button.tsx` (a handler that returns a promise puts its button in a pending state: spinner, disabled, an error toast on failure), `interaction-pause.ts` (decorative loops hold still while typing or scrolling), `truncate-titles.ts` (cut text gets a tooltip). Status, Hardware, Logs, Models, and Doctor show a Live badge read from real timestamps. Tabs and filters light up at once and update the page as a low-priority transition; search fields filter a deferred value; long tables draw 80 rows and offer Show more and Show all. | `core/__tests__/live-poll.test.ts`, `core/__tests__/page-states.test.ts`, `core/__tests__/pending-action.test.ts`, `core/__tests__/interaction-pause.test.ts`, `core/__tests__/route-render.test.ts` |
| No control removed | `core/fixtures/ui-control-baseline.json` (1520 control labels), `core/__tests__/helpers/ui-controls.ts`. A label may move between files or into a More menu, never disappear without a reviewed rename. An icon-only button without a name, and a button with no handler, fail. | `core/__tests__/ui-control-parity.test.ts` |

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
| Streaming chat | `src/components/friday/ChatDock.tsx`, `src/lib/friday/chat-turn.ts`, `kernel/router.py`. IPC `chat:send` and `chat:tool`. A stop keeps the words already on screen. A typed send that is still busy stays in the box and the strip says why. New chat stops the in-flight request first. Manual and chat never listen or speak. | `core/__tests__/conversation-intelligence.test.ts`, `core/__tests__/main-window-live.test.ts`, `core/__tests__/chat-manual-human.test.ts` |
| Chat levels (Manual main window) | `src/lib/friday/chat-level.ts` (level store, Alt keys, toolbar overflow, graphic fit, selection hold), `src/components/friday/ChatDock.tsx`, `ChatMessages.tsx`, `ChatToolbar.tsx`, `src/lib/friday/chat-blocks.ts`, `src/routes/index.tsx`. Compact, Expanded, and Full chat from the 1 / 2 / 3 switch or Alt+1/2/3. The level is saved under `friday.chat.level.v1` and the saved-chats rail open or closed under `friday.chat.rail`. The transcript follows a streaming reply only while the owner is at the bottom and holds still while text is selected. Bubbles use the glass bubble classes; the composer is a capsule. | `core/__tests__/chat-level.test.ts`, `core/__tests__/chat-blocks.test.ts`, `core/__tests__/main-window-layout.test.ts`, `core/__tests__/chat-selection-hold.test.ts` |
| Manual / Auto | `src/lib/friday/assistant-mode.ts` and `src/lib/friday/voice-session.ts`. The microphone and spoken replies run only in Auto. A finished sentence is spoken while the rest of the answer arrives; a spoken yes is short and expires; a line aimed at another assistant is ignored. `src/lib/friday/addressing.ts` decides a name, a follow-up, or ambient speech. `src/lib/friday/pcm-capture.ts` is the one pre-roll ring. `src/lib/friday/frame-clock.ts` is the one drawing clock and pauses while the window is hidden. | `core/__tests__/voice-session.test.ts`, `core/__tests__/voice-auto-mode.test.ts`, `core/__tests__/voice-depth.test.ts`, `core/__tests__/voice-human.test.ts`, `core/__tests__/voice-live.test.ts`, `core/__tests__/voice-smooth.test.ts` |
| Voice window levels (Auto mode) | `src/components/friday/AutoMode.tsx`, `VoiceControlBar.tsx`, `VoiceTranscript.tsx`, `src/lib/friday/chat-level.ts`, `src/components/friday/AutonomyDial.tsx`. Compact, Expanded, and Transcript, saved under `friday.voice.level.v1`. The mic chip and Stop everything stay on the bar at every level. | `core/__tests__/auto-mode-layout.test.ts`, `core/__tests__/chat-level.test.ts`, `core/__tests__/main-window-layout.test.ts` |
| Phone companion chat | the same Core Brain as typed and voice; a busy desktop acknowledges and fails (no silent kernel brain); `chat.replace` keeps phone history in step | `core/__tests__/phone-live-parity.test.ts` |
| Cognitive mind | `src/lib/friday/brain/cognitive-runtime.ts` (state machine, goals, gates), `cognitive-mind.ts` (attention ranking, withheld uncertain claims, decisions, identity stays FRIDAY), `local-mind.ts` (a verified stable answer is reused without a model), `cognitive-control.ts` (runs the pass inside `coreBrain.cognize`). Cognition never executes and a saved card never changes permissions. | `core/__tests__/cognitive-runtime.test.ts`, `core/__tests__/cognitive-mind.test.ts`, `core/__tests__/cognitive-control.test.ts`, `core/__tests__/local-mind.test.ts` |
| Memory fabric | `src/lib/friday/brain/memory-fabric.ts` governs the existing memory engine and knowledge base: explicit corrections outrank guesses, a superseded fact answers only a historical question, sensitive attributes are not inferred, and deletion removes a record from every projection. Missing embeddings fall back to lexical recall. `setMemoryFabricEnabled(false)` rolls the gate back without a second store. | `core/__tests__/memory-knowledge-fabric.test.ts`, `core/__tests__/memory-knowledge-depth.test.ts`, `core/__tests__/memory-fabric.test.ts`, `core/__tests__/knowledge-ingest.test.ts` |
| Wake / STT / TTS | `kernel/stt.py` + `electron/stt.cjs` (one faster-whisper worker; Moonshine inside it for English when its weights are on disk; Hindi and Hinglish stay on faster-whisper), `kernel/voice_runtime.py` (Silero VAD, Smart Turn, gain, denoise), `electron/neural-voice.cjs` (Supertonic 3 when installed, edge-tts by default when online and not private, system voices as the fallback), `electron/wake-engine.cjs` + `kernel/wake_word.py` (configured `.onnx` only). `npm run voice:check` prints PASS, FAIL, or OPTIONAL per stage; `npm run voice:install` downloads the on-demand weights. See Speech runtime below. | `core/__tests__/wake-word.test.ts`, `core/__tests__/desktop-stt.test.ts`, `core/__tests__/voice-state.test.ts`, `core/__tests__/voice-human.test.ts`, `kernel/tests/test_wake_word.py`, `kernel/tests/test_voice_runtime.py` |
| Local engines | Ollama plus `LOCAL_ENGINES`: LM Studio, llama.cpp, vLLM, LocalAI, Jan, KoboldCpp, GPT4All (MLX-LM on macOS only). A GGUF install does not require Ollama. Local models are free and private for normal use. `electron/local-model-status.cjs` reports serving, not loaded, runner stopped, runner not installed, or failed with the reason. | `core/__tests__/provider-registry.test.ts`, `core/__tests__/engine-control.test.ts`, `core/__tests__/model-sources.test.ts` |
| Cloud dispatch | `electron/models.cjs` `CLOUD`, `kernel/router.py`. Health probes use the same chat URL builder as live turns. Free-tier keys work without paid unlock. | `core/__tests__/provider-dispatch-contract.test.ts`, `core/__tests__/billing-firewall.test.ts` |
| Model routing | `electron/model-router.cjs`: `selectEligible` is the ordered candidate list, `planRoute` explains it, and `routeRequest` is the one funnel for Chat and Voice. Hard filters cover route mode, privacy, locality, provider, cloud opt-in, cost, cooldown, role, capability, and context; a private request stays on this PC; paid is absent unless paid access, the billing firewall, and the budget all allow it. Multi strategies: single, fallback, parallel, race, cascade, pipeline, primary-critic, primary-verifier, candidate-judge. HTTP 400 and 422 are not retried; a 429 honours Retry-After; a 403 is a model or tier, not a dead key. Each provider is one handler under `electron/handlers/`, registered from `electron/provider-registry.cjs`. `kernel/router.py` re-checks route mode and privacy. Contract mirror: `src/lib/friday/model-routing-contract.ts`. | `core/__tests__/route-plan.test.ts`, `core/__tests__/model-router-max.test.ts`, `core/__tests__/provider-federation.test.ts`, `core/__tests__/knowledge-age.test.ts`, `kernel/tests/test_live_routing.py`, `kernel/tests/test_router_http_hints.py`, `core/__tests__/local-cloud-routers.test.ts` |
| Local transfers | `electron/model-download.cjs` is the only download entry (re-exports `electron/download-safety.cjs` and `electron/local-library.cjs`). Hosts: `config/download-hosts.json`. Runner pins: `config/local-runners.json`. Pause keeps `.part`, cancel deletes it, a restart marks an interrupted row paused. | `core/__tests__/local-ai-backend.test.ts` |
| Paid spend | `electron/model-router.cjs` `recordSpend` and `preferNewestFree`. A verified-free family uses the newest id, then the previous one if that id failed. Day and month totals roll from an explicit charge time. | `core/__tests__/cloud-ai-backend.test.ts` |
| Models sections | `src/routes/models.tsx` with `src/lib/friday/model-sections.ts`: LOCAL AI (system support, launchers, catalogue, import), CLOUD AI (free models, catalogue status, providers), and ROUTING tabs. A launcher card shows the official URL and does not start the file. Cloud selection is the allowlist. Paid stays off until Confirm paid. | `core/__tests__/model-sections.test.ts`, `core/__tests__/models-dead-controls.test.ts` |
| Models fit, search and import | `checkSupport` / `estimateFit` in `src/lib/friday/model-catalog.ts` (Unknown until the PC is measured, then by RAM, VRAM and free disk of the models drive from `electron/hardware.cjs`), `arrangeByFit` / `onlineFit` in `model-sections.ts`, online search in `electron/models.cjs` (GGUF only), and `electron/model-import.cjs` behind `models:pick-files` and `models:import` (check, store under `models\imported`, register with Ollama, test prompt). A GGUF reaches Ollama as a blob named under `files` (`registerGguf` in `electron/model-download.cjs`; the old Modelfile form is only a fallback) and a refusal shows Ollama's own reason. The same file or name is one imported row. A provider whose key is being checked reads "Checking…". | `core/__tests__/models-section.test.ts`, `core/__tests__/model-register.test.ts`, `core/__tests__/models-checking.test.ts` |
| Voice models in the Models list | `voiceModelsOnDisk()` and `downloadTarget()` in `electron/voice-weights.cjs`: faster-whisper tiny to large-v3 under `cache\stt\<size>`, Silero VAD, Smart Turn and Supertonic 3 under `models\` are marked installed only when their files are on disk; a speech size downloaded from the Models page lands where the speech worker opens it. Default speech is faster-whisper small and the default voice is Supertonic 3. | `core/__tests__/models-section.test.ts` |
| Use a named model or provider | `promptRouting()` in `src/lib/friday/brain-engine.ts` with `parseModelRequest()` in `src/lib/friday/brain/model-request.ts`: "use qwen2.5 1.5b", "gemini se pucho", "ask claude" pin that chat or voice turn to the model, or to that provider's models. A bare mention does not. | `core/__tests__/model-request.test.ts` |
| Install Manager finds its own installs | `detectTools()` passes the FRIDAY root, so tools unpacked under `runtime\<tool>` (FRIDAY Python, Node, MinGit, gh, Temurin, KoboldCpp) are found and not downloaded again; `electron/managed-install.cjs` records version and path in a marker; `electron/managed-path.cjs` adds their folders to PATH (after the system's) and writes `runtime/managed-path.json`, which `kernel/env_guard.py` `child_env()` reads for every command the kernel starts. | `core/__tests__/managed-tools.test.ts`, `kernel/tests/test_managed_path.py` |
| Newest versions from the vendors | `electron/vendor-sources.cjs`: official feeds (nodejs.org, go.dev, static.rust-lang.org, update.code.visualstudio.com, api.adoptium.net, GitHub releases with their asset digests) plus the `winget upgrade` table; npm and GitHub each have a second host; everything goes through the app's network stack. A tool no source names a version for says so. | `core/__tests__/vendor-sources.test.ts`, `core/__tests__/tool-latest.test.ts` |
| Install fallback and no bare Manual | A tool winget cannot install takes the vendor's own installer from its feed, only when the vendor published a SHA-256, with the vendor's CDN redirect allowed because the digest is checked; a pinned archive installs the newest feed release and keeps the pin as its fallback. Playwright browsers, Docker Compose (through Docker Desktop), WSL 2 (elevated, restart noted), Whisper.cpp and npm install or update themselves; five vendor-only tools say why. The zip reader uses the central directory. | `core/__tests__/install-fallback.test.ts`, `core/__tests__/tool-routes.test.ts` |
| Service start, stop, restart | `electron/tool-services.cjs`: Ollama, LM Studio, Docker Desktop, Redis/Memurai, PostgreSQL, MongoDB, MySQL, MariaDB. What FRIDAY starts stops when idle (default 20 minutes; the local-model ledger counts as use) and when she quits; a service that was already running is left alone; Windows services need UAC and never stop by themselves. | `core/__tests__/tool-services.test.ts` |
| Ask FRIDAY about her tools | `answerInstallerQuestion()` and `parseServiceRequest()` in `src/lib/friday/installer-answers.ts`: what is missing, outdated or broken, what is running, "is git installed", "version of node", "start docker", "ollama band karo". | `core/__tests__/installer-answers.test.ts` |
| Smooth free-tier use | A rate limit rests a model for the wait the provider names (Retry-After, "try again in 7.66s", "retry in 21.96s"), never 30 minutes for a per-minute limit; a wait of three seconds or less is taken in place once; OpenRouter's free-models-per-day cap rests all its free models together; parallel runs take one model per provider first; Groq priced models become usable when the owner marks the key as the Free plan. | `core/__tests__/rate-limit-waits.test.ts`, `core/__tests__/five-providers.test.ts` |
| Hugging Face runner | A local engine for Safetensors and PyTorch models: `electron/hf-runner.cjs` (own virtual environment, hub-cache linking, `transformers serve` on port 8083), the Install Manager tool "Hugging Face runner", the "Hugging Face runner" service (start, stop, idle stop, started on demand), and the `transformers` provider across the router, privacy and billing lists. A Hugging Face repo download or an imported Safetensors/PyTorch folder is linked in and the runner is queued for install when it is missing. | `core/__tests__/hf-runner.test.ts`, `kernel/tests/test_hf_runner_surface.py` |
| Hugging Face account on downloads | The stored Hugging Face key opens gated and private repositories; it goes to huggingface.co and hf.co only, for the length of one download. | `core/__tests__/hf-token.test.ts` |
| Cloud model kinds | Every cloud model resolves to Chat, Vision, Coding, Reasoning, Research, Image, Video, Speech to Text, Text to Speech, Embedding or Other from its name, the provider's own modalities or the Hugging Face pipeline tag; the Models page filters and labels by it. | `core/__tests__/model-capabilities-media.test.ts` |
| Draw a picture | "Draw …", "generate an image of …", "image banao …" asks a connected cloud image model (OpenAI, Together AI, xAI, Gemini, DeepInfra, Hugging Face) through the privacy and billing gates, shows it in the chat and keeps it in `assets\images`; `electron/image-generation.cjs`, `src/lib/friday/image-command.ts`. | `core/__tests__/image-generation.test.ts` |
| Crash safety and native theme | A helper process that exits mid-write cannot take the interface down (stdin error guards, broken-pipe errors ignored in `onFatal`, a stray error after load is logged, the wake worker is not respawned in a loop), and native controls and popups follow the theme (`color-scheme`, themed `<option>`, popup colours in `src/components/ui/sonner.tsx` and `src/styles.css`). | `core/__tests__/helper-pipe-safety.test.ts`, `core/__tests__/ui-native-theme.test.ts` |
| Tools used on demand | A chat turn routed to a local engine (Ollama, LM Studio) starts it first when FRIDAY stopped it for being idle, and counts the turn as use; `ensureLocalService` in `electron/main.cjs`. A failed scan or unreadable newest versions show a banner with Retry on the Install Manager page. | `core/__tests__/tool-services.test.ts`, `core/__tests__/installer-needs.test.ts` |
| Install needs first | A package that runs on another (pnpm on Node.js, Maven on a JDK, Docker Compose on Docker Desktop, Playwright browsers on Python) queues the missing one ahead of it; `NEEDS` in `src/lib/friday/catalog.ts`, queue in `src/lib/friday/installer-engine.ts`. | `core/__tests__/installer-needs.test.ts` |
| Install Manager sections | Software (catalog and package details), Queue & Updates, Services, Health & Maintenance, Activity, Ask FRIDAY; `src/lib/friday/installer-sections.ts` says which panel sits where and a test reads the page. | `core/__tests__/install-manager-page.test.ts` |
| Agent toolkit before the build | `scripts/prefetch-toolkit.cjs` (a command of `prepare-environment`) installs the tools in `config/agent-toolkit.json` through the Install Manager job, with no size cap: search and convert tools (ripgrep, jq, yq, FFmpeg, Pandoc, Tesseract), Git and build tools (CMake, Ninja, 7-Zip), languages (Go, Rust, OpenJDK, uv), and WSL 2, Docker Desktop, Windows Sandbox and, on an NVIDIA PC, the CUDA Toolkit. Present and current is not downloaded again, older is updated, the administrator ones show the Windows prompt, and a failure never fails the build. Big models and runners only a model needs (Hugging Face runner, vLLM) stay in the Models section and the Install Manager. | `core/__tests__/prefetch-toolkit.test.ts` |
| Files and archives for the agent | `kernel/file_tools.py` behind `fs.list`, `fs.info`, `fs.identify` (type from the first bytes), `fs.find`, `fs.extract` (docx, xlsx, pptx, pdf with PyMuPDF, csv, json, text), `fs.mkdir`, `fs.copy`, `fs.move`, `fs.delete` (moves to `.friday-trash`, so it can be put back) and `archive.list`, `archive.extract`, `archive.create` (zip, tar, tar.gz, tar.bz2, tar.xz, gz; 7z with py7zr; RAR is read only). Paths stay inside the workspace; an unpacking refuses `..`, absolute and drive names, links, devices, more than 20 000 entries and more than 2 GB. Reading tools are offered to a model; anything that changes a file needs the owner's approval. | `kernel/tests/test_file_tools.py` |
| Docker for the agent | `docker.status` (read only), `docker.pull` (a download, write tier) and `docker.run` (exec tier) plan an allow-listed argv in `kernel/toolchain_gate.py`: the workspace is the only mount, capabilities are dropped, privileges cannot grow, memory, CPUs, processes and time are capped, and there is no network unless asked. Docker Desktop, WSL 2 and Windows Sandbox are installed before the build by the toolkit step. | `kernel/tests/test_file_tools.py` |
| Read-only update source | Settings → Updates connects a public or private repository with its own read-only token (`github.update.token`), separate from Friday Hub's write token. Test connection shows visibility, token scope and the newest official and test releases; a release lists every file with its kind and purpose and the full source zip; "Use the official FRIDAY repository" fills the address. `api()` refuses any write on this connection. | `core/__tests__/update-source-readonly.test.ts` |
| Update downloads that survive a bad connection | The installer, source zip and pack downloads share `electron/resilient-download.cjs`: resume from the `.part`, stall watchdog, retries with backoff, redirects without leaking the token, HTML and cut-zip refusal, checksum before replace, reuse of a verified installer, Cancel, and Update content for an installed app; size, speed and time left on the bar; a free-space check; ETag-cached, rate-limit-aware GitHub reads. | `core/__tests__/resilient-download.test.ts`, `core/__tests__/update-download-resilience.test.ts`, `core/__tests__/update-detection.test.ts` |
| Download only what changed | `electron/differential-download.cjs` rebuilds the new installer from the previous one plus the changed blocks listed in the release's `.blockmap`, verified against the published SHA-256, with a full-download fallback; `release.yml` publishes the block map. | `core/__tests__/differential-download.test.ts` |
| Installer ready before you ask | A newer stable installer is downloaded and checked in the background (`autoDownload`, toggle in Settings → Updates) so Install starts at once; nothing installs without the owner. | `core/__tests__/update-detection.test.ts` |
| New Python packages after an update | `electron/kernel-deps.cjs` installs packages newly added to `kernel/requirements.txt` once, in the background, and asks for a restart. | `core/__tests__/kernel-deps.test.ts` |
| Safe backups that do not pile up | The pre-install backup checks free space first, cleans up a failed copy, and old release backups are pruned after a healthy start. | `core/__tests__/update-download-resilience.test.ts` |
| New built-ins beat stale copies | A built-in capability with a strictly newer version replaces an older workspace copy of the same id (reported as `staleOverride`); equal or newer workspace copies still win. | `core/__tests__/capabilities-update-precedence.test.ts` |
| Shipped defaults follow updates | `electron/config-seed.cjs` brings `kernel.yaml` and `models.yaml` forward on an update when the owner never edited them, and saves `<name>.new` beside an edited copy instead of overwriting it. | `core/__tests__/release-update-contract.test.ts` |
| Source update merge in place | A GitHub source zip is staged with the repository layout so root files, tooling and workflows are updated where they live, the owner's data folders are never replaced, and changed dependency files are reported with the command to run. | `core/__tests__/update-source-merge.test.ts` |
| Silent in-place app update | The verified installer runs `/S --updated --force-run` through `cmd start /wait`, FRIDAY reopens on the new version, a failed install reopens the old one, and the data folders are never replaced (`installerLaunch` in `electron/update-safety.cjs`). | `core/__tests__/update-source-readonly.test.ts`, `core/__tests__/safe-update.test.ts` |
| To-do list | The personal desk (`src/lib/friday/personal-desk.ts`) is the one store behind "todo: ...", "remind me to ..." and "done ..." in chat and the **To-do** panel at the top of the Tasks page (`src/components/friday/TodoPanel.tsx`): add with an optional due time, tick or untick, delete, clear finished. It is part of the app bundle, so it needs no download or install; due reminders still fire through the notification centre under the autonomy dial. Todoist and Microsoft To Do remain optional connectors. | `core/__tests__/todo-panel.test.ts` |
| Install agent toolkit button | `installer.installToolkit()` in `src/lib/friday/installer-engine.ts` reads `config/agent-toolkit.json` and queues the missing tools (the row name comes from `catalog` when it differs from the tool id; CUDA only with an NVIDIA driver). | `core/__tests__/installer-needs.test.ts` |
| Portable restart | A restart in the Portable build starts the portable launcher (`PORTABLE_EXECUTABLE_FILE`) instead of the unpacked temp copy. | `core/__tests__/app-lifecycle.test.ts` |
| Install source fallback | `electron/alt-package-managers.cjs` adds Chocolatey and Scoop after the package manager and the vendor feed in the Install Manager chain, only when they are already installed and only for the tools it names. | `core/__tests__/alt-package-managers.test.ts` |
| Windows Sandbox for the agent | `sandbox.run` (exec tier) in `kernel/sandbox_runner.py` writes a `.wsb` that maps the workspace read-only and one results folder, turns networking off unless asked, runs one command, shuts the guest down and returns the output and exit code. Missing feature: the answer points to the Install Manager. | `kernel/tests/test_sandbox_runner.py` |
| Erase-all uninstall from a script | `Uninstall FRIDAY.exe /S /DELETEDATA` deletes the FRIDAY folder and per-user traces; `/S` alone keeps the data; FRIDAY Test never erases. | `core/__tests__/uninstall-erase-switch.test.ts` |
| Live model status and usage | `electron/model-usage.cjs` (per-model requests, answered, failed, blocked and tokens, counted once in `streamOnce` in `electron/main.cjs`), `models:live-status` joined with the router's health, `src/lib/friday/model-live.ts` (state word, countdown on the shared poller) and the **Live Status** tab (`src/components/friday/ModelsLivePanel.tsx`): router settings, the last models tried, and for each model Active, Ready, Cooling down, Rate limited, Quarantined, Recovering or Blocked with the retry time, tokens and a test button. Tokens are counted from text length (about four characters each) unless the provider reports usage, and say so. | `core/__tests__/models-live.test.ts` |
| Ask FRIDAY about models | `handleModelsCommand()` in `src/lib/friday/models-command.ts`, called by the brain before any model: installed models, connected providers, cooling or quarantined models, tokens used, router status, free and paid counts; "download <exact model name>" starts the same job as the button. | `core/__tests__/models-live.test.ts` |
| Four cloud providers end to end | Gemini, Groq, OpenRouter and NVIDIA connect, list, classify and route against a fake network; a named provider's unproven-cost models join only when paid access is on. | `core/__tests__/four-providers-e2e.test.ts` |
| Task routing reaches the router | `taskPreference()` in `src/lib/friday/brain/task-routing.ts` turns the Models page assignment for the job a prompt looks like (brain, coding, research, reasoning, vision, fast) into live router rows through `registryRowMatches()`; `send()` in `src/lib/friday/brain-engine.ts` offers them as a preference only when nothing else chose, never as a Manual or Multi pool, and only local or free models. Spoken turns lead with the fast model. Image, embedding and rerank are saved but marked "not used yet". | `core/__tests__/task-routing.test.ts` |
| Speech and voice routing are real | Task routing → Speech and Settings → Voice → Speech model size are one setting (`assign()` and `syncSpeechFromPrefs()` in `src/lib/friday/models-engine.ts`); Unassigned is Auto. Only the faster-whisper sizes can be the speech model and only Supertonic 3 the voice (`STT_SIZE_MODEL`, `routingTasks[].only`). The **Voice stack** card on the Live Status tab (`src/lib/friday/voice-stack.ts`) shows Auto mode, microphone, speech model, speaker and the voice files on disk. | `core/__tests__/models-live.test.ts` |
| Input → output and honest providers | `modalityOf()` in `src/lib/friday/model-sections.ts` (a filter and a line on every model); cloud providers FRIDAY has no connector for (`UNSUPPORTED_CLOUD`) are marked and cannot be connected; Connect reports the real result; a rejected key is "not accepted", never "Connected". | `core/__tests__/models-page-audit.test.ts` |
| IPC version / prefs / workspace / voice / bridge | `app:version`, `prefs:get`, `workspace:get`, `voice:state`, `bridge:config` | `core/__tests__/window-ipc-parity.test.ts` |

Chat and Voice call the same brain turn. The surface changes delivery only.

| Family | Chat | Voice | Approval | Memory |
| --- | --- | --- | --- | --- |
| Tools, skills, agents, workflows, plugins, MCP | Same plan | Same plan | Same card. Spoken yes only where policy already allows | Same thread |
| Restart and shutdown | Same plan | Same plan | Always | Not stored as a memory |
| Model route | Same funnel | Same funnel, latency order | Billing firewall | Same |

### Speech runtime

- **One ladder.** Capture, resample, noise gate, VAD, features, text cleanup, prosody, and playback planning live in `src/lib/friday/speech-core.ts`. `chooseStt()` prefers whisper.cpp when its binary and the ggml base file are on disk, then faster-whisper, then Moonshine for English, then an opt-in cloud engine. Live Auto listening uses `planLiveStt()`: faster-whisper, then Moonshine, then Windows speech when that language pack is installed, then a clear instruction. Privacy mode never selects a cloud engine. `formantSynth()` is the last TTS resort and is labelled low quality; Windows system speech is `electron/sapi-voice.cjs`.
- **One heal policy.** `src/lib/friday/voice-heal.ts` serves Auto mode and the Voice buttons (Fix voice, Reset microphone, Run voice self-test, Recheck wake engine): a failure class gets three attempts in ten minutes, then one Needs-you line. A zero-spend probe runs as the idle startup task `voice-health`.
- **GPU.** The faster-whisper worker uses CUDA float16 only when `FRIDAY_GPU` or `FRIDAY_STT_CUDA` is set and both CUDA 12 libraries are visible; otherwise, and when a CUDA load throws, it stays on CPU int8. No speech model is bundled.
- **Audio path.** FRIDAY segments are 16 kHz mono PCM WAV read by `read_pcm16_wav` into a float32 array; `decode_audio` (PyAV) runs only for a foreign format, and an incompatible PyAV is reported once with Fix voice as the confirm before `av>=17.0.0,<19` is installed. The shared PCM ring holds 30 s (`RING_MS`), so a live segment keeps the whole utterance. Downsampling from 48 kHz averages sample groups.
- **Quiet and noisy rooms.** `normalize_gain` in `kernel/voice_runtime.py` lifts a quiet clip toward -22 dBFS before denoise and VAD (at most +30 dB, peak capped at 0.89, never attenuating). `denoise_pcm` is the one place that scales RNNoise int16 frames to [-1, 1]; `guard_denoised` keeps the original clip when the cleaned one is much quieter, much louder, or clips. VAD threshold is 0.35 with 700 ms minimum silence and 400 ms padding. An empty first pass retries without VAD and prompt, then on the original array. `NO_SPEECH_THRESHOLD` and `LOW_CONFIDENCE_LOGPROB` are the only no-speech numbers; every dropped utterance carries a `DROP_CODES` reason in the heard log, and Voice diagnostics shows counters by code. A transcript that is the initial prompt echoed back is dropped.
- **Self-tests.** The voice self-test transcribes a generated clip and speaks `Friday, what time is it` through WAV, `prepare_audio`, denoise, and Whisper at three levels (`python kernel/stt.py --hearing-self-test` runs it from a shell). A missing synthesiser or weight file is a visible skip; the load probe and both self-tests open the same speech model folder. Voice diagnostics also shows the last turn stage by stage (heard, routed, model, reply, spoken) with the failure reason per stage.
- **Helper output.** `electron/json-line.cjs` reads the last line that parses as JSON, so a nested result is read correctly.
- **Listen styles.** Always listening (default) lets the wake word, follow-ups, and "Respond to anything meant for me" decide a turn; with hands-free on, an attention window (45 s by default) keeps the conversation open and counts from the end of her reply. Push to talk transcribes only speech started while Ctrl+Space is held in the window, the on-screen hold button is pressed, or the global Ctrl+Alt+Space toggle is on (it closes after 60 s); a press addresses the turn, and the global shortcut exists only while that style is on in Auto mode.
- **ComfyUI.** An optional local runner that FRIDAY does not bundle (GPL-3.0). `electron/comfyui-client.cjs` talks to its API only on 127.0.0.1. Models, Local has a ComfyUI panel, and the tool pack `tools/media/comfyui-generate` (off until enabled, asks before it runs) makes an image from a chat or voice request.
- **Files.** `electron/document-extract.cjs` is the one extractor for chat attachments: PDF (with OCR fallback), DOCX, XLSX, CSV, PPTX, OpenDocument, EPUB, RTF, email (`.eml`), HTML, ZIP and TAR archives, and source, config, and subtitle files as text.

### Toolchain and bundled runtime

The toolchain manifest is `config/toolchain-manifest.json`. `validateManifest()` rejects a missing hash, a missing license, and a copyleft pack marked bundled. `licenseNotices()` is copied to `resources/toolchain/LICENSE-NOTICES.txt`. `isolatedEnv()` returns a PATH for one FRIDAY shell and leaves the process environment alone. `kernel/toolchain_gate.py` plans pip, Node, C, Git, Java, and the local CI run; pushing to main is refused and hosted workflows are not dispatched. `scripts/stage-toolchain.cjs` checks SHA-256 and size at pack time (`electron-builder.yml` `beforePack`) and writes the archives under `resources/toolchain` or `resources/speech`; they are gitignored, and the Install Manager remains the repair path. Doctor shows Ready only after a verify proof.

**Install Manager downloads and versions.** A vendor installer is fetched through `electron/model-download.cjs` (allowlisted HTTPS, parallel ranges, resume, SHA-256) and the row shows real bytes, speed, ETA and the host (an official source or its mirror) while it downloads, then Verifying and Installing. A tool that names a launcher in `config/local-runners.json` (Ollama) installs the newest official release first, with winget as the fallback, and starts its service again if it was running. The installed version is the client's (`ollama --version` client line), found on PATH or in its standard folders; a row says "Update available" only when the installed build is older than the published one, and the scan after a job is forced so it never adopts a scan that started before the job. While the page is open the installer store re-reads the machine on the shared poller (a full scan every five minutes when no job runs and again when the window returns, the services every fifteen seconds); nothing polls while the window is hidden.

Bundled pins total 205088081 bytes: CPython 3.12.10 embeddable (11133606), get-pip (2234489), Node.js 22.23.3 win-x64 (35574076), whisper.cpp 1.9.2 win-x64 (8194445), and the ggml base model (147951465). The budget is 220000000 bytes, which fits a GitHub release asset (2 GB) and leaves the NSIS script unchanged. MinGit, Temurin, w64devkit (it contains GCC), the tiny model, the standalone CPython archive, and the GitHub CLI stay on demand because of their licenses or size. Bundling a faster-whisper model in the installer is an owner decision.

Free models: Chat and Auto call the same router. Auto asks for the latency surface and Chat for the quality surface. Paid and unknown-cost models stay hidden until paid access is on. A sensitive or private turn stays on a local model. Startup does not download provider pages, and a refresh keeps the last good table when a page does not parse.

## 3. Capabilities, connectors, Windows control

| Capability | Implementation | Verified by |
| --- | --- | --- |
| Skill/tool/plugin runtime | `electron/skills.cjs`, `electron/capabilities.cjs` | `core/__tests__/skills-runtime-wiring.test.ts`, `core/__tests__/tools-runtime-wiring.test.ts`, `core/__tests__/plugins-runtime-wiring.test.ts` |
| Import packs | `electron/pack-shape.cjs` | `core/__tests__/tool-pack-import.test.ts`, `core/__tests__/workflow-pack-import.test.ts` |
| Workflow visual builder | `src/routes/workflow-visual.tsx` | `core/__tests__/workflow-visual-builder.test.ts` |
| Connectors (113) | `electron/connectors.cjs` | `core/__tests__/connectors-oauth.test.ts` |
| Browser | `src/lib/friday/browser-engine.ts` | `core/__tests__/live-browser.test.ts`, `core/__tests__/browser-observe.test.ts` |
| Terminal / sandbox | `src/routes/terminal.tsx`, `src/routes/sandbox.tsx` | `core/__tests__/terminal-observe.test.ts`, `core/__tests__/sandbox-observe.test.ts` |
| Tasks / Doctor / Logs | `src/lib/friday/self/task-graph.ts`, doctor and ops engines | `core/__tests__/tasks-observe.test.ts`, `core/__tests__/doctor-observe.test.ts`, `core/__tests__/logs-observe.test.ts` |
| Library / projects | `src/lib/friday/library-engine.ts`, `src/lib/friday/project-workspace-engine.ts` | `core/__tests__/library-chat.test.ts`, `core/__tests__/project-workspaces.test.ts` |
| PC control (exec-tier) | `kernel/tools.py` (`app.launch`, `input.click`, …) | `core/__tests__/tools-catalog.test.ts` |
| 2D companion | `electron/character/runtime.cjs` | `core/__tests__/companion-live.test.ts` |
| Independence / install | `electron/update-safety.cjs` | `core/__tests__/project-independence.test.ts`, `core/__tests__/safe-update.test.ts`, `core/__tests__/github-release-installer.test.ts`, `core/__tests__/clean-install-contract.test.ts` |
| Stable section contract | navigation + settings | `core/__tests__/stable-section.test.ts` |
| Owner flow chart | `src/lib/friday/flow-chart.ts` | `core/__tests__/owner-flow-chart.test.ts` |
| Network meter | `src/lib/friday/network.ts`, `electron/net-status.cjs` | `core/__tests__/connectivity.test.ts` |
| Camera ingest | devices and camera path | `core/__tests__/camera-ingest.test.ts` |
| Conversation continuity | chat sessions | `core/__tests__/conversation-continuity.test.ts` |
| Desktop loop | `src/lib/friday/self/computer-use.ts`, `src/lib/friday/self/task-graph.ts`, `kernel/control.py` | `core/__tests__/computer-use.test.ts`, `core/__tests__/task-graph.test.ts`, `kernel/tests/test_desktop_tools.py` |
| Free now | `electron/model-router.cjs` `freeNowBoard`, `kernel/router.py` `free_now_entry` | `core/__tests__/usable-models.test.ts`, `kernel/tests/test_router_free_now.py` |
| Turn packet | `src/lib/friday/brain/memory-policy.ts` `packTurnContext` | `core/__tests__/turn-context.test.ts` |
| Life offers | `src/lib/friday/assistant-conduct.ts` `considerLifeTrigger` | `core/__tests__/assistant-conduct.test.ts` |
| MCP scope | `electron/mcp-protocol.cjs`, `electron/mcp-server.cjs`, `electron/mcp-client.cjs` | `core/__tests__/mcp-platform.test.ts`, `core/__tests__/mcp-threat.test.ts`, `core/__tests__/mcp-client.test.ts` |

## 4. Research decisions

Each decision was recorded from public documentation read on the date in its heading. ADOPT means the thing is in FRIDAY, ADAPT means the idea is used inside an existing module, and REJECT means it is not added. New decisions are added here, once, in the same change that makes them.

### Interface speed and states (2026-10-23)

| Topic | Decision | Reason |
| --- | --- | --- |
| [web.dev, Optimize Interaction to Next Paint](https://web.dev/articles/optimize-inp) | ADOPT | Keep handlers light and split work so input wins over decoration: typing and scrolling pause decorative loops, and the Flow Studio engines load on demand. |
| [React, useOptimistic](https://react.dev/reference/react/useOptimistic) with `useDeferredValue` and `startTransition` | ADOPT | Tabs light up at once and filters follow typing at low priority; no new dependency. |
| Virtualising long tables | REJECT | Paged rows (80 at a time, Show all) keep find-in-page and keyboard order simple. |

### Chat and glass interface (2026-10-22)

| Topic | Decision | Reason |
| --- | --- | --- |
| [assistant-ui undispatched send](https://github.com/assistant-ui/assistant-ui/pull/5789) | ADAPT | Keep the draft and show the refusal in this dock; no second composer. |
| [shadcn Message Scroller](https://ui.shadcn.com/docs/components/message-scroller) and [TanStack Virtual chat](https://tanstack.com/virtual/latest/docs/chat) | ADOPT | Follow a streaming reply only at the live edge, with a jump-to-latest control. |
| [ServiceTitan AI kit chat layout](https://anvil.servicetitan.com/docs/kits/ai-kit/components/chat-layout/code) | ADAPT | The transcript is a `role="log"` region that is muted while a reply streams. |
| Virtualising the chat list | REJECT | Rows are memoised and the brain keeps 200 messages. |
| [Axess Lab, glassmorphism and accessibility](https://axesslab.com/?p=5111) | ADOPT | Contrast floors are checked by test. |
| [PatternFly glass mode handbook](https://www.patternfly.org/foundations-and-styles/theming/glass-mode-handbook) | ADOPT | `prefers-reduced-transparency` turns glass solid, and Classic plus High contrast stay one switch away. |
| Glass on data grids | ADAPT | Panel translucency is low and tables keep solid pinned cells. |
| Animating the blur radius | REJECT | Never done. |

### Flow Studio and diagrams (2026-10-06)

| Topic | Decision | Reason |
| --- | --- | --- |
| `@xyflow/react` 12 custom nodes, `onlyRenderVisibleElements`, keyboard focus | ADOPT | Already installed (`^12.12.0`, MIT). Nodes stay memoized. |
| dagre | REJECT | MIT, but the chart is already layered. A second layout library is not required. |
| Mermaid with `securityLevel: strict` | REJECT as a dependency | Mermaid 12 bundles ELK and the full script is large. |
| n8n execution view, LangGraph interrupts, OpenTelemetry GenAI traces | ADAPT | The useful pattern is a read-only run, a scrubber, and an inspector. |
| Graph accessibility | ADOPT | The list view has the same ids as the canvas. |
| Cytoscape.js, Sigma.js, AntV G6/X6, Rete.js, LiteGraph, Drawflow, vis-network, Apache ECharts, d3 | REJECT | A second canvas. Cytoscape.js is MIT (github.com/cytoscape/cytoscape.js, read 2026-10-06). |
| bpmn-js | REJECT | The bpmn.io license requires the watermark to stay visible (bpmn.io/license, read 2026-10-06). |
| n8n engine | REJECT | Sustainable Use License limits use and is not an OSI license (docs.n8n.io/privacy-and-security/sustainable-use-license and github.com/n8n-io/n8n/blob/master/LICENSE.md, read 2026-10-06). |
| Node-RED, tldraw, JointJS+, yFiles, Blockly, Excalidraw, XState, Monaco, CodeMirror, Ajv, react-jsonschema-form | REJECT | Not added. A second editor, state machine, or form library is not required. |
| Mermaid, PlantUML, Graphviz WASM, D2 binary | REJECT as runtimes | Text export and a strict import stay in `flow-depth.ts`. |
| JSON Canvas, DOT, D2 text, SVG, PDF, PNG | ADOPT | Written by FRIDAY. PNG is a small schematic, not a screenshot of the window. |
| OpenTelemetry SDK, LangGraph, Temporal | ADAPT | Local JSON trace is opt-in and redacted. No exporter process and no network. |
| Coverage scan | ADOPT | `scripts/flow-registry.cjs` reads routes, preferences, packs, IPC, kernel decorators, and the eleven workflow files. |
| elkjs 0.12.0 | ADOPT, bundled | Layered layout with orthogonal edges. Auto-layout is a button. |
| ajv 8.20.0 | ADOPT, bundled | The code tab rejects invalid JSON before it replaces the graph. |
| CodeMirror 6 (`@codemirror/view` 6.43.13, `state` 6.7.6, `language` 6.12.3, `lang-json` 6.0.2, `commands` 6.10.3) | ADOPT, bundled | The code tab. On-disk bytes: view 1258858, state 440367, language 309757, lang-json 10751, commands 243420. |
| `@viz-js/viz` 3.31.0 | ADOPT, bundled | DOT becomes SVG inside the app. 4994623 bytes. |
| Graphviz 16.1.0 Windows exe | ADOPT, Install Manager | `windows_10_cmake_Release_graphviz-install-16.1.0-win64.exe`, 8070590 bytes, SHA-256 `46f3b8b412a79915cf8e08bdce6542401bd9efca98ce282f3c5c5b56211e1761`, hashed here 2026-10-06. |
| D2 0.9.0 Windows MSI | ADOPT, Install Manager | `d2-v0.9.0-windows-amd64.msi`, 15527936 bytes, SHA-256 `dbac13edaec26878d36c79c2bcd91d57927cae8878204e3b9816e6c0f32aae1b`, hashed here 2026-10-06. |
| Cytoscape, Sigma, AntV, Rete, LiteGraph, Drawflow, Mermaid runtime, Monaco, Blockly, XState, bpmn-js, n8n engine | REJECT | A second canvas, editor, or workflow engine. |
| OpenTelemetry exporter | REJECT | The recording stays the local event list. |
| OpenTelemetry GenAI spans | ADAPT | A span is named from the operation and the model, and content capture stays opt-in because prompts can be sensitive. |
| LangSmith Studio graph mode | ADAPT | The hosted IDE shows nodes a run traversed and can time-travel. |
| tesseract.js 7.0.0 | REJECT as a bundle | Apache-2.0, WASM, no PDF. The Install Manager already has a Tesseract row. |
| FlowExtract | REJECT | MIT research stack (YOLO, EasyOCR, Hough). |
| draw.io uncompressed XML | ADOPT as a parser | Common editable export. Compressed diagrams are not inflated. |
| LiveKit sequential voice pipeline | ADAPT | Stage names only: audio, VAD, STT, the model, TTS, and barge-in. |
| Visio importer | REJECT | Not verified as a format this checkout can parse. |
| pdf-lib 1.17.1 | ADOPT, bundled | Multi-page PDF with a real font embedder. |
| @pdf-lib/fontkit 1.1.1 | ADOPT, bundled | Shapes Devanagari. Needs regenerator-runtime before drawing. |
| jpeg-js 0.4.4 | ADOPT, bundled | Decodes a JPEG screenshot in the renderer. |
| fflate 0.8.2 | ADOPT, bundled | Inflates PNG pixels and PDF streams. MIT. |
| Noto Sans Devanagari Regular | ADOPT, bundled | Hinted TTF from notofonts, SIL OFL 1.1. Hindi round-trips. |
| tesseract.js | REJECT as a bundle | Already rejected. The existing Install Manager Tesseract row is the engine. |

### Voice and Auto mode (2026-10-05)

| Topic | Decision | Reason |
| --- | --- | --- |
| Adaptive endpointing on top of VAD | ADOPT | A pause is not always the end of a turn. The existing energy VAD stays. |
| Smart Turn v3.2 ONNX | ADOPT | BSD-2-Clause file `smart-turn-v3.2-cpu.onnx`, 8679182 bytes, sha256 `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` (hashed 2026-10-05). |
| Browser echo cancellation and local playback | ADOPT | Chromium already applies echo cancellation on the one capture graph. |
| openWakeWord cooldown | ADAPT | The library's debounce avoids a second fire of the same name. |
| Hinglish on the existing worker | ADAPT | No separate fine-tune file. Hindi and mixed speech stay on faster-whisper, which auto-detects hi/en. |
| Speaker verification as a lock | REJECT | Moonshine diarization weights are published under a community path and were not installed. |
| Voice must not grant exec | ADOPT | Untrusted speech cannot disable approval or confirm a long injected sentence. |
| Quiet hours, kill switch, yield | ADOPT | Tray pause is the kill switch. Quiet hours and an owner who is talking defer a background notice. |
| Streaming partials on the one worker | ADOPT | Whisper segments emit a `stream` line before the final line. |
| kokoro-onnx 0.6.1 as the local voice | REJECT | Package license is MIT and the wheel is `py3-none-any`, but it requires phonemizer, whose PyPI license is GPL-3. |
| piper-tts 1.8.0 | REJECT | PyPI license is GPL-3.0-or-later. Windows wheels exist. |
| sherpa-onnx 1.13.8 | REJECT | The project license is Apache-2.0 and Linux/Windows wheels install with `--only-binary`. |
| silero-vad 6.2.3 pip package | REJECT | It requires torch. Accessed 2026-10-05: pypi.org/pypi/silero-vad/json. |
| Silero VAD ONNX via onnxruntime | ADOPT | The file `silero_vad.onnx` in snakers4/silero-vad is MIT, 2327524 bytes, sha256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` (hashed 2026-10-05 from the master raw file). |
| Supertonic 3 local speaker | ADOPT | Package supertonic 1.3.1 is MIT code. Weights are OpenRAIL-M (use limits, not GPL). |
| pyrnnoise | ADOPT | Apache-2.0, Windows wheels exist. It denoises PCM before the same worker. |
| Renderer capture path | ADOPT | One `getUserMedia` graph already requests echo cancellation, noise suppression, and automatic gain. |
| DirectML or CUDA wheel swap | ADAPT | onnxruntime already selects CUDA or DirectML when that provider is installed, and CPU remains the fallback. |
| Ducking other applications | ADOPT | The Settings toggle uses the existing switch. |
| Hosted voice assistants (interruption, language switching) | ADAPT | Barge-in and language following already exist locally; no hosted voice stack is added. |
| Piper and Kokoro as the default speaker | REJECT | Accessed 2026-10-05. piper-tts on PyPI is GPL-3.0-or-later (github.com/OHF-Voice/piper1-gpl). |
| WeSpeaker ECAPA ONNX | ADAPT | Accessed 2026-10-05. Code is Apache-2.0. VoxCeleb weights are CC-BY-4.0 (wenet-e2e.github.io/wespeaker/pretrained.html). |
| Call pause | ADOPT | Teams, Zoom, Webex, and Skype names pause listening and hold briefings. |
| Plan, act, verify, report | ADOPT | Standing orders, a step budget, undo for a reversible step, and "stop everything" live in the existing Auto path. |

### Chat and manual mode (2026-10-05)

| Topic | Decision | Reason |
| --- | --- | --- |
| Stop keeps the words already shown | ADOPT | A streaming reply can be aborted, and the text that already arrived stays. |
| Match the language of the last message | ADOPT | Assistants follow the language the person just used. |
| Ollama tool loop on the existing chat path | ADOPT | `/api/chat` accepts the same function tools, streams content separately from thinking, and takes a follow-up tool message with `tool_name` and object arguments. |
| Show a lookup beside the answer | ADAPT | Tool activity is surfaced next to the reply. |
| Side canvas or artifacts | REJECT | A second writing surface is not added. |
| Import another product's account memory | REJECT | Each assistant keeps its own memory with different rules. |
| Web search as a model tool | REJECT | The read-only model tools stay the existing file, device, and network lookups. |
| Microphone or speech in chat | REJECT | Manual and chat stay typed. Auto still owns the microphone and spoken replies. |

### Web search (2026-10-10)

| Topic | Decision | Reason |
| --- | --- | --- |
| Brave Search API | ADAPT | `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token`. |
| Loopback SearXNG | ADOPT | `GET /search?q=&format=json` on a base the owner set. |
| HTML result pages | ADAPT | DuckDuckGo, Bing, Brave, and the other HTML engines stay the last resort. |
| Reader text | ADOPT | A fetched page keeps the article or main text, drops scripts and navigation, and caps the quote. |

### Chat and voice continuity (2026-10-09)

| Topic | Decision | Reason |
| --- | --- | --- |
| Realtime semantic turn detection | ADAPT | An unfinished utterance waits, including a Devanagari continuation, and a second copy of the same final transcript is dropped. |
| Realtime interruption | ADAPT | Stopping speech keeps the text already produced. |
| One conversation across modes | ADOPT | Chat and Auto already share Core Brain, the session, and the task graph. |

### Desktop autonomy (2026-10-07)

| Topic | Decision | Reason |
| --- | --- | --- |
| UI Automation control view and content view | ADOPT | Structured controls come before OCR and before a vision model. |
| Prompt-injection controls outside the prompt | ADOPT | Screen text, files, and tool output stay data. |
| UFO2 hybrid detection (UIA, then vision) | ADAPT | The same order, on the existing desktop loop. |
| Hosted vision-first desktop agents | REJECT | They skip the local-first path and the in-app autonomy dial. |
| Durable orchestration replay | ADAPT | Checkpoint, idempotent steps, and bounded retry stay on the existing task graph. |
| A second workflow host | REJECT | One task graph is the durable run. |
| MCP stdio, and HTTP bound to loopback | ADOPT | The 2026-07-28 layer is shared. Tool text is untrusted. |
| A hosted MCP endpoint | REJECT | A public URL is refused. OpenAPI import uses the same loopback rule and the existing read/exec split. |
| Free-now source and age | ADOPT | `freeNowBoard` reads the access record the router already stores. |
| UI Automation physical bounds | ADOPT | `BoundingRectangle` is physical pixels. The normalizer maps every monitor into one 96-DPI desktop. |
| comtypes for the live walker | ADOPT | MIT, optional Windows extra, floor `comtypes>=1.4.0` in `kernel/requirements-capabilities.txt`. |
| Reading a secure desktop with OCR | REJECT | A handoff stops the ladder. Pixel text of a credential or User Account Control prompt is not captured. |
| Control patterns before the mouse | ADOPT | Invoke, Toggle, SelectionItem, ExpandCollapse, Value, and Scroll run when the fresh tree still shows them. |
| Yield the pointer while the owner is active | ADAPT | A write yields, and an expired lease does not act. |
| Name the relaxed check | ADAPT | A vision, OCR, or empty view tells the owner the success check was relaxed. |
| Phone cursor gap refreshes before another write | ADAPT | A gap or an unknown outcome blocks a duplicate write until the desktop snapshot is current. |
| Restart keeps an in-flight run | ADOPT | A reload does not cancel the row. A checked step is not replayed. |
| Run timeline on the existing receipt | ADOPT | Each step keeps source, confidence, age, the postcondition, the undo hint, and a handoff reason. |
| A second canvas or a screenshot log | REJECT | The Tasks page reads the same receipt. A picture of the desktop is not kept. |
| Owner-started senses on the existing watcher | ADOPT | Foreground, folder, idle, lock, power, network, and calendar stay off until a Settings switch is on. |
| A listener that starts by itself | REJECT | Covert watching is not a sense. Off is the fresh state, and the watching line says so. |
| Brief from facts already on this PC | ADOPT | Morning and evening text uses standing orders, calendar titles, and the open-task count. |
| Demonstration into the existing canvas | ADOPT | Consent is required. A password, payment, or secret step is omitted. |
| Page tree before pixels | ADOPT | A page is read as DOM or accessibility nodes. |
| Pixel-first browsing | REJECT | A screenshot is not the first way to see a page, and it is not stored. |
| Daily playbooks as workflow packs | ADOPT | Organize, summarise, meeting notes, a draft, a send, a day plan, and one hisab line live in the existing workflow pack. |
| Rate-limit headers on the response that already returned | ADOPT | Remaining requests and tokens are copied from `x-ratelimit-*` or `anthropic-ratelimit-*`. |
| A separate quota endpoint | REJECT | The meter is the headers on the chat response. |
| Hub model list as data | ADOPT | A list the caller already holds becomes cards. |
| llama.cpp Windows CPU zip b11243 | ADOPT, Install Manager | MIT. `llama-b11243-bin-win-cpu-x64.zip`, 19161151 bytes, SHA-256 `29f91327f4e98fcac93e3b44e6cc54beda26468eb9ffeb804a08cfa67bda8c5b`, hashed here 2026-10-07. |
| Memory export keeps source and age | ADOPT | The existing store already consolidates, remembers, forgets, and backs up. |
| A separate evaluator for a self-change | ADOPT | The proposer only files a discovery. A second function refuses every protected policy file, asks unless the dial is Full, and never marks the change applied. |
| Practice band on the existing learning engine | ADOPT | A held-out task and a candidate that would score itself do not become practice. |
| Untrusted text from screen, page, file, calendar, and tools | ADOPT | The same hostile line stays data. A password assignment is blanked. |
| Electron powerMonitor for lock, power, and idle | ADOPT | `lock-screen`, `unlock-screen`, `suspend`, `resume`, `on-battery`, and `on-ac` plus `getSystemIdleTime()` are the live signals. |
| Foreground caption via GetForegroundWindow and GetWindowText | ADAPT | A bounded poll reads the window caption only. |
| Clipboard while a password manager is in front | REJECT | The clipboard is not read, stored, or emitted when the front window is a password manager. |
| Automatic calendar fetch | REJECT | Calendar titles come from a file already on this PC. |
| Re-check the host after a navigation | ADOPT | A click is refused when the page that is open is not on the allow list, even if the owner opened an allowed host. |
| Stop everything before the next replay step | ADOPT | The kill switch is read again before each watched step. |
| A cyclic UI Automation tree and a node budget | ADOPT | A parent that points at itself ends that branch. |
| IsPassword, off-screen, and an elevated window | ADOPT | A password value is omitted. A disabled or off-screen control is not clicked. |
| comtypes missing falls back to OCR | ADAPT | Perception tries the existing OCR path and says why. |
| Optional WeSpeaker ECAPA speaker score | ADOPT | CC-BY-4.0. The file is not bundled and was not downloaded here, so no hash is pinned. |
| DirectML in place of the CPU provider | REJECT | A session may list DirectML and then CPU. |
| Self-voice while FRIDAY is speaking | ADAPT | The browser echo constraint stays. A frame that matches the playback is dropped. |
| Backup before a schema change, then an atomic publish | ADOPT | `Connection.backup()` copies the database before new columns are added. |
| Copying a live database with a plain file copy | REJECT | A hot SQLite file is not copied with a filesystem copy. |
| Injected faults for crash, 429, clock, and idle | ADOPT | The kernel crash mark, a provider 429, a clock jump, and the startup and idle budgets are tested with an injected clock. |
| One local morning brief and one evening review | ADAPT | The brief uses standing orders, calendar titles, and open tasks already on this PC. |
| A second day scheduler or a hosted briefing | REJECT | The Tasks page reads the same ledger. No new timer, daemon, or hosted brief is added. |
| One System panel for senses, listeners, and recorders | ADOPT | Each row shows on or off, the last sense time, and the last receipt. |
| A new settings page for that panel | REJECT | The rows live on the existing System settings page. |
| Secret text stays out of a receipt, a digest, and an export | ADOPT | A password assignment is blanked before it is shown or exported. |

### Voice install and memory (2026-10-07)

| Topic | Decision | Reason |
| --- | --- | --- |
| faster-whisper loads a CTranslate2 model through the Hub cache. `download_root` and `local_files_only` are the local controls. | ADOPT | Listening starts on `base`, then `small`, with a shorter budget for the small sizes. |
| Converting weights with torch | REJECT | The voice-stack rule already refuses torch. |
| `NotReadableError` is not always "another application". Exclusive mode, a second capture, privacy, and a driver can report the same name. | ADOPT | The classifier separates FRIDAY's own track, a named call process, and the exclusive-mode case, then retries relaxed constraints. |
| Hugging Face Hub resume and `HF_ENDPOINT` | ADOPT | The existing downloader classifies DNS, TLS, proxy, disk, auth, and cancel, and honours an https mirror. |
| Prompt injection stays outside the prompt | ADOPT | Transcripts, phrase lines, memory notes, and research text are data. |
| A second memory store, a second scheduler, piper as the runtime, or a new sidebar row | REJECT | The existing memory store, Tasks ledger, and Voice settings page stay the owners. |

### Voice runtime (2026-10-08)

| Topic | Decision | Reason |
| --- | --- | --- |
| `install_only` is a relocatable CPython archive. Windows builds follow the official Windows floor. | ADOPT | A PC with no system Python and no WinGet can still create the runtime. |
| CPython 3.12.15+20261003 Windows x64 `install_only` tar.gz | ADOPT, Install Manager | PSF-2.0 for the interpreter. 46509797 bytes. |
| Official embeddable CPython zip as the voice runtime | REJECT | It is not the venv layout this runtime already creates. |
| `WhisperModel` downloads from the Hub unless `local_files_only` is set or the argument is a directory. | ADOPT | The app downloader runs first. The worker then opens that folder and does not fetch. |
| Hugging Face still copies into the default hub cache when `download_root` is set on some versions. | ADAPT | The app downloader writes the snapshot under the FRIDAY cache. |
| Bluetooth HFP capture is 8 kHz or 16 kHz mono. A2DP is the media profile. Opening the microphone switches the headset. | ADAPT | A profile change reopens capture at 16000 or 48000. |
| WASAPI exclusive mode refuses a shared open. | ADAPT | The existing classifier already separates that case. |
| openWakeWord's included models start near a 0.5 score, and a room should be tuned on its own noise. | ADAPT | The threshold moves with a local energy floor. |
| A second speech engine, torch, or a new sidebar row | REJECT | The existing Install Manager, Doctor Voice rows, and Voice settings page stay the owners. |

### Speech core and toolchain (2026-10-08)

| Topic | Decision | Reason |
| --- | --- | --- |
| The official Windows embeddable zip plus get-pip | ADAPT | Additional Install Manager row, not the voice runtime. |
| get-pip.py for this date | ADOPT | 2230488 bytes, SHA-256 `fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6`. |
| python-build-standalone install_only | ADOPT | This is the voice runtime. 46509797 bytes, SHA-256 `4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08`, from the 20261003 checksum file. |
| Node.js 22.23.3 Windows zip | ADOPT | SHA-256 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71` from https://nodejs.org/dist/v22.23.3/SHASUMS256.txt . |
| whisper.cpp 1.9.2 win-x64 and ggml base | ADOPT | The zip was hashed here: 8194445 bytes, SHA-256 `49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a`. |
| MinGit and Temurin JDK | ADAPT | On demand, separate processes. MinGit 2.56.0.2 hashed here, GPL-2.0. |
| w64devkit 2.10.0 | ADAPT | Hashed here, 67127496 bytes. The wrapper is Unlicense and the kit contains GCC (GPL-3.0), so it is not bundled. |
| A from-scratch model claimed to match a pretrained voice | REJECT | The formant voice is labelled low quality. |
| torch, silero-vad on pip, vosk, piper, or a new sidebar row | REJECT | The voice-stack rule and the existing pages stay. |

### Free models and warm speech (2026-10-08)

| Topic | Decision | Reason |
| --- | --- | --- |
| electron-builder `beforePack` plus `extraResources` | ADOPT | The hook stages pinned archives before the pack. |
| whisper.cpp `whisper-server` | ADOPT | One process keeps the model loaded and listens on `127.0.0.1`. |
| GitHub release asset limit | ADAPT | The bundled tier is 205088081 bytes under a 220000000 byte budget, inside a 2GB asset. |
| Cerebras pricing | ADAPT | No always-free model list. A promotional credit still flows through account credits. |
| GitHub Models | ADAPT | Retired 2026-07-30. The adapter is not eligible and is not a cloud row. |
| Cloudflare Workers AI | ADAPT | 10,000 Neurons a day. Three documented free ids and three paid-plan ids. |
| SiliconFlow | ADAPT | A `Pro/` id is paid. A zero catalogue price is free. |
| Hyperbolic and SambaNova | REJECT | No verified always-free model list on 2026-10-08. |
| A model name that contains "free" | REJECT | Proof is a documented tier, a zero price, or a verified credit. |

### Listen styles, ComfyUI, tone and desktop agents (2026-10-22)

| Topic | Decision | Reason |
| --- | --- | --- |
| [Handy](https://github.com/cjpais/handy) (MIT): offline dictation, hold-to-talk or toggle, Silero VAD, Whisper or Parakeet | ADAPT | Its listen styles fit Auto mode. FRIDAY keeps its own faster-whisper path and voice gate; no second STT stack. |
| [ComfyUI](https://github.com/comfyanonymous/ComfyUI) local API, official `script_examples/websockets_api_example.py` | ADAPT | Separate GPL program over loopback HTTP, the same way FRIDAY uses Ollama. |
| OmniVoice TTS ([model card](https://huggingface.co/SwinliQ-AI-2/OmniVoice)): code Apache-2.0, weights CC-BY-NC, voice cloning | REJECT | It needs torch, which the voice stack must not depend on, and zero-shot cloning conflicts with "no real person's voice". |
| [Microsoft UFO2](https://www.microsoft.com/en-us/research/publication/ufo2-the-desktop-agentos/) Windows desktop agent: UIA plus vision, app agents, isolated virtual desktop | ADAPT | FRIDAY already drives Windows through UIA (`kernel/uia_tree.py`) and screen reading. |
| Hosted agent modes, memory, projects, scheduled tasks, and camera or screen sharing | ADAPT | FRIDAY has each of these locally: agent runtime with tools and approval, memory, projects, reminders, screen and camera awareness. |
| Speech emotion cues from pitch and energy ([patent 9972341](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9972341), [PMC10586421](https://pmc.ncbi.nlm.nih.gov/articles/PMC10586421/)) | ADOPT | `voice_prosody` measures median pitch, pitch spread, loudness, and voiced share per utterance with numpy; `src/lib/friday/voice-tone.ts` compares them with the owner's own baseline, so a naturally loud voice… |
| Full-duplex hosted voice and barge-in | ADAPT | FRIDAY already has barge-in and a follow-up window. |

### Conversation (2026-10-09)

| Topic | Decision | Reason |
| --- | --- | --- |
| Short replies, a reused conversation, rare humour ([Apple HIG, Siri](https://developer.apple.com/design/human-interface-guidelines/siri)) | ADOPT | Implemented in `src/lib/friday/conversation-style.ts`. |
| A container sandbox opens the plugin file at its host path ([Docker bind mounts](https://docs.docker.com/engine/containers/run/)) | ADOPT | Docker and Podman mount the workspace at that path with the network off; Windows keeps the single `/work` mount. |
| NSIS metadata lists `files[].sha512` and the updater does not roll back ([electron-builder auto-update](https://www.electron.build/docs/features/auto-update)) | ADAPT | FRIDAY checks SHA-256 and keeps its own rollback in `electron/update-safety.cjs`. |
| Another product's dialogue, voice, or logo | REJECT | Independence: no copied persona. |

### Voice interaction (2026-10-13 and 2026-10-14)

| Topic | Decision | Reason |
| --- | --- | --- |
| Chromium echo cancellation covers audio this app plays ([electron#47043](https://github.com/electron/electron/issues/47043)) | ADOPT | Keep echo cancellation and the speaking guard. |
| Swara and Neerja are female Indian neural voices ([Indian voices](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/announcing-ga-of-new-indian-voices/4247044)) | ADOPT | Swara is the silent default; Roman Hindi words go to her in Devanagari. |
| Supertonic 3 voice F2 speaks Hindi ([model card](https://huggingface.co/Supertone/supertonic-3)) | ADOPT | F2 is used and not bundled. |
| faster-whisper documents CPU int8; CUDA needs extra libraries ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)) | ADAPT | Keep int8 unless the CUDA libraries are visible. |
| React 19 compares an external-store snapshot with Object.is ([useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)) | ADOPT | The voice cue is a string, so a caption does not redraw the mark. |
| A separate Hinglish speech vendor ([hinglish-tts](https://github.com/harrrshall/hinglish-tts)) | REJECT | One voice path stays. |
| An ended microphone track cannot be resumed ([microphone track](https://www.webrtc-developers.com/how-to-know-if-my-microphone-works/)) | ADOPT | Reopen the one stream. |
| Windows sleep can freeze the process before a suspend handler runs ([electron#47739](https://github.com/electron/electron/issues/47739)) | ADAPT | Rebuild on `resume`. |
| A hidden document keeps scheduling frames ([visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)) | ADOPT | One clock pauses while the window is hidden. |
| A second streaming speech engine; drawing the orb from React state on every audio frame | REJECT | One worker; the orb draws from the shared clock. |
