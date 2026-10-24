# FRIDAY — User Guide

**Current shipping version: 1.1.3.5**

FRIDAY - AI ASSISTANT: A Private, Autonomous and Self Learning OS Based on Local & Cloud Models.

How to use FRIDAY after the window is open. Install and pack: [INSTALL.md](../INSTALL.md). The implementation map: [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md). This page is the click-path only.

| You want to… | Start here |
| --- | --- |
| Talk by typing | Friday (Main Window), Manual |
| Talk by voice | Auto mode, after the microphone is allowed |
| See how a task ran | Flow on that page |
| Choose a model | Models, then the picker in chat |
| Change a setting | The footer Settings button |

Sidebar labels come from `src/lib/friday/navigation.ts`. Settings is the shell footer, not a sidebar row.

## 1. First minutes

- Wait until the kernel status is ready (title strip or FRIDAY Status). FRIDAY opens the normal workspace as soon as a folder is chosen; it does not force a connect-a-model screen. Optional first-run bootstrap (`src/lib/friday/first-run.ts`) offers `llama3.2-3b` and the voice packages `faster-whisper` and `edge-tts` through Install Manager and Models.
- Chat lives on **Friday (Main Window)** (`src/routes/index.tsx`): Manual or Auto, model picker, streaming replies. Voice, chat, and the phone companion are one conversation. A busy desktop tells the phone it is busy instead of answering on a second path.
- **Manual and chat never listen and never speak.** Auto mode is the one voice session: the microphone stays open and FRIDAY speaks each finished sentence while the rest of the reply is still arriving. Hands-free is that Auto conversation; turning it off requires the wake word again, and that choice is remembered. Tray pause stops the microphone. Exec still waits for a yes, and a spoken yes has to be short and on time. While a longer task runs she keeps listening: a quick "are you still working?", "kya kar rahi ho" or "thanks" gets an instant spoken answer and the task goes on; a turn that takes more than a couple of seconds gets a short "One moment, I'm on it" ("Ek second, dekh rahi hu" in Hindi or Hinglish) instead of silence; a real new request still takes over, and "stop" or "ruko" still stops.
- Stopping a reply keeps the words already on screen. While a read-only lookup runs, the conversation header names it. The reply follows the language of your last message unless Settings pins English, Hindi, or Hinglish. A greeting or thanks gets one short line.
- The default spoken voice is hi-IN-SwaraNeural (a female Indian voice) when the network is on and Privacy mode is off. Roman Hinglish is spoken as Hindi while the screen keeps your words. With the network off, Supertonic 3 voice F2 speaks when installed; otherwise Windows speech speaks with a female Indian voice if one is installed, and the status says how to add Hindi (India) if not. Privacy mode and sensitive text never use an online voice. Wake scoring needs the matching model file (`friday.onnx` for "friday"; another word needs its own `.onnx`).

## 2. Voice

### The Auto mode bar

1. **Listen:** the microphone chip (listening, paused, off, or error), hands-free, hold to talk, pause or resume, reset microphone.
2. **Speak:** speaking while FRIDAY talks, and Mute voice in the Transcript size.
3. **Safety:** Ask every time, Balanced, Full autonomy, and Stop everything.
4. **Tools:** Voice flow, Voice settings (opens Settings, Voice), and in the Transcript size Diagnostics and Pipeline.

An error shows Fix voice, followed by the running task and WORKING or IDLE. Every control has an icon and a name. On a narrow window the names hide behind the icons and slide out when you point at a button; tools that still do not fit go into **More**. The microphone chip and **Stop everything** never hide.

### Voice window sizes

Pick them on the captions strip (**Compact**, **Expanded**, **Transcript**), or press Alt+1, Alt+2, or Alt+3 in the voice window while not typing. The choice is remembered after a restart.

1. **Compact:** the full FRIDAY graphic and the last two caption lines.
2. **Expanded:** the whole caption history, with the graphic shrunk so nothing overlaps. FRIDAY opens this size herself for code, long text, or a long list; your saved choice stays.
3. **Transcript:** no graphic. The control bar sits on top, the conversation is centred with you on the right and FRIDAY on the left, and copy, clear, delete heard, follow, and the session numbers sit underneath. A confirmation card shows inside the conversation. Scroll up to read and following stops; **Jump to latest** brings it back.

Ctrl+Space (in this window) and Ctrl+Alt+Space (anywhere) hold to talk at every size. Voice settings, How Auto mode listens, chooses **Always listening** (wake word and follow-ups decide a turn) or **Push to talk** (only speech while the key or button is held).

