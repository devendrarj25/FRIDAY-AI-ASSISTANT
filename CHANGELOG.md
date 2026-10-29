# FRIDAY — Changelog

What changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.

## v1.1.4.6

**Released:** October 25, 2026  
**Channel:** Stable (official release)  
**Release type:** PATCH / FIX  
**Changes since:** v1.1.4.5  
**Summary:** FRIDAY 1.1.4.6 includes reliability fixes and behaviour updates.

### What's New

FRIDAY 1.1.4.6 is a small fix. Here is what changed for you.

#### Models
- Move build-time model downloads into the chosen FRIDAY folder instead of downloading them again.

#### Desktop
- FRIDAY Test Build installer smoke checks the TEST uninstall contract; record hosted workflow results.

#### Fixed
- Real-pc-setup-fixes test no longer depends on LF line endings, so it passes on Windows.
- Setup, build:win and doctor on a Windows Home PC (Sandbox skip, honest winget results, Rust toolchain, fresh PATH).

#### Changed
- One ownership table for what an update may replace, keep or never delete.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.4.5

**Released:** October 25, 2026  
**Channel:** Stable (official release)  
**Release type:** MINOR / CHANGES  
**Changes since:** v1.1.3.5  
**Summary:** FRIDAY 1.1.4.5 adds prove the update path on every build; first differential update; silent-update smoke and reliability fixes.

### What's New

FRIDAY 1.1.4.5 is an update with changes. Here is what changed for you.

#### Voice
- Pick a model by name, list voice models, add KoboldCpp and GPT4All, read full catalogues.
- One light local chat model, a larger speech size, and instant replies while a task runs.
- Make Task routing, speech and voice real, and close the Models page gaps found in the audit.
- Make downloads range-exact and resumable, prefetch the offline voice, lift the setup time limit.

#### Chat
- One local chat model across setup and first run, and say where build-time models go.

#### Models
- Hugging Face runner, model kinds, token on downloads, cloud picture drawing.
- Live status and usage, exact installed state, ask-about-models, provider routing fixes.
- Measure the PC at start, list what runs, search online, and import your own model.
- Exact rate-limit waits, provider-first parallel runs, Groq free-plan declaration, better model kinds.
- Download each local model once, add fast and smart Ollama tiers, skip repeat installs.

#### Desktop
- FRIDAY now includes differential installer download and a non-blocking safety backup.
- Background installer download, new Python packages after an update, safer backups.
- A Release test run no longer races a real desktop window; environment report is accurate.
- FRIDAY Test Build uploads the installer block map and reads its prerelease back.
- Toolkit step time limit and subset scan, Portable restart launcher, Install agent toolkit button.

#### Added
- Prove the update path on every build; first differential update; silent-update smoke.
- Start-up update check, live speed and time left, in-place source merge.
- Read-only update token, release file guide, silent in-place install.
- To-do panel on the Tasks page over the personal desk store.
- Doctor reports the agent toolkit, npm run setup:toolkit, INSTALL steps.
- FRIDAY now includes fresh-PC bootstrap, Chocolatey/Scoop fallback, sandbox.run, erase-all uninstall switch.
- Agent toolkit prefetch under 2 GB, file/archive/docker agent tools.
- Sections, service controls, ask FRIDAY, more tools, needs queued first.
- Official-feed install fallback, automated manual tools, and service start/stop/restart.
- Find FRIDAY's own installs, put them on PATH, and read newest versions from every official source.
- Reuse an installed Ollama, install the newest official release, and show live, correct update state.

#### Fixed
- Verify the published release assets, keep the isolated-copy proof from skipping, name skipped tools honestly.
- One Windows build flow with nothing optional (setup, doctor, build:win); erase-all leaves no empty App folder.
- Silent /DELETEDATA uninstall erases again; ci: parallel update job, workflow audit, least privilege.
- Newer built-ins replace stale copies, redirect fallback, switches confirmed.
- Shipped config follows updates, rate-limit wording, release contract test.
- Resumable update downloads, cancel, content-only merge for the installed app.
- Archive names checked before any write, Docker mount quoting, smoke key restore.
- Install the needed heavy tools before the build, no size cap.
- Survive a dying helper process, theme native lists and popups, register GGUF imports with Ollama, show Checking.
- Start local engines on demand and show failed scans with Retry.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.3.5

**Released:** October 23, 2026  
**Channel:** Stable (official release)  
**Release type:** PATCH / FIX  
**Changes since:** v1.1.3.4  
**Summary:** FRIDAY 1.1.3.5 adds prefetch speech, turn-taking and a small chat model at build time, improvements, reliability fixes, behaviour updates and performance improvements.

### What's New

FRIDAY 1.1.3.5 is a small fix. Here is what changed for you.

