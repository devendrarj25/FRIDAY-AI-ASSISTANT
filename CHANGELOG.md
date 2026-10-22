# FRIDAY — Changelog

What changed in each released version. Each entry is the owner-facing What's New for that version, kept in sync with releases/notes.

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
