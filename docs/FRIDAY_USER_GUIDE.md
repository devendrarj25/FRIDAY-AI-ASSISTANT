# FRIDAY — User Guide

**Current shipping version: 1.0.1.2**

🪟 How to use FRIDAY after the window is open. Install and pack: [INSTALL.md](../INSTALL.md). The implementation map: [FRIDAY_FEATURES.md](FRIDAY_FEATURES.md). This page is the click-path only.

| You want to… | Start here |
| --- | --- |
| 💬 Talk by typing | Friday (Main Window), Manual |
| 🎙️ Talk by voice | Auto mode, after the microphone is allowed |
| 🧩 See how a task ran | Flow on that page |
| 🧠 Choose a model | Models, then the picker in chat |
| ⚙️ Change a setting | The footer Settings button |

Sidebar labels come from `src/lib/friday/navigation.ts`. Settings is the shell footer, not a sidebar row.

## 1. First minutes

Wait until kernel status is ready (title strip / FRIDAY Status). FRIDAY opens the normal workspace as soon as a folder is chosen — it does not force a model-connect / first-run screen at launch. Optional bootstrap (`src/lib/friday/first-run.ts`) still exists for Install Manager / Models: `llama3.2-3b` plus voice packages `faster-whisper` and `edge-tts`.

Chat lives on **Friday (Main Window)** (`src/routes/index.tsx`): Manual vs Auto, model picker, streaming replies. Voice uses the same brain and conversation as chat. The phone companion is that same conversation: a busy desktop acks and reports busy instead of the kernel answering on a second path, and Clear / Load on the PC replaces the kernel transcript the phone replays. Wake scores captured VoiceGate clips on a persistent worker and is ready only for the matching model file (`friday.onnx` for "friday"; `jarvis.onnx` for "jarvis" — never a silent friday fallback). STT reuses one WhisperModel in a persistent Python worker; "STT ready" for Auto Mode means that worker loaded the model. System voices are the offline speaker. edge-tts is cloud speech and runs only after you add that Neural voice, and not for sensitive text. Phone speech uses the cloud voice only when FRIDAY_CLOUD_SPEECH is on and the text is not sensitive. Auto mode is the voice session: the microphone stays open and FRIDAY speaks the reply, including a finished sentence while the rest is still arriving. Manual and chat do not listen and do not speak. Stopping a reply keeps the words already on screen. While a read-only lookup is running, the conversation header names it. The reply follows the language of the last message unless Settings already pins English, Hindi, or Hinglish. Hands-free is that Auto conversation. Turning Hands-free off requires the wake word again, and that choice is remembered. The in-memory flag still starts false until Auto mode applies this rule. Exec still waits for a yes. A greeting, goodbye, thanks, or small-talk reply is one short sentence in the language of that message. The first line in an empty thread is that kind of line. Agent counts, memory counts, and "ask me anything" stay off it. Status stays on the Status page unless you ask. A stale voice session is dropped so the next Auto start can take the microphone. A spoken yes has to be short, and it expires if it comes too late. Saying the name twice in a row does not start a second turn. A pause in the middle of a sentence is not treated as the end. Tray pause stops the microphone. Mic hardware on a Linux agent is not a substitute for a Windows check.

## Owner Windows voice check

Do this on the Windows PC after Auto mode is on, tray pause is off, and Mute microphone is off. Manual and chat must stay quiet the whole time.

1. Say "FRIDAY, what time is it?" Expect a short spoken answer. PASS: you hear a voice, and the same answer is on screen. If Supertonic 3 is installed, the voice is F2. If it is not installed, the voice is the Windows system voice. That is still PASS. `npm run voice:install` from a checkout downloads Supertonic, Smart Turn, and the English Moonshine weights into the selected FRIDAY folder.
2. Say "open chrome and" and pause. PASS: FRIDAY does not cut you off at the first pause. Finish the sentence and it takes the turn.
3. While FRIDAY is speaking, say "stop". PASS: the voice stops. Then say "continue". PASS: it picks up the remainder, or it says there is nothing left.
4. Say "do it" with no object. PASS: FRIDAY asks which one you mean and does not run a command.
5. Say "hey google, turn on the lights". PASS: FRIDAY does not treat that as a command.
6. When FRIDAY asks for a yes, say "yes" promptly. PASS: a short yes can confirm. A long sentence that merely contains "yes", or a yes that comes late, does not run the action.
7. Unplug the microphone, or deny it in Windows privacy. PASS: the status is not "available". Plug it back in. PASS: Auto tries again and then either hears you or says it still cannot.
8. In a checkout, run `npm run voice:check`. PASS for the checker is a process exit of 0 with one PASS or FAIL line per stage. Missing Silero, Smart Turn, or a missing local neural voice is a FAIL line for that stage, not a crash. `PASS boot` means the checker ran. A silent 512-sample Silero window is not speech.
9. Sensitive text must not be spoken by a cloud voice. A Neural voice you added speaks only ordinary text, and only when you selected it. Supertonic, when installed, may speak that text on this PC.
10. "Lower other audio while FRIDAY speaks" is on by default. During quiet hours other apps stay at their own volume. A voice match never approves an action. Speaker enrollment is not ready.
11. Say "remember to check the build", then "why did you do that" after a safe step, then "stop everything". PASS: the order is kept, the reason is spoken, and the work stops. Quit and open FRIDAY again. PASS: the same order is still listed, and a new run has a fresh step budget. A destructive line still asks on the desktop. While a tool is actually running, PASS includes one "Opening it." line. A disk or battery reading does not say that.
12. Turn on "Keep speech on this PC". PASS: a Neural voice does not speak that reply. "Quiet voice" is softer. "Delete voice data" removes a saved voiceprint and does not approve anything.
13. Open Teams or Zoom. PASS: listening pauses and FRIDAY does not talk over the call. Close the call. PASS: Auto listens again. This step is unverified until a Windows PC runs it.