The captions strip has **diagnostics** and **pipeline** buttons; each opens a pane beside the captions (below them on a narrow window), and the same button or Esc closes it.

## 3. Chat sizes

The Manual chat has three sizes. Pick them with **1 | 2 | 3** in the conversation header, or Alt+1, Alt+2, or Alt+3 in the chat. The choice is remembered after a restart.

1. **Compact:** the full FRIDAY graphic and the last four messages.
2. **Expanded:** every message in a taller area, with the graphic shrunk so nothing overlaps.
3. **Full chat:** no graphic. Saved chats sit in a rail on the left (open or closed as you left it) and the conversation is centred. Each message has Copy, code has Copy code, and the newest answer has Regenerate. Scroll up to read and following stops; **Jump to latest** brings it back. Selecting text while a reply streams holds the view still.

Enter sends, Shift+Enter starts a new line. Chat never opens the microphone; the Mic button stays disabled and says Auto mode listens.

## 4. Appearance, live indicators, and states

Settings, Appearance changes the whole app at once and shows a live preview of your choices.

- **Theme:** Dark, Daylight, or Match system; Cyan, Green, Orange, or Purple; or one of the 8 combinations.
- **Look:** Interface style (**Futuristic Glass**, the default, or **Classic**, the earlier look), Glass depth (Subtle, Balanced, Rich), Corner style (Round, Medium, Sharp), Ambient light (Off, Soft, Vivid), Ambient motion (off by default), Blur effect, Neon glow, Scanlines, the live circuit graphic, GPU rendering, Graphic intensity, and Panel opacity.
- **Motion:** Animations and Reduce motion. Either makes every transition instant.
- **Text and layout:** heading and body fonts, Text size, Interface density, Sidebar default, Button labels (On hover, Always, Icons only), and High contrast.
- **Chat:** bubble style and timestamps.

Neon glow only removes glow shadows; Blur effect is the switch that turns blur off. If scrolling or typing ever feels slow, turn Blur effect or Ambient light off. **Reset appearance** restores the shipped defaults. When Windows transparency effects are off, glass turns solid by itself. Below 1200 pixels wide the sidebar shows as icons; your saved choice returns on a wider window.

**Live indicators.** Pages that show measured data (Status, Hardware, Logs, Models, Setup & Doctor) carry a badge next to their title: a coloured dot, **Live**, **Waiting**, or **Offline**, and how long ago the data arrived. It reads real timestamps; with no desktop app it says Waiting. When the FRIDAY kernel or the network is down, a banner appears above the page, the page keeps what is stored on this PC, and live data returns by itself when the kernel does. A loading page shows placeholder lines, an empty list says what to do next, and a failed load shows the real error with **Retry**. A button that starts longer work shows a spinner at once and stays off until it ends; if it fails you get a notification with the reason. Long tables show 80 rows with Show more and Show all. Cut-off text shows its full text when you point at it.

## 5. Models