#### Flow Studio
- Warm Flow Studio on pointer enter.
- Flow Studio loads on first open, shell chunk 3.7 MB to 94 kB.

#### Voice
- Prefetch speech, turn-taking and a small chat model at build time.
- FRIDAY now includes transparent glass bubbles for chat and voice.
- Align the chat and voice levels with the FRIDAY Glass tokens.

#### Chat
- Sliding sidebar highlight, remembered chat rail, selection hold while streaming, glass toasts.

#### Brain
- Hand-rolled chip groups use FilterTabs; memory actions are real buttons; truncated labels get titles.

#### Models
- Model registry refresh on the shared poller; error banner on Models.

#### Desktop
- Main window graphic no longer swallows clicks on its node boxes.

#### Improved
- 32 px minimum button height in Glass, wrapped filter tabs.
- Loading, error and empty states on library, projects, devices; Models top panels use HudPanel.
- Empty states on agents, skills, modules, tools, status and install manager.
- Library, projects, devices, MCP and ComfyUI panels follow the shared poller; n8n connect is cancellable.
- Pending state for async buttons, more button icons, dead-control guard.
- Live badge on status, hardware, logs, models and doctor pages.
- Shared poller, page states, live badge, route error screen, rejection toast.
- IOS glass tokens, ambient light, segmented controls, capsule composer.
- FRIDAY now includes batch E settings, setup and extras.
- FRIDAY now includes batch D operations empty state.
- FRIDAY now includes batch C connectivity empty states.
- Batch A core pages on the shared glass surfaces.
- FRIDAY now includes panel headers take an icon from their title.
- An icon on every text button, from one vocabulary.
- Glass chrome for the sidebar, title strip, page frame and notifications.
- FRIDAY Glass primitives, backward compatible.
- FRIDAY Glass tokens, appearance options and the Blur fix.

#### Fixed
- Visible keyboard ring on segmented tabs.
- Windows reduced transparency also turns the glass chrome blur off.
- Hands-free follow-ups reach FRIDAY without her name.
- Lift quiet microphones before denoise and VAD.
- Never adopt a test sandbox as the FRIDAY root.

#### Changed
- Wiring panel on shared tokens; title pill moves by transform.
- Move routes and components onto shared caption and corner tokens.

#### Performance
- Deferred filtering, optimistic tab transitions, paged long tables.
- Decorative loops hold still while typing or scrolling.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.3.4

**Released:** October 22, 2026  
**Channel:** Stable (official release)  
**Release type:** MINOR / CHANGES  
**Changes since:** v1.1.2.4  
**Summary:** FRIDAY 1.1.3.4 adds FRIDAY now includes a persisted model catalogue and provider protocol modules and reliability fixes.

### What's New

FRIDAY 1.1.3.4 is an update with changes. Here is what changed for you.

#### Voice
- Read helper output as the last JSON line so nested results (speech self-test, STT status) are no longer reported as no answer.
- One denoise scale and loudness guard, drop reason codes, spoken self-test, turn trace, true blocked reason.

#### Chat
- Route installed local chat models and say why one is skipped.

#### Models
- FRIDAY now includes a persisted model catalogue and provider protocol modules.

#### Fixed
- Runner Install uses the Install Manager after a confirm click, status refreshes when an install ends.
- Format, pyright ceiling, and the LM Studio not-loaded test now pins the documented behaviour.
- Keep proven-free models free on a cached table, refresh pricing sources daily, show evidence and Refresh now result, HF route pricing, owner free mark survives stale.
- Local runner status, consented runner start with auto-use, local free/private contract tests.
- Format the hearing edits and keep the pyright ceiling.
- Allow official free evidence before a live probe.
- Scale RNNoise frames and name an empty transcript.
- Isolate the harness from the live FRIDAY folder.
- Transcribe local wavs without PyAV 19.
- Name a sensitive block and a daily limit.
- Hard-stop real identifiers and keep stale prices unverified.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.2.4

**Released:** October 17, 2026  
**Channel:** Stable (official release)  
**Release type:** PATCH / FIX  
**Changes since:** v1.1.2.3  
**Summary:** This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.

### What's New

FRIDAY 1.1.2.4 is a small fix. Here is what changed for you.

#### Improved
- This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.2.3

**Released:** October 15, 2026  
**Channel:** Stable (official release)  
**Release type:** PATCH / FIX  
**Changes since:** v1.1.2.2  
**Summary:** This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.

### What's New

FRIDAY 1.1.2.3 is a small fix. Here is what changed for you.

#### Improved
- This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.2.2

**Released:** October 13, 2026  
**Channel:** Stable (official release)  
**Release type:** MINOR / CHANGES  
**Changes since:** v1.1.1.2  
**Summary:** This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.

### What's New

FRIDAY 1.1.2.2 is an update with changes. Here is what changed for you.