This checklist is unverified until it is run on the owner's Windows PC. A Linux run does not pass it.

## How to watch, edit, and build flows

On any page that has a title, **Flow** opens Flow Studio for that page. System wiring still has its list; **Graph** and **Watch** open the same studio.

- **Graph** is the chart. **List** is the same boxes for a keyboard or a screen reader. **Code** is the JSON or YAML of that graph. Invalid text leaves the picture as it was.
- Search jumps by name. A locked box (permission, privacy, governance, billing, tool authority) shows locked and has no switch. Allow and Reject on any other box still go through the existing approval queue.
- **Watch** draws a turn only after the brain records a stage. Until then the status stays unknown. **Cancel** stops the turn the same way Stop does. **Step** and the scrubber move through the recording. They do not run the step again. Cost stays unknown when the turn did not report one.
- Ask in chat or Auto: "show me the voice flow", "explain the memory flow", or "what's happening now". The answer uses the recorded boxes. A sensitive line is not repeated on the chart.
- The Visual Builder on Workflows still saves through the same install path. A step may say it runs only after the previous one failed, or in parallel, or up to eight tries. An exec step cannot approve itself. An imported Mermaid flowchart stays disabled until you enable that pack yourself.
- **Mermaid** copies a text diagram. **SVG** downloads a picture. Labels are text. A diagram that contains markup is refused.

## Watch, edit, and build everything as flows

Flow on a titled page opens the same studio. **Full map** is every route, setting, pack, channel, kernel route, and GitHub workflow from the generated registry. **Page** returns to the slice for the screen you are on.

The mode row is flowchart, dataflow, state, timeline, architecture, tree, network, sankey, and heatmap. Overview, Layer, Node, and Ports change how much of that same graph you see. Search still filters the list and the canvas together.

Latency, cost, errors, privacy, risk, and usage are written as words. Cost stays unknown when the turn did not report one. A breakpoint holds the recording before that box. **Delete recording** clears the local trace. **Local trace** saves a file only after you tick it, and a sensitive line is stored as SENSITIVE.

The selected box lists its ports and the boxes that led to it. Changing label, detail, risk, or enabled stages a draft. A locked box does not change. A draft cannot lower a risk. **Apply draft** keeps the change for this session. **Roll back** returns the picture you opened. Linking two boxes stages a control edge. A workflow pack still saves through the Visual Builder.

**Code this step** calls the existing workflow forge. If the desktop install path is missing, nothing is installed. An imported Mermaid, DOT, n8n JSON, or pack stays disabled until you enable it yourself.

**How this works** and **Ask the chart** use the boxes on screen, in English, Hindi, or Hinglish when the question is in that language. **Speak** uses the installed voice when the desktop offers it, and says when speech is not available in this window. **Wiring check** lists red and amber in words and does not apply a fix by itself. The phone line is a read-only snapshot.

Mermaid, DOT, D2 text, JSON Canvas, SVG, PDF, and PNG come from this panel. PDF is the same chart, including Hindi, with as many pages as the boxes need. DOT can also draw through the library bundled in the app. The Graphviz and D2 compilers are optional Install Manager rows. The canvas still works when they are not installed.

## Watch, rewire, build, and ask FRIDAY with flows

Open **Flow** on a titled page. **Graph**, **List**, **Blocks**, and **Code** are the same boxes.