- Open **Models**, then **Providers** to connect a provider. Each cloud card names the official page and how old that reading is. Paste a key in Connections; it stays in safeStorage. **Sync now** lists pricing sources close to expiry, **Heal** reports dead models, and **Routing, Dry run** asks the router for a plan without calling a model. A browser preview says the desktop step was not run.
- Models has three sections. **LOCAL AI** holds Catalog, Installed, Live Runtime, Benchmarks, Import & Connect, and Activity, plus a card for each local launcher (source URL, size, checksum status, pin age; Check for update reads the official release and never installs by itself; Install never starts the file). **CLOUD AI** holds Providers, Catalog, Import & Connect, and Activity, plus Select all free, Select all paid, and Select both. **ROUTING** holds Routing & Modes, the dry run, and the local answer choice. Confirm paid is required before a paid model can be selected, and **Save selection** is the allowlist.
- **Which models appear:** the chat list shows only what can answer right now. A provider with no key is absent. A connected provider's free models, read from its own pricing or free-plan page, appear for Auto and for a manual pick. Paid models, and models whose price is unknown, stay off until paid access is on; with paid access on, an unknown price is marked `cost unknown`. You can say a key is on the free tier, or mark one model free or paid; that is stored as `owner declared`. Local models appear when that engine is installed and answering (LM Studio only with a model loaded). A model that hit its limit stays listed, disabled, with the reason and when it returns.
- Every row is `Provider · Model` with `FREE`, `PAID`, `LOCAL`, or `cost unknown`. The conversation strip says what will answer before you send and what did answer after, with the step count and the chart button. Chat and Voice use the same route; the Doctor line names the lane (`local`, `cloud-free`, `cloud-paid`, `multi-local`, `hybrid`, or `manual`) and one reason. A saved cloud allowlist drops every cloud model that is not on it. Paid stays off unless paid access, the billing firewall, and a budget all allow it. A verified free model that fails falls back to the previous verified version of its family. `npm run models:check --live` prints the same picture for each key on this PC.
- Downloads: Pause keeps the partial file, Cancel removes it, and closing the app mid-download leaves it so the next open can continue.
- **What runs on this PC:** FRIDAY measures the PC when it starts (RAM, graphics card and memory, and free space on the drive the models are stored on) and tells you in the Support column what each local model will do: Optimal, Supported, Tight, CPU only, Unsupported, or Unknown while the PC has not been measured. The Catalog opens on **Runs on this PC**, best fit first with what you have installed on top, and says how many too-big models it left out; **Everything** shows them all. Check system measures again.
- **Search:** the box is always there. It filters the catalogue as you type; Enter, or **Search online**, also asks the Hugging Face index for GGUF models (and a search with no catalogue match goes online by itself). Each found model shows whether it fits this PC, from the size in its name, and **Install** gives it a transfer row with progress, Pause and Cancel like any other.
- **Add your own model** (Import & Connect): drop files on the box, **Choose model files** (a real file picker for .gguf, .safetensors, .onnx, .pt, .bin), **Choose a model folder**, or paste a path. FRIDAY checks the file (a GGUF must really be one), keeps it under your FRIDAY folder `models\imported` (a link when the drive allows, otherwise a copy with progress), registers a GGUF with the local engine (starting Ollama if it is not running) and sends one test prompt. It says **ready** only when the model answers, and then it is in the model list. Other formats are stored for the runtime that reads them. A failed import shows why, with a retry.
### Install Manager

- **Sections.** Software (the catalog, with a details panel when you click a package), Queue & Updates, Services, Health & Maintenance, Activity, and Ask FRIDAY. The counts stay above them. The tab shows how many jobs are running and how many services are on.
- **Always current.** While the page is open it re-reads this PC every five minutes (and when you come back to the window), the services every fifteen seconds, and straight after every install, update or key change. The newest version comes from the vendor (npm, PyPI, GitHub, nodejs.org, go.dev, Rust, VS Code, Temurin) or from winget's own upgrade list; if no source names one, the row says so instead of showing an old number.
- **Install, with a fallback.** winget first; if it is missing or refuses, the vendor's own installer from its official feed, checked against the vendor's SHA-256 (a file that does not match is thrown away). Tools FRIDAY unpacks for herself (Python, Node, Git, GitHub CLI, Java, KoboldCpp) go under your FRIDAY folder `runtime`, are found by the next scan so they are not downloaded again, and are put on PATH for FRIDAY's own terminal, agents and commands.
- **Services.** Ollama, LM Studio, Docker Desktop and the databases can be started, stopped and restarted from the Services section or by saying "start docker" / "ollama band karo". What FRIDAY starts stops when it sits unused (you choose how long) and when FRIDAY closes; one that was already running is left alone. Databases are Windows services and ask for administrator approval.
- **Ask FRIDAY** "what tools are missing", "what needs an update", "what is broken", "which services are running", "is git installed", "version of node": she answers from this page's data.
- A few tools are still installed by their vendor's own wizard (NVIDIA driver, AMD ROCm, ONNX DirectML, LocalAI, Android command-line tools); their row says why and links to the vendor.