#### Improved
- This update refreshes how FRIDAY is packaged and checked, so the app you install stays consistent.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.1.1.2

**Released:** October 11, 2026  
**Channel:** Stable (official release)  
**Release type:** MAJOR / FEATURE  
**Changes since:** v1.0.1.2  
**Summary:** FRIDAY 1.1.1.2 adds new capabilities.

### What's New

FRIDAY 1.1.1.2 is a larger update. Here is what changed for you.

#### Added
- FRIDAY now includes the search ladder, the held MCP listen stream, and the bundled Python probe.
- FRIDAY now includes the shared MCP protocol layer and the local server.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.0.1.2

**Released:** October 6, 2026  
**Channel:** Stable (official release)  
**Release type:** MINOR / CHANGES  
**Changes since:** v1.0.0.2  
**Line:** Latest  
**Summary:** Flow Studio, voice controls, and a clearer brain.

### What's New

FRIDAY 1.0.1.2 is an update with changes. Here is what changed for you.

#### Flow Studio
- Flow Studio is on the chart and workflow runner you already use. You can open the chart for a chat or a voice session and watch the steps that were actually taken.
- You can move boxes and reconnect wires. A wire that cannot act tells you why.
- You can attach a diagram. A photo of a flowchart is read from its boxes and lines when a reader is available on this PC. A picture with no boxes stays unread.
- You can save the chart as a PDF, including Hindi text, across more than one page.

#### Voice
- Auto mode keeps the microphone and the spoken reply. Manual chat stays quiet.
- Voice controls and the standing permission stay on the voice page you already use.

#### Brain
- Memories keep the date they belong to. A note that should not be trusted does not replace what you told FRIDAY, and retrieval is ranked.
- A cognitive control pass runs inside the brain you already have.

#### Improved
- What's New is written in plain language, grouped by the area that changed.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.0.0.2

**Released:** September 4, 2026  
**Channel:** Stable (official release)  
**Release type:** PATCH / FIX  
**Changes since:** v1.0.0.1  
**Summary:** The installed app keeps one version number on Windows.

### What's New

FRIDAY 1.0.0.2 is a small fix. Here is what changed for you.

#### Desktop
- The installed app keeps one version number on Windows.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.0.0.1

**Released:** September 4, 2026  
**Channel:** Stable (official release)  
**Release type:** PATCH / FIX  
**Changes since:** v1.0.0.0  
**Summary:** The test build, a small fix, and a stopped release all keep the right version.

### What's New

FRIDAY 1.0.0.1 is a small fix. Here is what changed for you.

#### Updates
- The test build now shows the same public version as the installed app. Its test label still shows which test build it is.
- A small fix can be published without the version step getting stuck.
- If a release stops halfway, starting it again continues from the current version.

### Important Notes

- Your FRIDAY data remains preserved during updates. Installing this release replaces application files only.
- Downloads are verified against the published SHA-256 before installation.

## v1.0.0.0

**Released:** September 4, 2026  
**Channel:** Stable (official release)  
**Line:** Base  
**Baseline:** first public version  
**Summary:** FRIDAY 1.0.0.0 is the first public version.

### Baseline

This is the first public version of FRIDAY.

The capabilities below are part of this first version. They are not claimed as work added after it.

### Included

#### Core

- A desktop app on this PC, with its own local service
- Your chats, settings, and files stay in one FRIDAY folder, and the app checks that it is ready to use

#### AI & Brain

- You can talk with FRIDAY, and it keeps the thread of the conversation
- Local models and cloud models are both available, and you choose which one answers
- Paid cloud models stay off until you turn them on

#### Memory

- FRIDAY remembers across conversations, on this PC
- Those memories stay in your FRIDAY folder

#### Voice

- Auto Mode and Manual Mode with the same approval rules as typed chat
- Wake word, speech to text, and spoken replies are included. A real microphone has not been checked on a Windows PC

#### Capabilities

- Tools, skills, agents, plugins, and workflows
- Browser, terminal, devices, tasks, and a safe place to try things

#### Tools & Automation

- Setup, install help, diagnostics, and self-repair
- A personal desk for everyday work is already included

#### Security

- Permission tiers, privacy firewall, billing firewall and safety gates
- Updates are checked before they install, and you can roll back. Your data is not reset by a version number

#### Installation & Updates

- Windows installer and a portable app. Uninstall can keep your data, or you can choose to delete all of it
- Stable and Test update channels, so a test build can sit beside the app you use every day

#### Developer/Platform Support

- The Windows installer, the portable app, and update checks ship with this first version
- Documentation stays with the version you install

### Important Notes

- This is FRIDAY 1.0.0.0, the first public version: the complete app as it exists now.
- The capabilities above are part of this first version.
- Your FRIDAY data, settings, memory, models, connectors and workflows are not reset by this version number.
- Downloads are verified against the published SHA-256 before installation.
