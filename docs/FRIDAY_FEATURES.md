# FRIDAY — Feature & Capability Catalog

**Current shipping version: 1.0.1.2**

🗂️ What ships in this checkout, the file that implements it, and a test that covers it. How to click the UI: [FRIDAY_USER_GUIDE.md](FRIDAY_USER_GUIDE.md). Keys and providers: [FRIDAY_PROVIDERS_AND_SECRETS.md](FRIDAY_PROVIDERS_AND_SECRETS.md). The operating loop: [FRIDAY_MASTER_FLOW.md](FRIDAY_MASTER_FLOW.md). This catalog does not repeat those pages.

Discovery: `listCapabilities()` in `src/lib/friday/capability-trees.ts`. Disk trees: `electron/friday-contract.cjs` `TREES`. Landing path: `resolveLandingPath()` in `src/lib/friday/navigation.ts`. Root folders: `ensureStructure()` in `electron/friday-paths.cjs`. Public identity: `readCanonicalIdentity()` in `scripts/release-engine.cjs`.

Checkout counts (manifest files on disk, plus 9 builtins in `electron/skills.cjs`): Skills **214** `skill.json`, Tools **177** `tool.json`, Agents **98** `manifest.json`, Plugins **78** `plugin.json`, Workflows **117** `workflow.json`, Modules **76** `manifest.json`. Connectors **113** in `electron/connectors.cjs`. Kernel tools **51** in `kernel/tools.py`.

## 1. Shell and routes