Drag a box. It snaps to the grid. Drag a wire from a port, or drag an end to reconnect it. Delete removes the selected box or wire. Double-click a wire to insert a step. **Tidy** snaps positions. **Auto-layout** runs the layout engine and leaves a locked box where it is. **Undo** puts the last canvas edit back.

**Ask every time**, **Balanced**, and **Full autonomy** sit on this toolbar and on Auto mode. A fresh install stays Balanced. Balanced asks before a write. Full autonomy applies a real wire immediately. **Stop everything** halts new work until **Resume**.

A wire that only describes the code does not change FRIDAY until **Code this step** finishes and you enable it. A router strategy wire and a setting wire write the existing stores. **Roll back** restores the last applied wire.

**Show work** opens the recorded run. The scrubber and **Step** move through that recording and do not run the step again. **Keep** changes how many events stay, and **Delete recording** clears them. While a live watch is running, an active wire shows a moving marker and the count that step transferred. The label is an em dash when the run did not count. Reduced motion keeps a still marker and the same label. A wire that cannot act shows its reason on the selected box.

Ask in chat or Auto: "show work", "make a flow that summarizes my downloads every night", "why did the last run fail", or "roll the flow back". A page, a file, or a clip cannot rewire anything. An import stays off until **Accept import**.

**Sketch** and **Contrast** change only this canvas. The rest of the app keeps its look. The legend is in English and Hindi.

## Watch chat and voice as flows

The conversation strip shows the model that will answer, and after the reply the model that did, the step count, and one chart button. The messages stay the conversation and the result. The chart opens that turn: message in, classification, routing, model selection, tools, memory, and the reply. A stage that did not run says "not recorded". The chart stays after the turn. **Apply draft** can change the routing strategy, safe tools, or whether chats are remembered. Balanced asks first. Full autonomy applies. Manual chat does not listen or speak.

On Auto mode, **Voice flow** opens the voice states and the pipeline: wake, listening, speech to text, intent, speaking, then trigger, plan, act, verify, and report. The approval level and the wake phrase are on that chart. There is no stored VAD threshold, so that box stays "not recorded". The kill switch is shown and is not changed from the box. After a spoken answer FRIDAY asks "Do you want me to show you how?" A yes opens the chart. "How did you do that", "show me how", "show me", "explain this", and "dikhao kaise" open the last recorded chart.

## Upload a diagram and FRIDAY builds it

Attach a file in the existing chat composer. Mermaid, DOT, D2, JSON Canvas, n8n, Node-RED, uncompressed draw.io, and SVG are read on this PC. A PNG can carry diagram boxes. A PNG or JPEG of a flowchart is read from the boxes and lines in the picture. Words come from Tesseract when that program is installed. A picture with no boxes still says it was not read. Uncertain boxes are marked. **Build this diagram** uses the existing forge and does not mark a stage done that did not run. Confirm uncertain boxes before a build. A sensitive picture stays on this PC. A cloud vision call is not made from this reader. Agents, Skills, Plugins, and Workflows show the packs on disk. When the desktop is not connected they stay empty. Hardware that has not been measured says unknown.

## 2. Core

- **Brain** — inspect retrieval and planner traces; it is not a second chat box.
- **Memory** — long-term notes under the FRIDAY root.
- **Library** — owner files FRIDAY indexed (`library/items`).
- **Self-Management** — approval queue (`governance`). Risky kinds ask unless Full autonomy is on. Stop everything halts the queue. A protected policy file still cannot auto-approve.
- **FRIDAY Status** — live wiring overlay (read-only for permission/privacy/billing).
- **Hardware** — measured CPU/RAM/adapters, not a second network probe.

## 3. Capabilities

Skills, Plugins, Modules, Agents, Workflows, Models, Tools each list disk packs plus health. Workflows has a Visual Builder tab (`src/routes/workflow-visual.tsx`) that draws the pack's real `steps[]` as a node graph and saves through the same `installPack` path. Import JSON format: [FRIDAY_IMPORT_FORMAT.md](FRIDAY_IMPORT_FORMAT.md). Models page is where you connect Ollama / LM Studio / llama.cpp / vLLM and paste cloud keys (stored encrypted).

## 4. Connectivity

- **FRIDAY Browser** — in-app browser; submit/login/purchase clicks still ask (`pageActionNeedsApproval`).
- **Connectors** — connect a service; “connected” means a live verify call succeeded.

### Connect any model

Open Models, then Providers. Each cloud card names the official page and how old that reading is. Sync now lists pricing sources that are close to expiry. Heal reports dead models, and with none recorded it changes nothing. Routing, then Dry run, asks the desktop router for a plan and does not call a model. Paste a key in Connections. It stays in safeStorage. A browser preview says the desktop step was not run.

### Which models appear and why

