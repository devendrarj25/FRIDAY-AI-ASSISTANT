# FRIDAY — Personal AI Assistant

<p align="center">
  <img src="src/assets/friday-logo.png" alt="FRIDAY" width="220" />
</p>

<p align="center">
  <strong>FRIDAY - AI ASSISTANT</strong><br />
  A Private, Autonomous and Self Learning OS Based on Local & Cloud Models
</p>

<p align="center">
  Owner and publisher: Devendra Singh Meena (devendrarj25) · Public version <strong>1.1.4.6</strong> · Windows
</p>

<p align="center">
  <a href="INSTALL.md">Install</a> ·
  <a href="docs/FRIDAY_USER_GUIDE.md">Use it</a> ·
  <a href="docs/FRIDAY_FEATURES.md">Features</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="FRIDAY_STATE.md">Project state</a>
</p>

FRIDAY is a personal assistant that lives on your own PC. You talk to it by typing or by voice, it answers with a local model when it can and a cloud model only when it must, and it can run tools, open files and drive the desktop for you. Everything it learns and everything you give it stays in **one folder you choose**. It is an Electron desktop app (a React window) with a local Python service behind it. There is no FRIDAY server and no account.

## Why FRIDAY

| | What it means |
| --- | --- |
| 🔒 **Private by default** | Chat, memory, files and keys stay on this PC. A privacy firewall keeps anything sensitive off a cloud model, and API keys sit in Windows-protected storage. |
| 🧠 **Local first, cloud when needed** | One router picks the model for each turn: a local engine such as Ollama or llama.cpp when it can do the job, a cloud provider only when it cannot and both firewalls allow it. |
| 💸 **No surprise bills** | Paid and unknown-cost models stay hidden until you switch paid access on. A model counts as free only with official evidence, and spend budgets stay in force. |
| 🎙️ **Voice that behaves** | Auto mode is the one voice session: wake word, speech to text, spoken replies, barge-in. Chat and Manual never open the microphone. |
| 🛠️ **Does things, with a dial for trust** | Skills, tools, agents, plugins and workflows run on request. You set the autonomy: ask every time, balanced, or full. *Stop everything* always halts it. |
| ♻️ **Safe to update** | An update replaces the program and never your data. Models are downloaded once and reused by the app, the Install Manager and the build. |

## What you can do

| | |
| --- | --- |
| 💬 Chat | Manual and Auto, streaming replies, the model you pick or the one the router chooses |
| 🎙️ Voice | Wake word, speech to text (Hindi, Hinglish and English), spoken answers, hands-free |
| 🧩 Flow Studio | A live chart of any chat or voice turn, or a diagram you attach, that you can edit |
| 🧠 Models | Local engines and cloud providers in one list, with hardware fit, free or paid status and live usage |
| 🧰 Install Manager | Languages, runtimes, libraries and local engines: detect, install, update, start and stop |
| 🗂️ Library and memory | Your uploads, notes, conversations and long-term memory in plain folders you can open |
| 🔌 Connectors and MCP | Link outside services, and let other tools reach FRIDAY through a local MCP server you turn on |
| 📱 Companion | A phone page on your own network that shares the same conversation |
| 📦 Windows install | A Setup installer and a portable app, with in-app update, verification and rollback |

Over two hundred skills, well over a hundred tools and agents, workflows, plugins and modules ship with it. The exact catalogue, with the file and the test behind each item, is [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md). The click-path for every page is [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md).

## How it fits together

```text
  You (type or speak)
        │
   ┌────▼──────────────┐   IPC    ┌──────────────────────┐   loopback   ┌──────────────────────┐
   │  React window      │◄────────►│  Electron main        │◄────────────►│  Python kernel        │
   │  src/              │          │  electron/            │              │  kernel/  (FastAPI)   │
   │  chat · voice ·    │          │  windows · updates ·  │              │  tools · memory ·     │
   │  models · Flow     │          │  credentials · models │              │  router · devices     │
   └────────────────────┘          └──────────┬────────────┘              └──────────┬───────────┘
                                              │                                      │
                                   ┌──────────▼──────────────────────────────────────▼───────┐
                                   │  Your FRIDAY folder (one root you choose)                 │
                                   │  App/  models/  memory/  library/  runtime/  config/ ...   │
                                   └───────────────────────────────────────────────────────────┘
```