- **Voice models** (faster-whisper sizes, Silero VAD, Smart Turn, Supertonic 3) show as installed when their files are on this PC. Downloading a speech size here puts it where voice mode loads it. Their files are managed in the Install Manager, so Remove here leaves them in place.
- **Local engines** FRIDAY finds by themselves: Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan, KoboldCpp (port 5001) and GPT4All (turn on its Local API Server, port 4891). Their models appear as soon as the engine answers.
- **Pick a model by name** in chat or voice: "use qwen2.5 1.5b for this", "gemini se pucho", or "ask claude to check this" sends that turn to that model, or to that provider's models. Just mentioning a name ("what is OpenAI?") does not. The paid and private rules still decide: a named model they block is not used.
- **Installed means installed.** A local model reads Installed only when the engine really has that exact tag (one `qwen2.5:latest` no longer marks every size), a cloud model reads **Connected** when its provider's key works, and Delete keeps the row until the engine confirms the files are gone. While the page is open the list re-reads the engines every 20 seconds, and also at once after a download, an import or a key change.
- **Live Status** tab: what the router is doing now. It shows the mode, cost policy and strategy, the last models it tried and why, and for every model it has used: Active, Ready, Cooling down, Rate limited, Quarantined, Recovering or Blocked, the retry countdown, requests answered and failed, and tokens in and out (counted from text length unless the provider reports its own number). The test button sends one real request.
- **Ask FRIDAY** "which models are installed", "which providers are connected", "any model cooling down", "how many tokens have I used today", "router status", or "download qwen2.5 1.5b": she answers from the same data the page shows, without calling a model.
- **Cloud selection** now loads what you saved. Saving with nothing selected removes the restriction (it no longer blocks every cloud model); use Local-only to keep a turn off the cloud.
- **Task routing is real.** Under ROUTING, the model you give Brain, Coding, Research, Reasoning, Vision or Fast is preferred for that kind of request in typed chat and in Auto mode (spoken turns lead with Fast). It is only a preference: the router still applies your route mode, cost policy and privacy rules, skips a model that is cooling down, and never uses a paid model this way. A model you pick in the chat picker or name in the sentence wins over it. Image generation, Embedding and Reranking are saved but marked "not used yet".
- **Speech to text** in Task routing and Settings → Voice → Speech model size are the same choice; "— Auto —" lets voice mode pick. Only the faster-whisper sizes are listed. **Text to speech** lists Supertonic 3, which speaks when installed (otherwise Edge or the system voice does).
- **Voice stack** (Live Status tab): whether Auto mode is listening, the microphone, the loaded speech model, what is speaking, and which voice files are on this PC.
- **Input → output** filter and line on every model (Text → Text, Image → Text, Audio → Text, Text → Audio, Text → Image, Text → Vector).
- **Connect** says what really happened: "connected — N models ready", or "did not connect" with the provider's reason. Azure OpenAI, Bedrock, Vertex, "OpenAI-compatible" and "Custom" are listed as "no connector yet" and cannot be connected.
- **After a download or a key:** a downloaded model is registered and test-prompted without another click, and a GGUF that finished while the engine was off starts the engine and registers itself. A provider key that is accepted makes that provider's models available at once.

## How to watch, edit, and build flows

On any page that has a title, **Flow** opens Flow Studio for that page. **Full map** shows every route, setting, pack, channel, kernel route, and GitHub workflow from the generated registry; **Page** returns to the slice for the screen you are on.