| Surface | Implementation | Verified by |
| --- | --- | --- |
| Sidebar + companion menu | `src/lib/friday/navigation.ts`, `src/components/friday/AppShell.tsx`, `src/routes/__root.tsx` | `core/__tests__/navigation-registry.test.ts`, `core/__tests__/app-shell-startup.test.ts` |
| Title strip | `src/components/friday/TitleStrip.tsx`, `electron/main.cjs` | `core/__tests__/window-ipc-parity.test.ts` |
| Stage / orb | `src/components/friday/Stage.tsx`, `src/lib/friday/stage.ts` | `core/__tests__/stage-background.test.ts` |
| Boot | `src/components/friday/BootScreen.tsx`, `src/lib/friday/startup.ts` | `core/__tests__/startup-flow.test.ts` |
| Live wiring | `src/lib/friday/wiring.ts`, `src/components/friday/WiringVisualizer.tsx` | `core/__tests__/wiring-visualizer.test.ts` |
| Flow Studio | `src/lib/friday/flow-graph.ts`, `flow-adapters.ts`, `flow-bind.ts`, `flow-codec.ts`, `flow-coverage.ts`, `flow-depth.ts`, `flow-edit.ts`, `flow-layout.ts`, `flow-tools.ts`, `flow-modes.ts`, `flow-diagram.ts`, `flow-pdf.ts`, `diagram-raster.ts`, `diagram-ocr.ts`, `flow-registry.gen.ts`, `flow-render.ts`, `electron/diagram-ocr.cjs`, `src/components/friday/FlowStudio.tsx`, `FlowCanvas.tsx`. The Flow button opens that page. The conversation strip holds the chart button and the step count once, and that button opens the turn. Voice flow on Auto mode opens the voice state machine. An attached diagram opens the same canvas. A photo of a flowchart is read from its boxes and lines. Boxes move, wires reconnect, and a real binding can change a setting, the router strategy, the wake phrase, or the autonomy level. A wire that cannot act shows a reason. Full map is the generated registry. List, Blocks, graph, and code read one graph. Watch uses the turn the brain already recorded. Replay does not run a step again. | `core/__tests__/flow-studio.test.ts`, `core/__tests__/flow-studio-deep.test.ts`, `core/__tests__/flow-studio-live.test.ts`, `core/__tests__/flow-studio-chat-voice.test.ts`, `core/__tests__/flow-photo-pdf.test.ts` |
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
| Streaming chat | `src/components/friday/ChatDock.tsx`, `src/lib/friday/chat-turn.ts`, `kernel/router.py`. IPC `chat:send` and `chat:tool`. Ollama uses the same read-only tools as the other wires. A stop keeps the words already on screen. The conversation header names a lookup while it runs. Typed chat matches the last message when reply language follows the user. A typed send that is still busy, or that the brain does not accept, stays in the box and the strip says why. Opening another saved chat waits for that reply. New chat stops the in-flight request before the transcript is cleared. Manual and chat still do not listen or speak. Research 2026-10-10: [assistant-ui undispatched send](https://github.com/assistant-ui/assistant-ui/pull/5789) ADAPT — keep the draft and show the refusal in this dock. A second composer is not added. | `core/__tests__/conversation-intelligence.test.ts`, `core/__tests__/main-window-live.test.ts`, `core/__tests__/chat-manual-human.test.ts` |
| Manual / Auto | `src/lib/friday/assistant-mode.ts` and `src/lib/friday/voice-session.ts`. The microphone and spoken replies run only in Auto. Chat does not listen or speak. Auto is hands-free unless Hands-free was saved off. A finished sentence is spoken while the rest of the answer is still arriving. A mid-thought pause waits longer, up to a cap. A repeated wake inside the cooldown is ignored. A spoken yes has to be short, and it expires. Speech that tries to turn approval off still waits for a yes. Exec still waits for a yes. A line aimed at another assistant is ignored. A bare "do it" asks which one. "Continue" resumes speech that was cut off. Quiet hours lower the spoken volume. A hold sound gets one "Mm-hmm." | `core/__tests__/voice-session.test.ts`, `core/__tests__/voice-auto-mode.test.ts`, `core/__tests__/voice-depth.test.ts`, `core/__tests__/voice-human.test.ts` |
| Phone companion chat | same Core Brain as typed/voice; busy desktop acks and fails (no silent kernel brain); `chat.replace` keeps phone history in step | `core/__tests__/phone-live-parity.test.ts` |
| Cognitive mind | `src/lib/friday/brain/cognitive-runtime.ts` walks the state machine, goals, and gates. `cognitive-mind.ts` ranks attention, withholds uncertain claims, records a decision, keeps affect from changing permissions, commits only on an explicit ask, and sends a model request whose identity stays FRIDAY. `local-mind.ts` keeps a verified stable answer on this PC and answers the next matching ask without a model. `cognitive-control.ts` runs that pass inside `coreBrain.cognize`. Chat, voice, and phone still share that entry. Cognition does not execute, and a saved card does not change permissions. | `core/__tests__/cognitive-runtime.test.ts`, `core/__tests__/cognitive-mind.test.ts`, `core/__tests__/cognitive-control.test.ts`, `core/__tests__/local-mind.test.ts` |
| Memory fabric | `src/lib/friday/brain/memory-fabric.ts` governs the existing memory engine and knowledge base. Explicit corrections outrank guesses, a superseded fact stays available for a historical question and stays out of a current answer, sensitive attributes and identity are not inferred, and deletion removes the record from authority, the knowledge projection, the compiled packet, and a later restore. Ingest also writes dated claims and sentence units onto that knowledge base. A web guess cannot replace an owner preference. Graph and temporal strategies change the rank. Identical ingestion does not write a second belief. Missing embeddings fall back to lexical recall. `setMemoryFabricEnabled(false)` rolls this gate back without a second store. | `core/__tests__/memory-knowledge-fabric.test.ts`, `core/__tests__/memory-knowledge-depth.test.ts`, `core/__tests__/memory-fabric.test.ts`, `core/__tests__/knowledge-ingest.test.ts` |
| Wake / STT / TTS | `kernel/stt.py` + `electron/stt.cjs` (one faster-whisper worker). Partial text is a `stream` line on that worker. English Moonshine runs inside it only when those MIT weights are already on disk and the preference is English. Hindi and Hinglish stay on faster-whisper. `kernel/voice_runtime.py` scores Silero VAD and Smart Turn when those ONNX files are on disk. `electron/neural-voice.cjs` speaks Supertonic 3 (voice F2) when that model is installed, and edge-tts only for a selected Neural voice when the text is not sensitive. System voices remain the fallback. `electron/wake-engine.cjs` + `kernel/wake_word.py` (configured `.onnx` only). `npm run voice:check` prints PASS/FAIL per stage and exits 0 when the checker itself ran. `npm run voice:install` downloads the on-demand weights. | `core/__tests__/wake-word.test.ts`, `core/__tests__/desktop-stt.test.ts`, `core/__tests__/voice-state.test.ts`, `core/__tests__/voice-human.test.ts`, `kernel/tests/test_wake_word.py`, `kernel/tests/test_voice_runtime.py` |
| Local engines | Ollama plus `LOCAL_ENGINES`: LM Studio, llama.cpp, vLLM, LocalAI, Jan (MLX-LM on macOS only). GGUF install does not require Ollama. | `core/__tests__/provider-registry.test.ts`, `core/__tests__/engine-control.test.ts`, `core/__tests__/model-sources.test.ts` |
| Cloud dispatch | `electron/models.cjs` `CLOUD`, `kernel/router.py`. Health probes use the same chat URL builder as live turns. Free-tier keys work without paid unlock. | `core/__tests__/provider-dispatch-contract.test.ts`, `core/__tests__/billing-firewall.test.ts` |
| Model routing | `electron/model-router.cjs` `selectEligible` is the ordered candidate list. `planRoute` explains that same list, returns a stable plan id and role steps, and names why each other model was dropped. Hard filters cover route mode, privacy, locality, provider, cloud opt-in, cost, cooldown, role, retired, capability, streaming, tools, vision, context, and name-only evidence. A private request stays on this PC. Private together with cloud-only leaves the pool empty. `qualityTarget` `balanced` keeps today's score. The other targets only adjust it, except private (hard local) and diverse (family interleave, no score change). Multi strategies are single, fallback, parallel, race, cascade, pipeline, primary-critic, primary-verifier, and candidate-judge. A cascade tries the cheaper model first. A race keeps the first successful answer. Outcome counts adjust the score after three trials and do not bypass a hard filter. Auto keeps one answer; a second opinion stays parallel until another strategy is chosen. Quality target and multi strategy use the existing settings button group. The Models catalog and provider cards show the official page and its age for the seven re-read sources. Sync now and Heal call the desktop host. A dry run builds a plan and does not call a model. HTTP 400 and 422 are not retried and do not cool the provider down. A 429 honours Retry-After. `kernel/router.py` re-checks route mode and privacy. The contract mirror is `src/lib/friday/model-routing-contract.ts`. The research record is in `docs/FRIDAY_PROVIDERS_AND_SECRETS.md`. | `core/__tests__/route-plan.test.ts`, `core/__tests__/provider-federation.test.ts`, `core/__tests__/knowledge-age.test.ts`, `kernel/tests/test_live_routing.py` |
| IPC version / prefs / workspace / voice / bridge | `app:version`, `prefs:get`, `workspace:get`, `voice:state`, `bridge:config` | `core/__tests__/window-ipc-parity.test.ts` |

### Flow Studio research (2026-10-06)

Recorded from public docs read that day. No new runtime dependency was added.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| `@xyflow/react` 12 custom nodes, `onlyRenderVisibleElements`, keyboard focus | ADOPT | Already installed (`^12.12.0`, MIT). Nodes stay memoized. Graphs over 80 boxes render only the viewport. Keyboard focus stays on. Source: reactflow.dev/learn/advanced-use/accessibility (read 2026-10-06) and the 12.8.5 note that fixed size plus handles can skip off-screen nodes (github.com/xyflow/xyflow/issues/3883). |
| elkjs 0.12.0 | REJECT | License is EPL-2.0 OR GPL-3.0-or-later. The swimlane layout in `flow-graph.ts` is one pass and stays inside the repo. Source: registry.npmjs.org/elkjs (read 2026-10-06). |
| dagre | REJECT | MIT, but the chart is already layered. A second layout library is not required. |
| Mermaid with `securityLevel: strict` | REJECT as a dependency | Mermaid 12 bundles ELK and the full script is large. `securityLevel: "loose"` plus `innerHTML` has been an XSS path (GHSA-wvh5-6vjm-23qh, read 2026-10-06). FRIDAY exports Mermaid text and imports only a simple flowchart, stored disabled, with no HTML. |
| n8n execution view, LangGraph interrupts, OpenTelemetry GenAI traces | ADAPT | The useful pattern is a read-only run, a scrubber, and an inspector. FRIDAY already has `TurnTrace` and `execution` stages. Replay never re-executes. A full OpenTelemetry exporter was not added. |
| Graph accessibility | ADOPT | The list view has the same ids as the canvas. Status is written (`ok`, `failed`, `locked`), not color alone. `prefers-reduced-motion` turns edge animation off. |

### Flow Studio depth (2026-10-06)

Same day, second pass. No new npm package. `@xyflow/react` 12.12.0 is the lockfile copy (MIT, registry.npmjs.org/@xyflow/react, updated 2026-09-24). On this machine `node_modules/@xyflow/react` is 1216196 bytes. Pro examples stay out: the Pro license covers those examples, not the MIT library (xyflow.com/pro-license, read 2026-10-06). Added dependency bytes: 0. Budget: no new package. Graphviz and the D2 compiler are not installed and are not Install Manager rows; this session did not pin an official Windows binary or its SHA-256. DOT and D2 leave as text.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Cytoscape.js, Sigma.js, AntV G6/X6, Rete.js, LiteGraph, Drawflow, vis-network, Apache ECharts, d3 | REJECT | A second canvas. Cytoscape.js is MIT (github.com/cytoscape/cytoscape.js, read 2026-10-06). The others were not adopted. Modes are projections of the one graph. |
| elkjs 0.12.0 | REJECT | Already recorded. EPL-2.0 text is the package license (cdn.jsdelivr.net/npm/elkjs@0.12.0/LICENSE.md, read 2026-10-06). Layout stays the in-repo swimlane. 1000 boxes measured 0.164 ms here. |
| bpmn-js | REJECT | The bpmn.io license requires the watermark to stay visible (bpmn.io/license, read 2026-10-06). It is not bundled. |
| n8n engine | REJECT | Sustainable Use License limits use and is not an OSI license (docs.n8n.io/privacy-and-security/sustainable-use-license and github.com/n8n-io/n8n/blob/master/LICENSE.md, read 2026-10-06). JSON import stays read-only, disabled, on the existing n8n page path. |
| Node-RED, tldraw, JointJS+, yFiles, Blockly, Excalidraw, XState, Monaco, CodeMirror, Ajv, react-jsonschema-form | REJECT | Not added. A second editor, state machine, or form library is not required. Option fields are a short list on the existing panel. |
| Mermaid, PlantUML, Graphviz WASM, D2 binary | REJECT as runtimes | Text export and a strict import stay in `flow-depth.ts`. No script is evaluated. |
| JSON Canvas, DOT, D2 text, SVG, PDF, PNG | ADOPT | Written by FRIDAY. PNG is a small schematic, not a screenshot of the window. PDF labels are ASCII. |
| OpenTelemetry SDK, LangGraph, Temporal | ADAPT | Local JSON trace is opt-in and redacted. No exporter process and no network. Replay stays read-only. |
| Coverage scan | ADOPT | `scripts/flow-registry.cjs` reads routes, preferences, packs, IPC, kernel decorators, and the eleven workflow files. The docs check fails when `flow-registry.gen.ts` drifts. |

### Flow Studio live (2026-10-06)

Third pass. The owner directive in AGENTS.md is the reason the earlier elkjs reject is replaced. Packages below were installed from the npm registry on this machine. Sizes are `du -sb` of `node_modules` here, not the packaged EXE.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| elkjs 0.12.0 | ADOPT, bundled | Layered layout with orthogonal edges. Auto-layout is a button. 8046232 bytes. Source: registry.npmjs.org/elkjs (read 2026-10-06). 1000 boxes laid out in 344 ms here. |
| ajv 8.20.0 | ADOPT, bundled | The code tab rejects invalid JSON before it replaces the graph. 1033496 bytes. Source: registry.npmjs.org/ajv (read 2026-10-06). |
| CodeMirror 6 (`@codemirror/view` 6.43.13, `state` 6.7.6, `language` 6.12.3, `lang-json` 6.0.2, `commands` 6.10.3) | ADOPT, bundled | The code tab. On-disk bytes: view 1258858, state 440367, language 309757, lang-json 10751, commands 243420. Source: registry.npmjs.org/@codemirror/view (read 2026-10-06). |
| `@viz-js/viz` 3.31.0 | ADOPT, bundled | DOT becomes SVG inside the app. 4994623 bytes. No separate wasm file in the package. Source: registry.npmjs.org/@viz-js/viz (read 2026-10-06). |
| Graphviz 16.1.0 Windows exe | ADOPT, Install Manager | `windows_10_cmake_Release_graphviz-install-16.1.0-win64.exe`, 8070590 bytes, SHA-256 `46f3b8b412a79915cf8e08bdce6542401bd9efca98ce282f3c5c5b56211e1761`, hashed here 2026-10-06. Source: gitlab.com/graphviz/graphviz release 16.1.0. |
| D2 0.9.0 Windows MSI | ADOPT, Install Manager | `d2-v0.9.0-windows-amd64.msi`, 15527936 bytes, SHA-256 `dbac13edaec26878d36c79c2bcd91d57927cae8878204e3b9816e6c0f32aae1b`, hashed here 2026-10-06. The vendor checksum file did not list the MSI. Source: github.com/terrastruct/d2/releases/tag/v0.9.0. |
| Cytoscape, Sigma, AntV, Rete, LiteGraph, Drawflow, Mermaid runtime, Monaco, Blockly, XState, bpmn-js, n8n engine | REJECT | A second canvas, editor, or workflow engine. Text import stays on the one graph. |
| OpenTelemetry exporter | REJECT | The recording stays the local event list. Replay does not call a step again. |

Binding coverage on the full map in this checkout: 1123 real wires, 515 descriptive wires, 1638 total. Route, option, capability, IPC, kernel, and workflow coverage stay 31/31, 102/102, 1013/1013, 433/433, 13/13, and 12/12. Before this pass a wire had no binding, so real bindings were 0.

### Flow Studio chat, voice, and diagrams (2026-10-06)

Fourth pass. No new npm or PyPI package. Added bytes: 0. Raster diagrams are read from local OCR boxes. A PNG may carry those boxes in a `tEXt` chunk named `friday-diagram`. A photograph with no boxes stays unread. Tesseract is already an Install Manager row and was not bundled again. A cloud vision call is not made by this reader.

Before this pass: a Chat/Manual chart of one turn was missing (the chat page showed the entry layer). Voice/Auto state mode was a generic chain. Explain-with-a-chart reached Flow Studio for a few phrases and did not sit on an ordinary message. Image upload said pixels were not read. D2 had export and no import. n8n and Node-RED import dropped edges and had no export.

After this pass: `flow-modes.ts` builds the chat turn from `turn-trace` and the voice chart from `voice-state`. `flow-diagram.ts` reads text diagrams through the existing importers and pictures from boxes. The chat chart button and Voice flow open that graph. Missing stages say "not recorded".

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| OpenTelemetry GenAI spans | ADAPT | A span is named from the operation and the model, and content capture stays opt-in because prompts can be sensitive. FRIDAY keeps `turn-trace` and `decision-trace`. No exporter. Source: opentelemetry.io/blog/2026/genai-observability (read 2026-10-06). |
| LangSmith Studio graph mode | ADAPT | The hosted IDE shows nodes a run traversed and can time-travel. FRIDAY already scrubs a recording without running it again. Source: docs.langchain.com/langsmith/studio (read 2026-10-06). |
| tesseract.js 7.0.0 | REJECT as a bundle | Apache-2.0, WASM, no PDF. The Install Manager already has a Tesseract row. A second OCR engine and its traineddata were not added. Source: registry.npmjs.org/tesseract.js (read 2026-10-06). |
| FlowExtract | REJECT | MIT research stack (YOLO, EasyOCR, Hough). It is not an offline npm package. Source: arxiv.org/abs/2604.06770 (read 2026-10-06). |
| draw.io uncompressed XML | ADOPT as a parser | Common editable export. Compressed diagrams are not inflated. Source: drawio.com/docs/manual/export/export-to-xml (read 2026-10-06). |
| LiveKit sequential voice pipeline | ADAPT | Stage names only: audio, VAD, STT, the model, TTS, and barge-in. LiveKit and Pipecat were not added. Source: livekit.com/blog/sequential-pipeline-architecture-voice-agents and docs.livekit.io/agents/models/pipelines (read 2026-10-06). |
| Visio importer | REJECT | Not verified as a format this checkout can parse. SVG and draw.io cover the pictures and files that were checked. |

On the fixtures in `core/__tests__/flow-studio-chat-voice.test.ts`: the clean stack matched 3 nodes and 2 edges with no uncertain box. The ambiguous stack matched 3 nodes, 0 edges, and 3 uncertain flags. Both fixtures matched. A cloud route is chosen only when the content is not sensitive, cloud is allowed, and the owner opted in. This session did not call a cloud vision model.

### Flow Studio photos, PDF, and honest lists (2026-10-06)

A PNG or JPEG with no embedded boxes is decoded on this PC. Dark rectangles and the lines that join them become the same graph. Words come from a Tesseract TSV when the desktop host can run Tesseract. A missing engine says it is not installed and does not throw. A picture with no rectangles stays unread. Uncertain boxes still block the forge. Sensitive pictures stay local. This reader still does not call a cloud model.

PDF export is pdf-lib 1.17.1 (MIT) with @pdf-lib/fontkit 1.1.1. Latin uses Helvetica. Devanagari uses the bundled Noto Sans Devanagari Regular face (SIL OFL 1.1, 243520 bytes, SHA-256 `4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313`). There is no node cap. Role colors are the canvas tokens. On-disk bytes in this checkout: pdf-lib 19495077, fontkit 4299890, standard-fonts 818507, jpeg-js 0.4.4 (Apache-2.0) 76029, fflate 0.8.2 (MIT) 773398, regenerator-runtime 0.14.1 (MIT) 27863, pako 788283 (pulled by pdf-lib), fonts folder 247906. A live wire shows the transferred count from the run, or an em dash when the run did not count. Reduced motion keeps a still marker. A wire that cannot act is marked not bindable and the reason is shown. Agents, Skills, Plugins, Workflows, and the browser preview no longer import sample HUD rows. An unmeasured machine says unknown.

The full map in this checkout is 1123 real wires, 516 descriptive wires, 1639 total. IPC coverage is 437/437 after models:sync-catalog, models:heal, and models:preview-route. Routes, options, capabilities, kernel, and workflows stay 31/31, 102/102, 1013/1013, 13/13, and 12/12.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| pdf-lib 1.17.1 | ADOPT, bundled | Multi-page PDF with a real font embedder. The hand-rolled one-page writer is gone. Source: registry.npmjs.org/pdf-lib (read 2026-10-06). |
| @pdf-lib/fontkit 1.1.1 | ADOPT, bundled | Shapes Devanagari. Needs regenerator-runtime before drawing. Source: registry.npmjs.org/@pdf-lib/fontkit (read 2026-10-06). |
| jpeg-js 0.4.4 | ADOPT, bundled | Decodes a JPEG screenshot in the renderer. Apache-2.0. Source: registry.npmjs.org/jpeg-js (read 2026-10-06). |
| fflate 0.8.2 | ADOPT, bundled | Inflates PNG pixels and PDF streams. MIT. Source: registry.npmjs.org/fflate (read 2026-10-06). |
| Noto Sans Devanagari Regular | ADOPT, bundled | Hinted TTF from notofonts, SIL OFL 1.1. Hindi round-trips. Source: github.com/notofonts/notofonts.github.io (read 2026-10-06). |
| tesseract.js | REJECT as a bundle | Already rejected. The existing Install Manager Tesseract row is the engine. |

### Voice and Auto research (2026-10-05)

Recorded from public docs and write-ups read that day. This is not a second plan.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Adaptive endpointing on top of VAD | ADOPT | A pause is not always the end of a turn. The existing energy VAD stays. Incomplete transcripts wait longer, and the wait is capped. Sources: LiveKit turn detection (docs.livekit.io/agents/logic/turns/), Pipecat endpointing notes (github.com/ultradyn/hark/blob/master/docs/ENDPOINTING.md). |
| Smart Turn v3.2 ONNX | ADOPT | BSD-2-Clause file `smart-turn-v3.2-cpu.onnx`, 8679182 bytes, sha256 `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f` (hashed 2026-10-05). A score under 0.5 may extend the pause. It never shortens the text heuristic. A missing file does not cut the owner off. Source: huggingface.co/pipecat-ai/smart-turn-v3. |
| Browser echo cancellation and local playback | ADOPT | Chromium already applies echo cancellation on the one capture graph. Local Supertonic audio plays through that same page audio element, so the graph has a reference. webrtc-noise-gain 1.3.0 was not added: its wheels are manylinux only and it is noise suppression plus gain, not echo cancellation. Source: Chromium audio processing (chromium.googlesource.com/chromium/src/+/908b4d711959fc95a3bf2d2c6c08110af529d6b0/media/base/audio_processing.h). Accessed 2026-10-05. |
| openWakeWord cooldown | ADAPT | The library's debounce avoids a second fire of the same name. FRIDAY applies that on the transcript path. Pretrained models stay CC BY-NC-SA; no new model. Source: github.com/dscripka/openWakeWord. |
| Hinglish on the existing worker | ADAPT | No separate fine-tune file. Hindi and mixed speech stay on faster-whisper, which auto-detects hi/en. A measured GPU and 16 GB or more selects large-v3; 16 GB without a GPU selects medium; battery steps those back to small. Supertonic uses `na` when one line mixes Devanagari and Latin. Non-English Moonshine weights print a non-commercial community license and are not downloaded. Source: github.com/SYSTRAN/faster-whisper (MIT). Accessed 2026-10-05. |
| Speaker verification as a lock | REJECT | Moonshine diarization weights are published under a community path and were not installed. A missing voiceprint does not block ordinary speech. A low similarity on a sensitive line can refuse that line, and `execute` stays false. Desktop approval remains the lock. Sources: speechbrain.readthedocs.io speaker inference; arxiv.org/pdf/2109.09598. Accessed 2026-10-05. |
| Voice must not grant exec | ADOPT | Untrusted speech cannot disable approval or confirm a long injected sentence. Sources: OWASP LLM Top 10 2025 (owasp.org LLM01 and LLM06); OWASP AI Agent Security cheat sheet. |
| Quiet hours, kill switch, yield | ADOPT | Tray pause is the kill switch. Quiet hours and an owner who is talking defer a background notice. An owner turn still gets its reply. Quiet hours already live in Settings. Source: interruption-policy write-ups from 2026 on proactive assistants (efe-genc-portfolio.vercel.app/writing/knowing-when-not-to-speak/). |
| Streaming partials on the one worker | ADOPT | Whisper segments emit a `stream` line before the final line. Moonshine tiny-streaming (MIT, moonshine-voice 0.1.5) is used only for an English preference when `models/moonshine-en` is already on disk. It is not a second capture path. Source: pypi.org/project/moonshine-voice/. Accessed 2026-10-05. |
| kokoro-onnx 0.6.1 as the local voice | REJECT | Package license is MIT and the wheel is `py3-none-any`, but it requires phonemizer, whose PyPI license is GPL-3. Accessed 2026-10-05: pypi.org/pypi/kokoro-onnx/json and pypi.org/pypi/phonemizer/json. |
| piper-tts 1.8.0 | REJECT | PyPI license is GPL-3.0-or-later. Windows wheels exist. A `>=` floor would install that GPL release. Accessed 2026-10-05: pypi.org/pypi/piper-tts/json. |
| sherpa-onnx 1.13.8 | REJECT | The project license is Apache-2.0 and Linux/Windows wheels install with `--only-binary`. The installed `libsherpa-onnx-c-api` contains espeak-ng (GPL-3). Accessed 2026-10-05: pypi.org/pypi/sherpa-onnx/json and the wheel strings. |
| silero-vad 6.2.3 pip package | REJECT | It requires torch. Accessed 2026-10-05: pypi.org/pypi/silero-vad/json. |
| Silero VAD ONNX via onnxruntime | ADOPT | The file `silero_vad.onnx` in snakers4/silero-vad is MIT, 2327524 bytes, sha256 `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3` (hashed 2026-10-05 from the master raw file). Install Manager downloads it. A missing file keeps the energy VAD. A silent 512-sample window scored 0.000592 and was not speech. Source: github.com/snakers4/silero-vad. |
| Supertonic 3 local speaker | ADOPT | Package supertonic 1.3.1 is MIT code. Weights are OpenRAIL-M (use limits, not GPL). Voice F2. CPU. `auto_download` is false until the voice install script or Install Manager fetches the repo. A missing model keeps the system voice. Source: pypi.org/project/supertonic/ and huggingface.co/Supertone/supertonic-3. Accessed 2026-10-05. |
| pyrnnoise | ADOPT | Apache-2.0, Windows wheels exist. It denoises PCM before the same worker. If the import or the decode fails, the original file is transcribed. Source: pypi.org/project/pyrnnoise/. Accessed 2026-10-05. |
| Renderer capture path | ADOPT | One `getUserMedia` graph already requests echo cancellation, noise suppression, and automatic gain. Device changes reopen with a cap of six tries. A second kernel capture path was not added. |
| DirectML or CUDA wheel swap | ADAPT | onnxruntime already selects CUDA or DirectML when that provider is installed, and CPU remains the fallback. `onnxruntime-directml` is an Install Manager manual row only. It is not in `requirements-capabilities.txt`, because that wheel replaces the CPU package. |
| Ducking other applications | ADOPT | The Settings toggle uses the existing switch. Ducking is on only while FRIDAY speaks and quiet hours are off. Linux returns unsupported. The Windows session change is unverified on this machine. |
| Gemini Live, ChatGPT voice, Claude voice | ADAPT | Accessed 2026-10-05. Gemini Live interrupts and can switch languages (support.google.com/gemini/answer/15274899, blog.google Gemini 3.8 Live). ChatGPT Live listens and speaks together (help.openai.com/en/articles/20001274). Claude voice is turn-based and can use connected tools (support.claude.com/en/articles/11101966-use-voice-mode). FRIDAY keeps one local capture path, barge-in, and a speculative start on a stable partial. Camera and screen sharing during voice stay out. |
| Piper and Kokoro as the default speaker | REJECT | Accessed 2026-10-05. piper-tts on PyPI is GPL-3.0-or-later (github.com/OHF-Voice/piper1-gpl). kokoro-onnx still pulls a GPL phonemizer. Supertonic is the permissive local speaker already on the path. Copyleft speech stays optional and is not installed. |
| WeSpeaker ECAPA ONNX | ADAPT | Accessed 2026-10-05. Code is Apache-2.0. VoxCeleb weights are CC-BY-4.0 (wenet-e2e.github.io/wespeaker/pretrained.html). The file is not downloaded. A saved embedding would live in the desktop safe store. A missing voiceprint does not block speech and never approves an action. |
| Call pause | ADOPT | Teams, Zoom, Webex, and Skype names pause listening and hold briefings. Off Windows the check returns unsupported and does not spawn. The Windows process list is unverified. |
| Plan, act, verify, report | ADOPT | Standing orders, a step budget, undo for a reversible step, and "stop everything" live in the existing Auto path. Orders and the undo journal are written with the existing state store and come back after a restart. The step budget starts over. Exec, spend, messages, and destructive steps wait for the desktop. A running tool step says "Opening it." A measurement does not. |

Gap against the interaction plan, after this change: Auto listen/speak, barge-in, sentence speech, wake matching, adaptive silence, confirmation binding, fault recovery, health states, Silero-when-present, Supertonic-when-present, Smart Turn extend-only, English Moonshine-when-present, cloud-speech gating, clarify/continue/backchannel, speculative partials, standing orders that survive a restart, a short tool line, and the offline eval are in code and tests. A calibrated speaker-embedding model was not installed. Echo cancellation is the existing Chromium graph plus local playback, not a separate AEC library. Camera and screen context during voice stay out. File, folder, and calendar triggers are not built. Mobile and remote sessions stay in the plan. The interaction plan is not deleted.

### Chat and manual research (2026-10-05)

Recorded from public docs read that day. This is not a second chat product. Manual and chat stay typed and silent.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Stop keeps the words already shown | ADOPT | A streaming reply can be aborted, and the text that already arrived stays. An empty stop is one line. Source: developers.openai.com/api/docs/guides/streaming-responses. Accessed 2026-10-05. |
| Match the language of the last message | ADOPT | ChatGPT, Claude, and Gemini follow the language the person just used. FRIDAY does that on typed turns when reply language is follow-user. A standing English, Hindi, or Hinglish setting stays. Source: bootstrapcreative.com/chatgpt-vs-claude-vs-gemini-terminology/. Accessed 2026-10-05. |
| Ollama tool loop on the existing chat path | ADOPT | `/api/chat` accepts the same function tools, streams content separately from thinking, and takes a follow-up tool message with `tool_name` and object arguments. FRIDAY runs that loop for the read-only tools already offered to OpenAI-compatible and Anthropic streams. Sources: docs.ollama.com/api/chat and docs.ollama.com/capabilities/tool-calling. Accessed 2026-10-05. |
| Show a lookup beside the answer | ADAPT | Claude and ChatGPT surface tool activity next to the reply. FRIDAY names the lookup in the existing conversation header. It is not a second pane. Source: support.claude.com/en/articles/11101966-use-voice-mode. Accessed 2026-10-05. |
| Side canvas or artifacts | REJECT | ChatGPT Canvas, Claude Artifacts, and Gemini Canvas are a second writing surface. That pane is not built. The transcript stays the one chat. Source: bootstrapcreative.com/chatgpt-vs-claude-vs-gemini-terminology/. Accessed 2026-10-05. |
| Import another product's account memory | REJECT | Each assistant keeps its own memory with different rules. FRIDAY memory stays on this PC. Sources: support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context and blog.memoryplugin.com/claude-vs-chatgpt-vs-gemini-memory/. Accessed 2026-10-05. |
| Web search as a model tool | REJECT | The read-only model tools stay the existing file, device, and network lookups. Search stays off that list. |
| Microphone or speech in chat | REJECT | Manual and chat stay typed. Auto still owns the microphone and spoken replies. |

### Web search ladder (2026-10-10)

Keyed search runs before HTML scraping. A secret never becomes a query. A captcha page is a failed attempt.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Brave Search API | ADAPT | `GET https://api.search.brave.com/res/v1/web/search` with `X-Subscription-Token`. Plans include monthly credits and are not a standalone free tier, so the call runs only when the owner stored a key. The key stays out of the URL. Sources: api-dashboard.search.brave.com/api-reference/web/search/get and api-dashboard.search.brave.com/app/help-feedback (read 2026-10-10). |
| Loopback SearXNG | ADOPT | `GET /search?q=&format=json` on a base the owner set. Only `127.0.0.1`, `localhost`, or `::1` is accepted. A public instance is not called. Source: docs.searxng.org/dev/search_api (read 2026-10-10). |
| HTML result pages | ADAPT | DuckDuckGo, Bing, Brave, and the other HTML engines stay the last resort. A page that looks like a captcha falls through. |
| Reader text | ADOPT | A fetched page keeps the article or main text, drops scripts and navigation, and caps the quote. The text is data. |

### Chat and voice continuity (2026-10-09)

Same session for typed and spoken turns. A typed turn keeps the typed guide while Auto is listening. A live talk is restored after restart. A new chat stays sealed until the owner asks to continue it. One finalized utterance is dispatched once. A replaced answer speaks the new text. Finished task steps are not replayed from a follow-up. "Change that" edits the current item. No new speech engine.

| Topic | Decision | Why, for FRIDAY |
| --- | --- | --- |
| Realtime semantic turn detection | ADAPT | An unfinished utterance waits, including a Devanagari continuation, and a second copy of the same final transcript is dropped. The Realtime API is not added. Source: developers.openai.com/api/docs/guides/realtime-vad (read 2026-10-09). |
| Realtime interruption | ADAPT | Stopping speech keeps the text already produced. A shortened answer restarts the spoken cursor on the replacement. No server truncate event. Source: developers.openai.com/api/docs/guides/realtime-conversations (read 2026-10-09). |
| One conversation across modes | ADOPT | Chat and Auto already share Core Brain, the session, and the task graph. This pass stops a second observation from writing that session again. |

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
| Desktop loop | `src/lib/friday/self/computer-use.ts`, `src/lib/friday/self/task-graph.ts`, `kernel/control.py` | `core/__tests__/computer-use.test.ts`, `core/__tests__/task-graph.test.ts`, `kernel/tests/test_desktop_tools.py` |
| Free now | `electron/model-router.cjs` `freeNowBoard`, `kernel/router.py` `free_now_entry` | `core/__tests__/usable-models.test.ts`, `kernel/tests/test_router_free_now.py` |
| Turn packet | `src/lib/friday/brain/memory-policy.ts` `packTurnContext` | `core/__tests__/turn-context.test.ts` |
| Life offers | `src/lib/friday/assistant-conduct.ts` `considerLifeTrigger` | `core/__tests__/assistant-conduct.test.ts` |
| MCP scope | `electron/mcp-protocol.cjs`, `electron/mcp-server.cjs`, `electron/mcp-client.cjs` | `core/__tests__/mcp-platform.test.ts`, `core/__tests__/mcp-threat.test.ts`, `core/__tests__/mcp-client.test.ts` |

### Desktop autonomy research (2026-10-07)

Recorded once. Real Windows clicks, a full UI Automation tree, and live provider calls were not run here.

| Finding | Decision | Why |
| --- | --- | --- |
| UI Automation control view and content view | ADOPT | Structured controls come before OCR and before a vision model. Perception carries source, confidence, and freshness. Source: learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview (read 2026-10-07). |
| Prompt-injection controls outside the prompt | ADOPT | Screen text, files, and tool output stay data. The plan is parsed from the owner's words. A credential, payment, captcha, or secure-desktop prompt is handed over. Source: cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html (read 2026-10-07). |
| UFO2 hybrid detection (UIA, then vision) | ADAPT | The same order, on the existing desktop loop. A vision-only view stops and asks. Source: microsoft.com/en-us/research/publication/ufo2-the-desktop-agentos/ and microsoft.github.io/UFO/ufo2/core_features/control_detection/hybrid_detection/ (read 2026-10-07). |
| Hosted vision-first desktop agents | REJECT | They skip the local-first path and the in-app autonomy dial. |
| Durable orchestration replay | ADAPT | Checkpoint, idempotent steps, and bounded retry stay on the existing task graph. Source: learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations (read 2026-10-07). |
| A second workflow host | REJECT | One task graph is the durable run. |
| MCP stdio, and HTTP bound to loopback | ADOPT | The 2026-07-28 layer is shared. Tool text is untrusted. Detail: `docs/FRIDAY_MCP.md`. |
| A hosted MCP endpoint | REJECT | A public URL is refused. OpenAPI import uses the same loopback rule and the existing read/exec split. |
| Free-now source and age | ADOPT | `freeNowBoard` reads the access record the router already stores. A price changes only when `commitParsedKnowledge` accepts a parsed page. A miss leaves the last table, which still fails closed after 14 days. |
| UI Automation physical bounds | ADOPT | `BoundingRectangle` is physical pixels. The normalizer maps every monitor into one 96-DPI desktop. A secure or credential window returns a handoff and no tree. Source: learn.microsoft.com/en-us/windows/win32/winauto/uiauto-screenscaling (read 2026-10-07). |
| comtypes for the live walker | ADOPT | MIT, optional Windows extra, floor `comtypes>=1.4.0` in `kernel/requirements-capabilities.txt`. Install Manager can install it. The kernel boots without it. Source: github.com/enthought/comtypes (read 2026-10-07). The live walker was not run here. |
| Reading a secure desktop with OCR | REJECT | A handoff stops the ladder. Pixel text of a credential or User Account Control prompt is not captured. |
| Control patterns before the mouse | ADOPT | Invoke, Toggle, SelectionItem, ExpandCollapse, Value, and Scroll run when the fresh tree still shows them. A missing pattern falls back to `input.*`. A disabled control and a control on the unfocused window are refused. Source: learn.microsoft.com/en-us/windows/win32/winauto/uiauto-controlpatternsoverview (read 2026-10-07). The live pattern call was not run here. |
| Yield the pointer while the owner is active | ADAPT | A write yields, and an expired lease does not act. A read stays in the background. A second remote-desktop session was not added. Source: microsoft.github.io/UFO/ufo2/overview/ (read 2026-10-08). |
| Name the relaxed check | ADAPT | A vision, OCR, or empty view tells the owner the success check was relaxed. API and UI Automation stay ahead of that view. A multi-agent research ladder was not added. Source: microsoft.github.io/UFO/ufo2/overview/ (read 2026-10-08). |
| Phone cursor gap refreshes before another write | ADAPT | A gap or an unknown outcome blocks a duplicate write until the desktop snapshot is current. Push is not a second task store. A second WebRTC voice path was not added. Source: developer.mozilla.org/en-US/docs/Web/API/WebRTC_API (read 2026-10-08). |
| Restart keeps an in-flight run | ADOPT | A reload does not cancel the row. A checked step is not replayed. An unchecked step, or a changed world, is checked again before it counts. Ask and Balanced wait. Full continues only when that dial is on and stop-everything is off. Source: learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations (read 2026-10-07). |
| Run timeline on the existing receipt | ADOPT | Each step keeps source, confidence, age, the postcondition, the undo hint, and a handoff reason. Passwords, tokens, and images are dropped. No screenshot is stored. Source: cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html and learn.microsoft.com/en-us/azure/durable-task/durable-functions/durable-functions-serialization-and-persistence (read 2026-10-07). |
| A second canvas or a screenshot log | REJECT | The Tasks page reads the same receipt. A picture of the desktop is not kept. |
| Owner-started senses on the existing watcher | ADOPT | Foreground, folder, idle, lock, power, network, and calendar stay off until a Settings switch is on. A folder event is kept only inside an approved path. The text is data. Source: learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook (read 2026-10-07) and the existing `electron/watcher.cjs` stack. Live Windows session hooks were not run here. |
| A listener that starts by itself | REJECT | Covert watching is not a sense. Off is the fresh state, and the watching line says so. |
| Brief from facts already on this PC | ADOPT | Morning and evening text uses standing orders, calendar titles, and the open-task count. Quiet hours and the existing offer budget still hold. The same sense text is not offered twice. Source: the life-offer gate in `src/lib/friday/assistant-conduct.ts` (checked 2026-10-07). |
| Demonstration into the existing canvas | ADOPT | Consent is required. A password, payment, or secret step is omitted. The remaining steps are one untrusted graph and replay through the desktop loop. Source: cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html (read 2026-10-07). A live Windows recording was not run here. |
| Page tree before pixels | ADOPT | A page is read as DOM or accessibility nodes. Text is data. A password, payment, or captcha control is a handoff with no content. A site acts only when its host is on the allow list. Source: chromedevtools.github.io/devtools-protocol/tot/Accessibility/ (read 2026-10-07). A live page was not driven here. |
| Pixel-first browsing | REJECT | A screenshot is not the first way to see a page, and it is not stored. |
| Daily playbooks as workflow packs | ADOPT | Organize, summarise, meeting notes, a draft, a send, a day plan, and one hisab line live in the existing workflow pack. A move has an undo. A send is a write and does not approve itself. Nothing deletes. Source: the workflow.json pack shape already used by `workflows/saved` (checked 2026-10-07). |
| Rate-limit headers on the response that already returned | ADOPT | Remaining requests and tokens are copied from `x-ratelimit-*` or `anthropic-ratelimit-*`. No second call is made. Source: developers.openai.com/api/docs/guides/rate-limits and platform.claude.com/docs/en/api/rate-limits (read 2026-10-07). A live keyed call was not run here. |
| A separate quota endpoint | REJECT | The meter is the headers on the chat response. A probe that exists only to ask "how much is left" is not added. |
| Hub model list as data | ADOPT | A list the caller already holds becomes cards. Private and gated repos are counted and not shown. Weights are not downloaded. Source: huggingface.co/docs/hub/api (read 2026-10-07). A live Hub fetch was not run here. |
| llama.cpp Windows CPU zip b11243 | ADOPT, Install Manager | MIT. `llama-b11243-bin-win-cpu-x64.zip`, 19161151 bytes, SHA-256 `29f91327f4e98fcac93e3b44e6cc54beda26468eb9ffeb804a08cfa67bda8c5b`, hashed here 2026-10-07. A zip is unpacked. It is not executed. CUDA and DirectML builds are not this pin. Source: github.com/ggml-org/llama.cpp/releases/tag/b11243. A live Windows install was not run here. |
| Memory export keeps source and age | ADOPT | The existing store already consolidates, remembers, forgets, and backs up. An export blanks credential text and stamps source and age. Profile fields enter the turn only when the ask matches, with unknown age until a time is stored. Source: cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html (read 2026-10-07). |
| A separate evaluator for a self-change | ADOPT | The proposer only files a discovery. A second function refuses every protected policy file, asks unless the dial is Full, and never marks the change applied. Source: the existing governance gate in `src/lib/friday/self/governance.ts` (checked 2026-10-07). |
| Practice band on the existing learning engine | ADOPT | A held-out task and a candidate that would score itself do not become practice. Repeated synthetic practice does not climb a band. The intelligence benchmark calls that gate and still files a code change as discovery only. Source: `src/lib/friday/self/learning-engine.ts` (checked 2026-10-08). An open-ended skill search was not added. |
| Untrusted text from screen, page, file, calendar, and tools | ADOPT | The same hostile line stays data. A password assignment is blanked. A hosted tool URL is refused. Source: cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html (read 2026-10-07). |
| Electron powerMonitor for lock, power, and idle | ADOPT | `lock-screen`, `unlock-screen`, `suspend`, `resume`, `on-battery`, and `on-ac` plus `getSystemIdleTime()` are the live signals. They subscribe only while that Settings switch is on. Source: electronjs.org/docs/latest/api/power-monitor (read 2026-10-07). The live Windows hook was not run here. |
| Foreground caption via GetForegroundWindow and GetWindowText | ADAPT | A bounded poll reads the window caption only. It does not read keystrokes or pixels. A native event hook is not added. Source: learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow and learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowtextw (read 2026-10-07). The live poll was not run here. |
| Clipboard while a password manager is in front | REJECT | The clipboard is not read, stored, or emitted when the front window is a password manager. |
| Automatic calendar fetch | REJECT | Calendar titles come from a file already on this PC. The sense does not call a connector. |
| Re-check the host after a navigation | ADOPT | A click is refused when the page that is open is not on the allow list, even if the owner opened an allowed host. A stale tree is not acted on. Source: cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html (read 2026-10-07). A live page was not driven. |
| Stop everything before the next replay step | ADOPT | The kill switch is read again before each watched step. A step that already finished stays in the evidence. The next step does not run. Source: the halt flag in `src/lib/friday/self/computer-use.ts` (checked 2026-10-07). |
| A cyclic UI Automation tree and a node budget | ADOPT | A parent that points at itself ends that branch. The walk stops at the node and time budget. The clock in the test is injected. Source: learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview (read 2026-10-07). A live Windows walk was not run. |
| IsPassword, off-screen, and an elevated window | ADOPT | A password value is omitted. A disabled or off-screen control is not clicked. An elevated window is a handoff with no tree. Source: learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-getcurrentpropertyvalue (property IsPassword, read 2026-10-07). |
| comtypes missing falls back to OCR | ADAPT | Perception tries the existing OCR path and says why. A pattern action still fails closed. COM startup is paired with cleanup. Source: github.com/enthought/comtypes (read 2026-10-07). The live fallback was not run. |
| Optional WeSpeaker ECAPA speaker score | ADOPT | CC-BY-4.0. The file is not bundled and was not downloaded here, so no hash is pinned. A missing file is not a match, and a match never executes. Source: github.com/wenet-e2e/wespeaker (model card license CC-BY-4.0, read 2026-10-07). |
| DirectML in place of the CPU provider | REJECT | A session may list DirectML and then CPU. CPU is never removed. |
| Self-voice while FRIDAY is speaking | ADAPT | The browser echo constraint stays. A frame that matches the playback is dropped. A different frame can barge in. A live microphone was not used. |
| Backup before a schema change, then an atomic publish | ADOPT | `Connection.backup()` copies the database before new columns are added. A JSON version change is written to a temporary file and renamed. A full disk, a denied write, or a cut-off write leaves the previous file, and a corrupt file restores the backup. Source: docs.python.org/3/library/sqlite3.html (`Connection.backup`, read 2026-10-07) and nodejs.org/api/fs.html (`renameSync`, read 2026-10-07). A live disk-full on Windows was not run. |
| Copying a live database with a plain file copy | REJECT | A hot SQLite file is not copied with a filesystem copy. The backup API is the copy. A second backup product is not added. |
| Injected faults for crash, 429, clock, and idle | ADOPT | The kernel crash mark, a provider 429, a clock jump, and the startup and idle budgets are tested with an injected clock. A spoken yes still expires. Offline mode keeps chat, tasks, memory, and a local model, and it does not open a cloud call. Source: docs.python.org/3/library/sqlite3.html (read 2026-10-07). A live kernel crash was not run. |
| One local morning brief and one evening review | ADAPT | The brief uses standing orders, calendar titles, and open tasks already on this PC. Sense text stays an offer under the same budget. The evening line lists what finished, what is waiting, what was undone, and tomorrow. A missed day, a lock, or a saved cursor does not repeat a brief. Source: github.com/aitne-sh/aitne (local evening review, read 2026-10-07). |
| A second day scheduler or a hosted briefing | REJECT | The Tasks page reads the same ledger. No new timer, daemon, or hosted brief is added. |
| One System panel for senses, listeners, and recorders | ADOPT | Each row shows on or off, the last sense time, and the last receipt. Panic is stop-everything plus every sense off. Hands-free still starts off and needs the wake word again. Source: the kill switch in `src/lib/friday/self/autonomy.ts` (checked 2026-10-07). |
| A new settings page for that panel | REJECT | The rows live on the existing System settings page. The sidebar is unchanged. |
| Secret text stays out of a receipt, a digest, and an export | ADOPT | A password assignment is blanked before it is shown or exported. Hostile words stay data and do not become a plan. A hosted tool URL is still refused. No new runtime dependency was added in this pass. Source: cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html (read 2026-10-07). |

## Wave 4 — voice that installs, and a mind that stays local

Checked 2026-10-07. The area plans were absorbed. The change gate lives in `docs/FRIDAY_CHANGE_CONTROL.md`. Live Windows microphone, wake word, pip, model download, TTS audio, the packaged EXE, and hosted Actions were not run here.

### Plan table

| Idea | Source file | Status | Decision | Step |
| --- | --- | --- | --- | --- |
| One Install Manager, health probe before "working" | `src/lib/friday/voice-doctor.ts` | PARTIAL | ADOPT | 4–6, 12 |
| Diagnostic path device to playback, smallest local repair | `src/lib/friday/voice-recovery.ts` | PARTIAL | ADOPT | 9–12 |
| Do not mark voice connected from UI state alone | same diagnostics file | PARTIAL | ADOPT | 11–12 |
| Barge-in and one microphone | `src/lib/friday/voice-session.ts` | PARTIAL | ADAPT | 9, 13 |
| Wake, device, and display stay on the existing voice page | `src/lib/friday/voice-state.ts` | PARTIAL | ADOPT | 10, 12 |
| Failure recovery without a second planner | `src/lib/friday/voice-recovery.ts` | PARTIAL | ADOPT | 11, 33 |
| Input trust boundary | `src/lib/friday/self/governance.ts` | PARTIAL | ADOPT | 31, 35 |
| Memory contract, one store | `src/lib/friday/self/memory-engine.ts` | DONE | ADOPT | 20, 25, 27 |
| Selective context | `src/lib/friday/brain/context-engine.ts` | DONE | ADAPT | 24, 26 |
| Evaluation without a hosted scorer | `src/lib/friday/self/run-receipt.ts` | DONE | ADOPT | 34 |
| Mobile companion | `src/lib/friday/companion-live.ts` | DONE | ADAPT | cursor |
| A second installer or a second speech engine | voice install note above | MISSING | REJECT | — |

### Research (2026-10-07)

| Finding | Decision | Reason |
| --- | --- | --- |
| faster-whisper loads a CTranslate2 model through the Hub cache. `download_root` and `local_files_only` are the local controls. | ADOPT | Listening starts on `base`, then `small`, with a shorter budget for the small sizes. Weights stay on demand. Source: github.com/SYSTRAN/faster-whisper (read 2026-10-07). |
| Converting weights with torch | REJECT | The voice-stack rule already refuses torch. |
| `NotReadableError` is not always "another application". Exclusive mode, a second capture, privacy, and a driver can report the same name. | ADOPT | The classifier separates FRIDAY's own track, a named call process, and the exclusive-mode case, then retries relaxed constraints. Sources: blog.addpipe.com/common-getusermedia-errors/ and electron/electron#25966 (read 2026-10-07). A live Windows microphone was not used. |
| Hugging Face Hub resume and `HF_ENDPOINT` | ADOPT | The existing downloader classifies DNS, TLS, proxy, disk, auth, and cancel, and honours an https mirror. Source: huggingface.co/docs/huggingface_hub/guides/download (read 2026-10-07). A live download was not run. |
| Prompt injection stays outside the prompt | ADOPT | Transcripts, phrase lines, memory notes, and research text are data. A password assignment is blanked. Source: cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html and the OWASP LLM Top 10 2025 (read 2026-10-07). |
| A second memory store, a second scheduler, piper as the runtime, or a new sidebar row | REJECT | The existing memory store, Tasks ledger, and Voice settings page stay the owners. piper stays blocked because the manual text says FRIDAY does not install it. |

## Wave 5 — a voice runtime that can install itself

Checked 2026-10-08. The area plans were absorbed. The change gate lives in `docs/FRIDAY_CHANGE_CONTROL.md`. A simulated clean PC is the proof that runs here. Live Windows microphone, wake word, the Python bootstrap, pip, a model download, TTS audio, the packaged EXE, and hosted Actions were not run.

### Plan table

| Idea | Source file | Status | Decision | Step |
| --- | --- | --- | --- | --- |
| Spoken failure names the cause, in the owner's language | `src/lib/friday/voice-recovery.ts` | PARTIAL | ADOPT | 4 |
| Retry when install, the model, the device, focus, or Fix voice is ready | `src/lib/friday/voice-recovery.ts` | PARTIAL | ADOPT | 5 |
| One speech-size plan, then a local load | `src/lib/friday/voice-flow.ts` | PARTIAL | ADOPT | 6 |
| Weights fetched before the worker, with a hash where one is pinned | `src/lib/friday/voice-pack.ts` | PARTIAL | ADOPT | 6 |
| Think, a short offer, sight, and the eval set sit on the live path | `src/lib/friday/self/run-receipt.ts` | DONE | ADOPT | 7 |
| A Windows PC with no system Python and no WinGet still gets a runtime | `src/lib/friday/voice-doctor.ts` | PARTIAL | ADOPT | 8–9 |
| A clean-PC script covers bootstrap through resume | same install note | PARTIAL | ADOPT | 10, 26 |
| Headset profile, hot-plug, sleep, and a stuck track reopen capture | `src/lib/friday/voice-state.ts` | PARTIAL | ADAPT | 11 |
| Wake energy against a room floor | same device note | PARTIAL | ADAPT | 12 |
| Echo stays in the browser constraint; playback can duck other apps | `src/lib/friday/voice-session.ts` | PARTIAL | ADAPT | 13 |
| Neural, then local, then the system voice | `src/lib/friday/voice-pack.ts` | PARTIAL | ADOPT | 14 |
| One self-test list and an owner checklist on the existing Voice page | diagnostics note above | PARTIAL | ADOPT | 15, 31 |
| Hinglish numbers, names, and a weak-confidence repeat | `src/lib/friday/voice-stt.ts` | PARTIAL | ADOPT | 17–18 |
| Distress points at iCall or AASRA and does not diagnose | `src/lib/friday/brain-engine.ts` | DONE | ADOPT | 19–21 |
| Voice stays on a short think budget; chat may take more steps | `src/lib/friday/brain/context-engine.ts` | DONE | ADAPT | 22–25 |
| A native WASAPI echo canceller | barge-in note above | MISSING | REJECT | — |
| The silero-vad pip package | voice-stack rule | MISSING | REJECT | — |
| The official embeddable zip as the runtime | install note above | MISSING | REJECT | — |

### Research (2026-10-08)

| Finding | Decision | Reason |
| --- | --- | --- |
| `install_only` is a relocatable CPython archive. Windows builds follow the official Windows floor. | ADOPT | A PC with no system Python and no WinGet can still create the runtime. py and WinGet stay the second path. Source: https://docs.astral.sh/python-build-standalone/running/ (read 2026-10-08). |
| CPython 3.12.15+20261003 Windows x64 `install_only` tar.gz | ADOPT, Install Manager | PSF-2.0 for the interpreter. 46509797 bytes. SHA-256 `4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08`. Downloaded into the runtime folder. Not bundled in the installer. The build scripts of that project are MPL-2.0 and are not vendored. Source: https://github.com/astral-sh/python-build-standalone/releases/download/20261003/cpython-3.12.15%2B20261003-x86_64-pc-windows-msvc-install_only.tar.gz (checksum file read 2026-10-08). A live Windows extract was not run. |
| Official embeddable CPython zip as the voice runtime | REJECT | It is not the venv layout this runtime already creates. `install_only` is the voice runtime. The zip stays an additional Install Manager row. |
| `WhisperModel` downloads from the Hub unless `local_files_only` is set or the argument is a directory. | ADOPT | The app downloader runs first. The worker then opens that folder and does not fetch. Source: https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/transcribe.py (read 2026-10-08). A live download was not run. |
| Hugging Face still copies into the default hub cache when `download_root` is set on some versions. | ADAPT | The app downloader writes the snapshot under the FRIDAY cache. The worker is not the client that fills that cache. Source: https://github.com/SYSTRAN/faster-whisper/issues/181 (read 2026-10-08). |
| Bluetooth HFP capture is 8 kHz or 16 kHz mono. A2DP is the media profile. Opening the microphone switches the headset. | ADAPT | A profile change reopens capture at 16000 or 48000. Shared mode stays. Exclusive mode is a failure the owner can hear. Source: https://learn.microsoft.com/en-us/windows-hardware/drivers/bluetooth/bluetooth-classic-audio (read 2026-10-08). A live headset was not used. |
| WASAPI exclusive mode refuses a shared open. | ADAPT | The existing classifier already separates that case. A native loopback canceller is not added. Source: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording (read 2026-10-08). |
| openWakeWord's included models start near a 0.5 score, and a room should be tuned on its own noise. | ADAPT | The threshold moves with a local energy floor. Audio samples are not stored. The silero-vad pip package stays forbidden. Source: https://github.com/dscripka/openWakeWord (read 2026-10-08). A live wake word was not run. |
| A second speech engine, torch, or a new sidebar row | REJECT | The existing Install Manager, Doctor Voice rows, and Voice settings page stay the owners. |

### Owner checklist

Run these on the Windows PC, in order. Copy the Voice rows and the on-screen status if one fails. Do not send a recording.

1. Open Doctor and run the voice self-test. Each layer should say pass or the failing cause.
2. Say the wake word, then one sentence, and wait for a spoken reply.
3. Hold a 3-turn conversation.
4. Start talking while FRIDAY is speaking. She should stop and listen.
5. Disconnect the network mid-reply. Speech should move to the offline voice.
6. Unplug the microphone and plug it back in. Listening should return.
7. Sleep the PC and wake it. Listening should return.
8. If a step fails, copy the Voice rows and the on-screen status. Do not send a recording.

## Wave 6 — Speech Core and an isolated toolchain

Checked 2026-10-08. The area plans were absorbed. The change gate lives in `docs/FRIDAY_CHANGE_CONTROL.md`. A simulated clean PC is the proof that runs here. Live Windows microphone, wake word, the packaged binaries, pip, a model download, TTS audio, the packaged EXE, and hosted Actions were not run. The voice runtime pin is the install_only CPython 3.12.15 archive. The embeddable zip is an additional Install Manager row named FRIDAY Python embed.

### Plan table

| Idea | Source file | Status | Decision | Step |
| --- | --- | --- | --- | --- |
| One speech size plan, then a local load | `src/lib/friday/voice-flow.ts` | PARTIAL | ADOPT | 14 |
| Spoken failure names the cause | `src/lib/friday/voice-recovery.ts` | PARTIAL | ADOPT | 4, 25 |
| Retry when install, the model, the device, focus, or Fix voice is ready | `src/lib/friday/voice-recovery.ts` | PARTIAL | ADOPT | 5 |
| A PC with no system Python still gets a runtime | `src/lib/friday/voice-doctor.ts` | PARTIAL | ADOPT | 5–9 |
| Capture, VAD, and a low-quality last-resort voice live in FRIDAY's code | `src/lib/friday/voice-pack.ts` | PARTIAL | ADAPT | 15–24 |
| Think, a short offer, and sight sit on the live path | `src/lib/friday/brain/context-engine.ts` | DONE | ADOPT | 7 |
| Self-edits stay reviewable and never merge | `docs/FRIDAY_CHANGE_CONTROL.md` | PARTIAL | ADOPT | 26–29 |
| torch, a pip VAD package, or a second installer | voice install note above | MISSING | REJECT | — |

### Architecture

Speech Core is one ladder. Capture, resample, noise gate, VAD, features, a keyword fallback, text cleanup, prosody, a formant voice, and playback planning live in `src/lib/friday/speech-core.ts` and the modules it calls. `chooseStt()` prefers whisper.cpp when that binary and the ggml base file are present, then faster-whisper, then Moonshine for English, then an opt-in cloud engine. Every local choice sets local files only and does not download. The desktop status reports whisper.cpp when those two files are already on disk and does not mark listening ready: the live capture is still not a wav, so the Python worker remains the listener. `formantSynth()` is the last TTS resort and is labelled low quality. It is not a pretrained voice. Windows system speech is a command in `electron/sapi-voice.cjs`. The neural speaker calls it only on Windows, and only after the local neural voice fails. The size plan stays in `electron/voice-install.cjs`. `kernel/stt.py` only opens a local folder. A self-edit plan records a review line and does not apply the change.

The toolchain manifest is `config/toolchain-manifest.json`. `validateManifest()` rejects a missing hash, a missing license, and a copyleft pack marked bundled. `licenseNotices()` is copied to `resources/toolchain/LICENSE-NOTICES.txt`. `isolatedEnv()` returns a PATH for one FRIDAY shell and does not change the process environment. `kernel/toolchain_gate.py` plans pip, Node, C, Git, Java, and `ci.run`. Push to main is refused. Hosted workflows are not dispatched. Git and the JDK are on demand because their licenses are copyleft. w64devkit is on demand because it contains GCC.

### Size budget

Bundled pins sum to 205084080 bytes: CPython 3.12.10 embeddable (11133606), get-pip (2230488), Node.js 22.23.3 win-x64 (35574076), whisper.cpp 1.9.2 win-x64 (8194445), and ggml base (147951465). The budget is 220000000 bytes. That fits a GitHub release asset, whose limit is 2 GB, and leaves the NSIS script unchanged. MinGit, Temurin, w64devkit, the tiny model, the standalone CPython archive, and the GitHub CLI stay on demand. The bytes are not committed in git. Install Manager downloads a pinned file into the user runtime folder. `electron-builder.yml` unpacks `resources/toolchain/**` and `resources/speech/**` so a later pack can place those files outside app.asar. A live extract was not run.

### Research (2026-10-08)

| Finding | Decision | Reason |
| --- | --- | --- |
| The official Windows embeddable zip plus get-pip | ADAPT | Additional Install Manager row, not the voice runtime. `python312._pth` must enable site when that zip is used. CPython 3.12.10 embed-amd64, 11133606 bytes, SHA-256 `4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3`, hashed here on 2026-10-08. PSF-2.0. Source: https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip |
| get-pip.py for this date | ADOPT | 2230488 bytes, SHA-256 `fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6`. MIT. Source: https://bootstrap.pypa.io/get-pip.py |
| python-build-standalone install_only | ADOPT | This is the voice runtime. 46509797 bytes, SHA-256 `4b6f0beebbb695a0f3ea237b8c3eaa5bd424f47a7bc25b2fbe3a43390c770f08`, from the 20261003 checksum file. py and WinGet stay the later path. |
| Node.js 22.23.3 Windows zip | ADOPT | SHA-256 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71` from https://nodejs.org/dist/v22.23.3/SHASUMS256.txt . 35574076 bytes. MIT. |
| whisper.cpp 1.9.2 win-x64 and ggml base | ADOPT | The zip was hashed here: 8194445 bytes, SHA-256 `49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a`. MIT. ggml base is 147951465 bytes. The hash is the Hugging Face file id `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` read 2026-10-08. The file was not stored in git. Source: https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2 |
| MinGit and Temurin JDK | ADAPT | On demand, separate processes. MinGit 2.56.0.2 hashed here, GPL-2.0. Temurin 21.0.12.1 checksum from the Adoptium API, GPL-2.0 with the classpath exception. |
| w64devkit 2.10.0 | ADAPT | Hashed here, 67127496 bytes. The wrapper is Unlicense and the kit contains GCC (GPL-3.0), so it is not bundled. Source: https://github.com/skeeto/w64devkit/releases/tag/v2.10.0 |
| A from-scratch model claimed to match a pretrained voice | REJECT | The formant voice is labelled low quality. whisper.cpp stays the pretrained local engine. |
| torch, silero-vad on pip, vosk, piper, or a new sidebar row | REJECT | The voice-stack rule and the existing pages stay. |

### Owner checklist

Run these on the Windows PC, in order. Copy the Voice rows, the Toolchain rows, and the on-screen status if one fails. Do not send a recording.

1. Open Doctor and run the voice self-test. Each layer should say pass or the failing cause.
2. Say the wake word, then one sentence, and wait for a spoken reply.
3. Hold a 3-turn conversation.
4. Start talking while FRIDAY is speaking. She should stop and listen.
5. Disconnect the network mid-reply. Speech should move off the online voice.
6. Unplug the microphone and plug it back in. Listening should return.
7. Sleep the PC and wake it. Listening should return.
8. Ask for Python, Node, a C compile, Git status, and the local CI report.
9. If a step fails, copy the Voice and Toolchain rows and the on-screen status. Do not send a recording.

## Wave 7 — Bundled runtime, warm speech, and free models

Checked 2026-10-08. The area plans were absorbed. The change gate lives in `docs/FRIDAY_CHANGE_CONTROL.md`. A live Windows microphone, a real pack download, and a keyed provider call were not run. The voice runtime pin is still the install_only CPython 3.12.15 archive. The embeddable zip is the bundled pack the pack hook stages. It is not a second voice runtime.

### Plan table

| Idea | Source file | Status | Decision | Step |
| --- | --- | --- | --- | --- |
| Evidence before a model is called free | `electron/model-access.cjs` | PARTIAL | ADOPT | 14–15 |
| One router, ordered fallback | `kernel/router.py` | PARTIAL | ADOPT | 18–19 |
| Refresh without blocking startup | `electron/model-access.cjs` | PARTIAL | ADAPT | 16 |
| Provider adapters with a source | `electron/models.cjs` | PARTIAL | ADOPT | 14 |
| Failure injection for 429, auth, and a removed model | `kernel/router.py` | PARTIAL | ADOPT | 26 |
| A free board on the existing Models page | `src/routes/models.tsx` | PARTIAL | ADAPT | 25 |
| A second router or a new sidebar row | `kernel/router.py` | MISSING | REJECT | — |
| Warm local speech and a measured engine | `src/lib/friday/voice-pack.ts` | PARTIAL | ADOPT | 9–12 |
| Chat and Auto share one pool | `kernel/router.py` | PARTIAL | ADOPT | 13, 24 |
| Stage the pinned packs at pack time | `src/lib/friday/voice-doctor.ts` | PARTIAL | ADOPT | 4–8 |

### Research (2026-10-08)

| Finding | Decision | Reason |
| --- | --- | --- |
| electron-builder `beforePack` plus `extraResources` | ADOPT | The hook stages pinned archives before the pack. A hash or size miss fails the build. Source: https://www.electron.build/hooks |
| whisper.cpp `whisper-server` | ADOPT | One process keeps the model loaded and listens on `127.0.0.1`. The one-shot cli remains the fallback. Source: https://github.com/ggml-org/whisper.cpp/tree/master/examples/server |
| GitHub release asset limit | ADAPT | The bundled tier is 205084080 bytes under a 220000000 byte budget, inside a 2GB asset. Copyleft packs stay on demand. |
| Cerebras pricing | ADAPT | No always-free model list. A promotional credit still flows through account credits. A published price stays paid. Sources: https://inference-docs.cerebras.ai/support/rate-limits and https://www.cerebras.ai/pricing |
| GitHub Models | ADAPT | Retired 2026-07-30. The adapter is not eligible and is not a cloud row. Source: https://github.blog/changelog/2026-07-30-github-models-is-now-retired/ |
| Cloudflare Workers AI | ADAPT | 10,000 Neurons a day. Three documented free ids and three paid-plan ids. Anything else stays unknown. Sources: https://developers.cloudflare.com/workers-ai/platform/pricing/ and https://developers.cloudflare.com/changelog/post/2026-07-28-models-require-workers-paid/ |
| SiliconFlow | ADAPT | A `Pro/` id is paid. A zero catalogue price is free. No third-party id list. Source: https://docs.siliconflow.com/en/userguide/rate-limits/rate-limit-and-upgradation |
| Hyperbolic and SambaNova | REJECT | No verified always-free model list on 2026-10-08. Unknown cost stays hidden. |
| A model name that contains "free" | REJECT | Proof is a documented tier, a zero price, or a verified credit. |

### What the pack hook does

`scripts/stage-toolchain.cjs` reads `config/toolchain-manifest.json`, checks SHA-256 and size, and writes the archive under `resources/toolchain` or `resources/speech`. `electron-builder.yml` calls it from `beforePack`. The archives are gitignored. Install Manager remains the repair path. Doctor shows Ready only after a verify proof. A Windows pack was not run here.

### Free models

Chat and Auto call the same router. Auto asks for the latency surface. Chat asks for the quality surface. Paid and unknown-cost models stay hidden until paid access is on. A sensitive or private turn stays on a local model. Startup does not download provider pages. Refresh keeps the last good table when a page does not parse.

### Owner checklist

Run these on the Windows PC, in order. Copy the Doctor rows and the on-screen status if one fails. Do not send a recording.

1. Clean-install the voice test from Doctor.
2. Say the wake word, then one sentence.
3. Hold a 3-turn conversation.
4. Start talking while FRIDAY is speaking.
5. Disconnect the network mid-reply.
6. Choose Refresh free list on Models.
7. Choose Test my free models. It must not spend and must not send a secret.
8. Send one Chat turn and one Auto turn. Both use the same free pool.
9. If a step fails, copy the Doctor rows and the on-screen status.