- **The window never runs a shell.** It asks the main process over named channels; the main process and the kernel do the work and stream results back.
- **The router sits after the firewalls.** The privacy firewall and the billing firewall run first, then `kernel/router.py` chooses among what is left.
- **One folder holds everything you own.** The program (`App`) is replaced on every update. Models, speech weights, Python libraries, memory, conversations, uploads and settings are beside it and are never replaced or deleted by an update, a reinstall or a normal uninstall. What goes where is in [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md), and `inventory.json` in that folder lists every tool, model and speech weight with its location, version and whether a newer one exists.

## Get FRIDAY

| You want | Do this |
| --- | --- |
| Just use it | Download `FRIDAY-Setup-1.1.4.6.exe` (or `FRIDAY-Portable-1.1.4.6.exe`) from the GitHub release and run it. No Node, Python or Git needed. |
| Build it yourself | Clone this repository, open **Command Prompt**, then run the three commands below. |

```cmd
npm run setup        :: installs the whole toolchain and downloads the models once
npm run doctor       :: checks everything and repairs what it can
npm run build:win    :: builds, verifies and tests; prints FRIDAY BUILD READY with the files to use
```

Choose your FRIDAY folder once, before `npm run setup`, to have the models land straight in it: `set FRIDAY_WORKSPACE_ROOT=D:\FRIDAY`. If you do not, the build stages them next to the checkout and the installed app moves them into your folder on first launch, so nothing is downloaded twice. The full walkthrough, with the tool floors, the opt-out switches and first-launch steps, is [INSTALL.md](INSTALL.md).

An installed copy updates only from a verified release installer: size and SHA-256 are checked, only the program is replaced, your data is backed up first, and a rollback is kept. A source archive is for development and never replaces the packaged app.

## Safety, in short

- Exec-tier tools wait for your approval unless you raise the autonomy dial yourself; a fresh install is *Balanced*.
- Screen text, web pages, files, email and tool output are treated as data, never as instructions.
- A password field, a captcha, a payment screen, UAC and the secure desktop are never read, clicked or typed into.
- The undo journal, the audit log and the kill switch (tray pause and *Stop everything*) stay on. Details: [SECURITY.md](SECURITY.md) and [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md).

## Repository map

| Folder | Holds |
| --- | --- |
| `src/` | The React interface and the brain in `src/lib/friday/` |
| `electron/` | The Windows main process: windows, IPC, updates, credentials, Install Manager |
| `kernel/` | The Python service: tools, memory, router, devices, voice |
| `core/` | The Vitest contracts and tests (not shipped inside the EXE) |
| `agents/` `skills/` `tools/` `plugins/` `modules/` `workflows/` | The capability trees that ship as extra resources |
| `config/` | The version identity, tool floors, kernel settings and the project layout |
| `scripts/` `builder/` `installer/` `updater/` | Setup, the pack pipeline, the NSIS installer and the update channel |
| `docs/` | The registered documentation set |
| `memory/` `database/` `brain-data/` `conversations/` `models/` | The layout of the local stores (placeholders in Git; real data lives in your FRIDAY folder) |

## Documentation

Each topic has exactly one document. Open it for the detail and follow its links for the rest. The map below is generated; do not edit it by hand.

### Documentation map (one canonical document per topic)

<!-- docs-engine: generated map. Edit scripts/docs-engine.cjs, not this. -->