- **Graph** is the chart, **List** is the same boxes for a keyboard or screen reader, **Blocks** is the stage view, and **Code** is the JSON or YAML of the graph; invalid text leaves the picture as it was. The mode row switches between flowchart, dataflow, state, timeline, architecture, tree, network, sankey, and heatmap; Overview, Layer, Node, and Ports change how much of the graph you see. Search filters the list and the canvas together.
- **Watch** draws a turn only after the brain records a stage; until then the status stays unknown. **Cancel** stops the turn the same way Stop does. **Step** and the scrubber move through the recording without running a step again. **Keep** sets how many events stay, **Delete recording** clears them, and **Local trace** saves a file only after you tick it (a sensitive line is stored as SENSITIVE). Latency, cost, errors, privacy, risk, and usage are written as words, and cost stays unknown when a turn did not report one. A breakpoint holds the recording before that box.
- **Edit:** drag a box (it snaps to the grid), drag a wire from a port or an end to reconnect it, double-click a wire to insert a step, and press Delete to remove the selection. **Tidy** snaps positions, **Auto-layout** runs the layout engine and leaves a locked box where it is, and **Undo** puts the last canvas edit back. A locked box (permission, privacy, governance, billing, tool authority) has no switch. Changing label, detail, risk, or enabled stages a draft; a draft cannot lower a risk. **Apply draft** keeps the change for this session and **Roll back** returns the picture you opened. A wire that only describes code changes nothing until **Code this step** finishes and you enable it; a router-strategy or setting wire writes the existing stores; a wire that cannot act shows its reason on the selected box.
- **Autonomy** sits on this toolbar and on Auto mode: **Ask every time**, **Balanced**, **Full autonomy**. A fresh install stays Balanced; Balanced asks before a write and Full autonomy applies a real wire at once. **Stop everything** halts new work until **Resume**.
- **Ask in chat or Auto:** "show me the voice flow", "explain the memory flow", "what's happening now", "show work", "make a flow that summarizes my downloads every night", "why did the last run fail", "roll the flow back". A page, file, or clip cannot rewire anything. An import (Mermaid, DOT, n8n JSON, or a pack) stays off until you enable it or press **Accept import**.
- **Chat and voice as flows:** the conversation strip shows the model that will answer, then the one that did, the step count, and a chart button. The chart opens that turn: message in, classification, routing, model selection, tools, memory, and the reply; a stage that did not run says "not recorded". On Auto mode, **Voice flow** shows wake, listening, speech to text, intent, speaking, then trigger, plan, act, verify, and report. After a spoken answer FRIDAY asks "Do you want me to show you how?"; a yes, "show me how", "explain this", or "dikhao kaise" opens the last recorded chart.
- **Build from a picture or file:** attach Mermaid, DOT, D2, JSON Canvas, n8n, Node-RED, uncompressed draw.io, SVG, or a PNG or JPEG of a flowchart in the chat composer. It is read on this PC (words come from Tesseract when installed); uncertain boxes are marked, and you confirm them before **Build this diagram** uses the existing forge. A sensitive picture never leaves this PC.
- **Visual Builder** on Workflows saves through the same install path; a step may run only after the previous one failed, in parallel, or up to eight tries, and an exec step cannot approve itself.
- **Export:** Mermaid, DOT, D2 text, JSON Canvas, SVG, PDF (the same chart, Hindi included, as many pages as the boxes need), and PNG come from this panel. DOT can draw through the library bundled in the app; the Graphviz and D2 compilers are optional Install Manager rows. **Sketch** and **Contrast** change only this canvas. **How this works**, **Ask the chart**, **Speak**, and **Wiring check** use the boxes on screen and never apply a fix by themselves.

## 6. Pages

**Core**

- **Brain:** inspect retrieval and planner traces; it is not a second chat box.
- **Memory:** long-term notes under the FRIDAY root.
- **Library:** owner files FRIDAY indexed (`library/items`).
- **Self-Management:** the approval queue (`governance`). Risky kinds ask unless Full autonomy is on; Stop everything halts the queue; a protected policy file never auto-approves.
- **FRIDAY Status:** the live wiring overlay (read-only for permission, privacy, and billing).
- **Hardware:** measured CPU, RAM, and adapters.

**Capabilities.** Skills, Plugins, Modules, Agents, Workflows, Models, and Tools each list disk packs plus health. Workflows has a Visual Builder tab (`src/routes/workflow-visual.tsx`) that draws a pack's real steps and saves through the same install path. Import JSON format: [FRIDAY_IMPORT_FORMAT.md](FRIDAY_IMPORT_FORMAT.md). On the Models page you connect Ollama, LM Studio, llama.cpp, vLLM, and paste cloud keys (stored encrypted).

**Connectivity.** **FRIDAY Browser** is the in-app browser (a submit, login, or purchase click still asks). **Connectors** connect a service; "connected" means a live verify call succeeded. **Devices** finds Android, Bluetooth, and LAN devices. **n8n Automation** talks to an n8n instance you already host.

**Operations.** Friday Hub (build and release dispatch, Revert Center), Import & Build (mixed intake), Setup & Doctor, Install Manager (toolchain, models, voice), Tasks, Projects & Workspaces, Folders (the selected root), Sandbox, Terminal, Logs. `/character` is the 2D companion page (`src/routes/character.tsx`); it is not a sidebar row.

## 7. Troubleshooting