The chat model list shows only what can answer right now. A provider with no key is absent, and FRIDAY does not report an error about it. A connected provider's free models, read from that provider's own pricing or free-plan page, appear for Auto and for a manual pick. Paid models, and models whose price is still unknown, stay off that list until paid access is on. With paid access on, an unknown price is marked `cost unknown`. You can say "this key is on the free tier" for one provider, or mark one model free or paid. That choice is stored as your declaration and shown as `owner declared`. It does not turn a published paid price into free unless you mark that model.

Local models appear when that engine is installed and answering. A model that has hit its limit stays in the list, disabled, with the reason and when it returns, for example `limit reached · back in 12 min`.

Every row is `Provider · Model`, with `FREE`, `PAID`, `LOCAL`, or `cost unknown`. The conversation strip says what will answer before you send, and what did answer after, with the step count and the chart button. Auto shows the pick there (`used Auto → Groq · openai/gpt-oss-20b`). That Groq id is on the free-plan list. `llama-3.3-70b-versatile` is not, so Auto does not pick it while paid access is off. If a fallback took over, that same strip names both. The messages stay the conversation and the result. On Providers, each card counts usable models and hidden models, and says why the hidden ones are hidden. Test chat sends one streamed token through the same router. `npm run models:check --live` prints the same picture for each key on this PC.
- **Devices** — Android / Bluetooth / LAN discovery via kernel tools.
- **n8n Automation** — talk to a running n8n instance you already host.

## 5. Operations

Friday Hub (build/release dispatch, Revert Center), Import & Build (mixed intake), Setup & Doctor, Install Manager (toolchain + models + voice), Tasks, Projects & Workspaces, Folders (the selected root), Sandbox, Terminal, Logs.

`/character` is the 2D companion page (`src/routes/character.tsx`); it is not a sidebar row.

## 6. Troubleshooting

| Symptom | Where to look |
| --- | --- |
| Kernel not ready | Doctor + `runtime\.venv`; Setup may have set `PythonSetupPending` |
| No voice | Install Manager rows `faster-whisper` / `edge-tts`; Doctor / Voice Diagnostics (dependency vs loaded model vs worker) |
| Custom wake word silent | Drop `{word}.onnx` into `<FRIDAY_ROOT>/models/wake`; friday.onnx is not used for other names |
| Neural TTS robotic / missing | edge-tts needs network; system TTS is the fallback |
| Chat empty / no models | Models page; local engine ports 11434 / 1234 / 8080 / 8000 |
| Update not offered | Settings → Updates channel vs GitHub Latest; SHA256 mismatch refuses install |
| TEST EXE vs Official | Different Windows appId — both can be installed |

## 7. Conversation research (2026-10-09)

Read once. Only what fits a local, single-owner Windows app is kept. Hosted voice stacks and copied dialogue are not.

| Idea | Source | Decision | Reason | Where |
| --- | --- | --- | --- | --- |
| Short replies, reuse the current conversation, rare humour, a voice line that stands alone | [Siri HIG](https://developer.apple.com/design/human-interface-guidelines/siri), revised 2026-06-08 | ADOPT | The owner hears the same lines often | `src/lib/friday/conversation-style.ts` |
| Voice stays in the same chat, the transcript stays visible, interruption is normal | [OpenAI Help, Voice](https://help.openai.com/en/articles/20001274-chatgpt-voice), read 2026-10-09 | ADAPT | One thread already. A hosted full-duplex model would be a second stack | `assistant-mode.ts` tags `source: "voice"`; `preferSpoken` |
| Numbered citations resolve to search-result records, never to a URL the model invented | [Perplexity streaming citations](https://docs.perplexity.ai/docs/cookbook/articles/streaming-citations/README), read 2026-10-09 | ADAPT | Keys stay in safeStorage. HTML scrape stays the last resort | `electron/browser.cjs` (provider ladder still open) |
| Code runs with network off and a memory cap, and the files come back to the chat | [Code interpreter guide](https://developers.openai.com/api/docs/guides/tools-code-interpreter), read 2026-10-09 | ADAPT | Use the bundled Python and Node. A hosted container is refused | `electron/sandbox-engines.cjs` (clean-PC path still open) |
| Windows NSIS metadata lists `files[].sha512`. The updater does not roll an install back | [electron-builder auto-update](https://www.electron.build/docs/features/auto-update), read 2026-10-09 | ADAPT | FRIDAY already checks SHA-256 and keeps its own rollback | `electron/update-safety.cjs` |
| Another product's dialogue, voice, or logo | the same pages | REJECT | Independence. No copied persona | not used |
| Gemini Live, Alexa, Copilot, and coding-agent plan/act pages | not re-read this pass | UNVERIFIED | No second router or hosted agent was added from them | — |