| Topic | Document |
| --- | --- |
| Full documentation index (every document, what it answers) | [docs/README.md](docs/README.md) |
| Install, local CMD pack, first-launch, upgrade, uninstall | [INSTALL.md](INSTALL.md) |
| Using Chat, Voice, Models, and every sidebar section | [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md) |
| Feature catalog with implementation and test map | [docs/FRIDAY_FEATURES.md](docs/FRIDAY_FEATURES.md) |
| Capability import JSON format | [docs/FRIDAY_IMPORT_FORMAT.md](docs/FRIDAY_IMPORT_FORMAT.md) |
| Architecture layers and IPC | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Architecture baseline and drift detectors | [docs/FRIDAY_ARCHITECTURE_BASELINE.md](docs/FRIDAY_ARCHITECTURE_BASELINE.md) |
| Master operating flow | [docs/FRIDAY_MASTER_FLOW.md](docs/FRIDAY_MASTER_FLOW.md) |
| Storage root, install, update, uninstall | [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md) |
| Providers, credentials, billing and privacy firewalls | [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md) |
| MCP server, MCP client, pairing, and scopes | [docs/FRIDAY_MCP.md](docs/FRIDAY_MCP.md) |
| Build paths, TEST identity, and Stable versus Test updates | [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md) |
| Version scheme and bump rules | [VERSIONING.md](VERSIONING.md) |
| Release runbook | [RELEASE.md](RELEASE.md) |
| GitHub Actions catalog | [docs/FRIDAY_GITHUB_ACTIONS.md](docs/FRIDAY_GITHUB_ACTIONS.md) |
| Repository workflow: branch, merge, cleanup, and revert | [docs/FRIDAY_MERGE_FLOW.md](docs/FRIDAY_MERGE_FLOW.md) |
| Change control, task packet, and development contracts | [docs/FRIDAY_CHANGE_CONTROL.md](docs/FRIDAY_CHANGE_CONTROL.md) |
| Contributor workflow and documentation contract | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security policy and reporting | [SECURITY.md](SECURITY.md) |
| Licence and ownership terms | [LICENSE](LICENSE) |
| Changelog of published versions | [CHANGELOG.md](CHANGELOG.md) |
| Verification evidence and open limitations | [AUDIT.md](AUDIT.md) |
| Cross-session project state briefing | [FRIDAY_STATE.md](FRIDAY_STATE.md) |
| Working rules and landing bar | [AGENTS.md](AGENTS.md) |

<!-- docs-engine: end generated map -->

## Status and honesty

Checks run on Linux in this checkout are not a Windows install. The CMD pack, install, update, uninstall and publish paths stay **NOT VERIFIED** until they are run on a Windows PC, and a physical microphone, wake word and GPU feel need real hardware. Every claim above has its evidence, or its "unverified" note, in [AUDIT.md](AUDIT.md) and [FRIDAY_STATE.md](FRIDAY_STATE.md).

## Version

The public version is read from `config/friday-version.json`; nothing else sets it. `npm run typecheck` prints it first, and npm's own `friday@…` line is the three-part encoding those tools require. Policy: [VERSIONING.md](VERSIONING.md). Publishing: [RELEASE.md](RELEASE.md). The build paths and the difference between Stable and Test: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## Contributing and licence

How a change is made, checked and merged: [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/FRIDAY_MERGE_FLOW.md](docs/FRIDAY_MERGE_FLOW.md). Security and reporting: [SECURITY.md](SECURITY.md). FRIDAY is private software; the terms are in [LICENSE](LICENSE).

---

## 9. What is new in 1.1.4.6

<!-- release-engine: generated section. Summary plus links only - the full
     write-up lives in the changelog and the release notes. -->

Released October 25, 2026 on the Stable channel - FRIDAY 1.1.4.6 includes reliability fixes and behaviour updates.

- Full detail for this release: **[releases/notes/v1.1.4.6.md](releases/notes/v1.1.4.6.md)**
- Changelog for the current public line: **[CHANGELOG.md](CHANGELOG.md)**