| Symptom | Where to look |
| --- | --- |
| Kernel not ready | Doctor and `runtime\.venv`; Setup may have set `PythonSetupPending` |
| No voice | Install Manager rows `faster-whisper` and `edge-tts`; Doctor and Voice diagnostics (dependency, loaded model, worker) |
| Custom wake word silent | Drop `{word}.onnx` into `<FRIDAY_ROOT>/models/wake`; `friday.onnx` is not used for other names |
| Neural TTS robotic or missing | edge-tts needs the network; system speech is the fallback |
| Chat empty, no models | Models page; local engine ports 11434, 1234, 8080, 8000 |
| Update not offered | Settings, Updates channel versus GitHub Latest; a SHA-256 mismatch refuses the install |
| TEST EXE versus Official | Different Windows appId; both can be installed |
| Doctor: Recent errors in log | Counts real errors only (kernel `INFO:` lines are logged at their own level); the scan reads the last 512 KB |
| Doctor: Internet or Cloud AI red while chat works | The checks use the same Chromium network stack as provider calls, with the Windows proxy and certificates. The internet check tries three hosts for 6 s each; a failing provider is re-probed once, and one that answered this session shows Warning |
| Doctor: Bundled runtime rows | A pack inside the install is extracted the first time no installed Python or Node is found. Missing means the pack file itself is absent |
| Doctor: Voice layers | PASS or FAIL from the last voice check and the live Auto session; unchecked layers are one row with the steps |
| Doctor: Window and kernel watchdog | Warning only for a stall in the last 10 minutes |
| Doctor: Content Security Policy | The network meter's three hosts are allowed in `connect-src`; any other violation shows |
| Self-Management issue count | An optional add-on that is not installed (Graphviz, D2, comtypes, llama.cpp, a toolchain pack, the speaker file) is one fact line, not a critical issue |
| Status: environment rows | Node.js is the Node built into FRIDAY.exe; the registry never spawns FRIDAY.exe to read a version |
| Status: local provider "no answer within N s" | That engine is not running or is still loading |
| Kernel log | Routine loopback and `/health` lines are left out; `FRIDAY_KERNEL_VERBOSE_LOG=1` keeps every line |
| Routing sync row | The planner leads with a pinned model only when it can answer on this PC |

## 8. Checking a Windows install

Run these on the Windows PC after `npm run setup` and `npm run build:win`. They stay **unverified** until that PC runs them; a Linux run does not pass them. If a step fails, send the step number, the on-screen text, and the newest `debug\reports\*` file. The release acceptance steps are in [RELEASE.md](../RELEASE.md).

**Voice** (Auto mode on, tray pause off, Mute microphone off; Manual and chat stay quiet throughout)

1. Say "FRIDAY, what time is it?" You hear a female Indian voice and the same answer is on screen.
2. Say "open chrome and" and pause. FRIDAY waits; finish the sentence and it takes the turn.
3. While FRIDAY speaks, say "stop": the voice stops and the microphone reopens. Say "continue": it resumes, or says nothing is left.
4. Say "do it" with no object: FRIDAY asks which one. Say "hey google, turn on the lights": FRIDAY ignores it.
5. A short, prompt "yes" confirms an action; a long sentence containing "yes", or a late one, does not.
6. Unplug the microphone, or deny it in Windows privacy: the status stops saying "available". Plug it back in, sleep and resume, or change the default device: the microphone reopens, or says it uses the default device.
7. Speak 5 normal sentences, a very short word, and a long paragraph: each appears with the right tag and none is dropped. Say a follow-up without the name within a few seconds: she answers. Talk to someone else, or say Friday as a weekday: she stays quiet. Speak over her: she stops and her own voice never appears as your words.
8. Turn Wi-Fi off: the reply still speaks in a female voice and the status names it. Turn Privacy mode on: no online voice. Turn on "Keep speech on this PC": a Neural voice does not speak that reply.
9. Open Teams or Zoom: listening pauses and FRIDAY does not talk over the call; close it and Auto listens again.
10. Say "remember to check the build", then "why did you do that", then "stop everything": the order is kept, the reason is spoken, and the work stops. Reopen FRIDAY: the order is still listed.
11. Leave the voice screen open for 10 minutes: no flicker or stutter. In Chat mode confirm the microphone is not used.
12. In a checkout, `npm run voice:check` exits 0 with one PASS, FAIL, or OPTIONAL line per stage; `npm run voice:install` downloads Supertonic, Smart Turn, and the English Moonshine weights into the FRIDAY folder.

**Models** (real keys)

1. Models shows each connected provider's models with a state and next step; free models verified by proof show as Free and nothing paid is selected.
2. Send a chat with only free models available: it answers and the Doctor shows "why this model". Repeat for code, a long document, and an image.
3. Remove one key, use a model your key cannot access, and hit a rate limit if you can: each gives a distinct message and a correct cooldown, and other models on that provider still work.
4. Start LM Studio with no model loaded, then load one; start and stop Ollama. The status follows within seconds and chat routes to the loaded model.
5. Privacy mode on: no cloud call. Paid off with the billing firewall: nothing paid is ever used silently.
6. Chat and Voice with the same question show the same lane, model, and reason in the Doctor.
