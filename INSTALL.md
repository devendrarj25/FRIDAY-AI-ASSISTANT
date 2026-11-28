# FRIDAY — Windows Install and Build Guide

**Shipping version: 1.2.5.7**  
**Publisher:** Devendra Singh Meena (devendrarj25)

FRIDAY - AI ASSISTANT: A Private, Autonomous and Self Learning OS Based on Local & Cloud Models.

This guide takes you from nothing to a working FRIDAY on a Windows PC, one small step at a time: get the program (download it, or build it yourself with the Windows command prompt), install it, open it, add models, connect a cloud provider with an API key, check that everything works, then update it and, when you want, remove it. You do not need to know programming. Follow the numbered steps in order and do not skip the "What you should see" lines: they tell you whether a step worked.

Related documents (they are not copied here): version numbers [VERSIONING.md](VERSIONING.md); what Setup may replace on disk [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md); using every page after the app is open [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md); how the CMD, TEST and Official packs differ and how Stable and Test updates behave [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md); keys, billing and privacy rules [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md).

## Contents

1. [Words used in this guide](#1-words-used-in-this-guide)
2. [Choose your path](#2-choose-your-path)
3. [Before you start](#3-before-you-start)
4. [Path A: install the ready-made program from GitHub](#4-path-a-install-the-ready-made-program-from-github)
5. [Path B: build the program yourself](#5-path-b-build-the-program-yourself)
6. [Install the program you built](#6-install-the-program-you-built)
7. [Open FRIDAY the first time](#7-open-friday-the-first-time)
8. [Install models (so FRIDAY can think, hear and speak)](#8-install-models-so-friday-can-think-hear-and-speak)
9. [Connect a cloud provider with an API key](#9-connect-a-cloud-provider-with-an-api-key)
10. [Check that FRIDAY really works](#10-check-that-friday-really-works)
11. [Safety settings in plain words](#11-safety-settings-in-plain-words)
12. [Update FRIDAY](#12-update-friday)
13. [Reinstall FRIDAY](#13-reinstall-friday)
14. [Uninstall FRIDAY](#14-uninstall-friday)
15. [Quick fixes](#15-quick-fixes)
16. [Technical reference](#16-technical-reference)

## 1. Words used in this guide

| Word                       | Meaning                                                                                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CMD / Command Prompt**   | The black text window of Windows where you type commands. Open it: press the Windows key, type `cmd`, press Enter.                                                                                   |
| **EXE**                    | A Windows program file. FRIDAY comes as two: **Setup** (`FRIDAY-Setup-1.2.5.7.exe`, installs FRIDAY and can uninstall it) and **Portable** (`FRIDAY-Portable-1.2.5.7.exe`, runs without installing). |
| **FRIDAY folder ("root")** | The one folder where FRIDAY keeps everything that is yours: models, memory, chats, settings, database. The program itself sits in `<root>\App`. Default for Setup: `%USERPROFILE%\FRIDAY`.           |
| **Kernel**                 | FRIDAY's engine, a small Python program that runs on your PC next to the window. "Kernel ready" means the engine is running.                                                                         |
| **Model**                  | The AI "brain" file or service that writes the answers. A **local** model runs on your PC and works offline. A **cloud** model runs at a company and needs the internet and a key.                   |
| **Provider**               | A company that offers cloud models (Groq, OpenRouter, Google Gemini, OpenAI, Anthropic and others).                                                                                                  |
| **API key**                | A long secret text you create on the provider's website. FRIDAY uses it to talk to that provider for you. Treat it like a password.                                                                  |
| **Ollama**                 | A free program that runs local models. FRIDAY's setup installs it for you.                                                                                                                           |
| **Doctor**                 | FRIDAY's checker and repairer. As a command it is `npm run doctor`; inside the app it is the page **Setup & Doctor**.                                                                                |
| **Install Manager**        | The app page that installs and updates tools and voice models.                                                                                                                                       |

## 2. Choose your path

| Path                      | Choose it when                                                                    | What you do                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **A. Ready-made program** | You just want to use FRIDAY. No Node, Python or Git needed.                       | Download Setup from GitHub, run it ([section 4](#4-path-a-install-the-ready-made-program-from-github)).                 |
| **B. Build it yourself**  | You want to pack a new EXE from this source code, change the code, or test a fix. | Get the code, run three commands, install the EXE they make ([sections 5 and 6](#5-path-b-build-the-program-yourself)). |

Not sure? Choose **A**. Both paths end the same way: you open FRIDAY and continue at [section 7](#7-open-friday-the-first-time).

Official and TEST builds can sit side by side on one PC: TEST uses a different Windows app id (`dev.friday.desk.test`), installs its program into `<root>\TestApp` (Official uses `<root>\App`), keeps its data in `<root>\profiles\test`, and does not touch the Official install. If you installed a FRIDAY Test before 2026-11-21, it sits in `<root>\App`: uninstall that old FRIDAY Test first, run the Official Setup again over the same folder (your data is kept), then install the new FRIDAY Test ([docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md)). More in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

## 3. Before you start

You need:

- **Windows 10 or 11, 64-bit**, and a normal user account you will use every day. FRIDAY installs for that one user. Do not use "Run as administrator" unless that account is the one that should own FRIDAY.
- **The internet** for the first install: Path B downloads tools and models (about 10 GB in all on a first run). Path A needs only the Setup file; models are added later in the app.
- **Free disk space.** Path A: a few gigabytes for the program and its Python, then the models you choose (a small chat model is about 2 GB, bigger ones 4 to 10 GB or more). Path B: keep **at least 25 GB free**. A real first Path B run on a Windows 11 PC used about 15 GB: the Node libraries (about 0.3 GB), FRIDAY's Python environment (about 2.7 GB, of which the NVIDIA speech libraries are 1.9 GB), the speech and voice models (about 5.5 GB), the Qwen chat model (about 2.4 GB), the agent toolkit and the packs for the EXE, and about 1.4 GB for the two EXEs in `release\`. Doctor reports the free space on the drive that holds your models. Put FRIDAY on a drive with plenty of room.
- **A good folder.** Use a short, plain, local path such as `C:\FRIDAY` or `D:\FRIDAY`. Avoid `Program Files`, `Windows`, and folders that OneDrive, Dropbox or Google Drive keep in sync: they cause locked files and slow syncing. Setup refuses `Program Files`, `Windows` and a nested `FRIDAY\FRIDAY`.
- **A microphone and speakers** only if you want to talk to FRIDAY. Typing works without them.
- **A cloud key** only if you want cloud models. FRIDAY works offline with a local model alone ([section 9](#9-connect-a-cloud-provider-with-an-api-key)).

## 4. Path A: install the ready-made program from GitHub

1. On the Windows PC open the GitHub releases page of the repository `devendrarj25/FRIDAY-AI-ASSISTANT` (https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT/releases) and open the release tagged **v1.2.5.7**.
2. Under **Assets** download `FRIDAY-Setup-1.2.5.7.exe`. (Optional check: the same page lists `SHA256SUMS.txt`; the SHA-256 of your download must match its line. In CMD: `certutil -hashfile FRIDAY-Setup-1.2.5.7.exe SHA256`.)
3. Double-click the file you downloaded.
   - Windows **SmartScreen** may say "Windows protected your PC". The default build is not signed with a paid certificate, which is the honest reason. Click **More info**, then **Run anyway**, only if you downloaded the file from the real repository above. Signing does not by itself clear SmartScreen for a new publisher.
4. The wizard has **one page that matters: the FRIDAY folder.** Keep the default (`%USERPROFILE%\FRIDAY`) or type a short local path such as `D:\FRIDAY` (a whole drive such as `D:\` is refused: it must be a folder of its own). Click **Install**. If the folder is inside OneDrive, Setup asks once before accepting it (the default answer is No): syncing a database, a Python environment and multi-gigabyte models is slow and locks files. The folder is not recorded anywhere until files are really being installed, so pressing **Cancel** leaves an installed FRIDAY exactly as it was.
5. Setup copies the program into `<root>\App`, remembers your folder in `HKCU\Software\FRIDAY\WorkspacePath`, and then runs a repair helper (`installer/build/repair-runtime.ps1`) that prepares FRIDAY's Python engine in `<root>\runtime\.venv` (in your FRIDAY folder, not in the program folder, so an update finds it healthy and installs in seconds instead of downloading every package again) and installs its packages. The first install can take several minutes and needs the internet. It never aborts the install: if it cannot finish, FRIDAY is still installed, Setup records `PythonSetupPending`, and **Setup & Doctor** or **Install Manager** finishes the job later.
6. Tick **Launch FRIDAY** on the last page, or start FRIDAY from the Start menu or the desktop shortcut.

**What you should see:** a FRIDAY window opens. Go to [section 7](#7-open-friday-the-first-time).

**Portable instead of Setup.** `FRIDAY-Portable-1.2.5.7.exe` is the same version with no installer and no entry in Apps & Features. Put it in a folder you keep, double-click it, and pick your FRIDAY folder when asked. **The portable EXE is a program you run, not an installation:** it never starts at sign-in, never stays in the tray or the background after you close it (the X button asks first when tasks run, then quits FRIDAY and the programs she started), and in Settings the switches _Start Friday on system startup_, _Launch minimized to the tray_ and _Minimize to system tray_ show off with "Setup install only". It leaves nothing in the Windows start-up list.

**Portable and Setup run side by side and do not touch each other.** The portable EXE keeps its own settings, chats, memory, models, keys and logs in a folder named `FRIDAY-Portable-Data` next to the portable file (so the data travels with it; if that folder cannot be written, or the file sits in the `release\` folder of a source checkout, which the next `npm run build:win` deletes, it is `%LOCALAPPDATA%\FRIDAY-Portable-Data`; `FRIDAY_PORTABLE_DATA` names another folder, `FRIDAY_PORTABLE_ROOT` another FRIDAY folder, and a `FRIDAY_WORKSPACE_ROOT` left in your window belongs to the build and the installed FRIDAY, so the portable EXE ignores it). It never reads or changes the FRIDAY folder an installed FRIDAY uses, never writes the Windows registry, uses its own kernel port (8766; the installed FRIDAY keeps 8765) and its own taskbar identity, so you can run both at once, for example to test a fresh build with the portable EXE while your installed FRIDAY keeps working. Two portable copies in two folders are also separate. Because its data is separate, a new portable FRIDAY starts empty: connect your cloud keys again, and its first start prepares its own Python in its data folder: the boot screen shows _Preparing the portable Python environment_ while FRIDAY's Python packages install (a few minutes, needs the internet), then the kernel starts; open **Setup & Doctor** if it does not become ready. To bring your data across, close both FRIDAYs and copy the contents of your installed FRIDAY folder you want (for example `models`) into `FRIDAY-Portable-Data\FRIDAY`; keys are not copied because they are encrypted for each folder. An MCP client set up from the portable FRIDAY works only while it is open (the portable EXE runs from a temporary folder); set clients up from the installed FRIDAY. The portable EXE updates by replacing itself: **Settings → Updates** downloads the new `FRIDAY-Portable-<version>.exe`, checks its checksum, saves it beside the running file and starts it; it never runs the Setup installer, and the old file stays so you can go back. To remove it you delete the file yourself ([section 14](#14-uninstall-friday)). Prefer Setup when you want a Start-menu shortcut, easy updates and a proper uninstall with a keep-data or delete-all choice.

## 5. Path B: build the program yourself

This path needs a Windows PC with `cmd.exe` and the internet. It installs everything FRIDAY needs, builds the EXE, and checks it. The three commands you will use, in order, are `npm run setup`, `npm run doctor` and `npm run build:win`. Do them in the **Command Prompt**, not in Git Bash and not in PowerShell.

### 5.1 Install Git

Git downloads the source code. Check if you have it: open CMD and type `git --version`. If it prints a version, go to 5.2. If not, install it with either way:

```cmd
winget install --id Git.Git -e
```

or download "Git for Windows" from https://git-scm.com/download/win and run it with the default choices. Then **close CMD and open a new one** so Windows sees Git.

### 5.2 Get the code into your FRIDAY folder

The folder you build in becomes your FRIDAY folder, so choose it now. Type (you may replace `C:\FRIDAY` with another short local path; the folder must not exist yet or must be empty):

```cmd
git clone https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.git C:\FRIDAY
cd /d C:\FRIDAY
git pull origin main
```

`cd /d` moves CMD into that folder (the `/d` also switches drives). **What you should see:** `dir package.json` lists the file `package.json`. If it says "File Not Found" you are in the wrong folder; every later command is run from this folder (the **project root**).

### 5.3 Run setup

```cmd
npm run setup
```

If CMD answers `'npm' is not recognized`, you do not have Node.js yet. Run the same setup without npm; it installs Node.js for you:

```cmd
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
```

What setup does, in plain words: it checks the PC, installs what is missing (Node.js, Python, Git, PowerShell 7, FFmpeg, Tesseract, the Visual C++ runtime), downloads FRIDAY's code libraries, downloads the Electron app shell, creates FRIDAY's own Python environment, installs the agent toolkit, downloads the speech, voice and chat models, creates the folders and database, and finally runs Doctor.

- **It takes a long time.** The first run takes about 20 to 40 minutes on a fast line and up to 90 minutes on a slow one (in one real run the model downloads alone took about 6 minutes, and the Python packages about 3 minutes). It prints a lot of text, and some steps show a progress bar. Let it run. Do not close the window.
- **You can follow it.** Setup has **nine numbered steps**, each with a bar that fills as setup advances: `[FRIDAY] Step 1 of 9 ... The PC toolchain` up to `Step 9 of 9 ... Final readiness verification`. See [section 5.8](#58-what-a-good-run-looks-like) for what every step prints. Before Step 1, an unnumbered preflight checks the Windows build, free disk, the TEMP drive, the Root path and the administrator state, tests that nodejs.org answers, and prints the plan for this PC; a weak result is a notice, and only very low disk stops setup. Behind a company proxy, setup and Doctor use the system certificate store and the proxy from `HTTPS_PROXY` or the Windows proxy setting (details in `docs/FRIDAY_BUILD_AND_RELEASE.md`; unverified on a real proxy). Run `npm run setup` yourself to confirm.
- **Windows may ask for permission** (a blue-and-yellow "User Account Control" box) for WSL 2, Docker Desktop and Windows Sandbox (the CUDA Toolkit is optional and not installed by default). Allow it if you want those tools; setup carries on if you decline. Windows may ask for a restart afterwards.
- A long step that cannot draw a progress bar in a pipe (`npm ci`, the Electron download, the Python packages, a tool update) prints a line like `still working · 1m20s · 412 MB so far · 5.1 MB/s` every 15 seconds, so a quiet window is working, not stuck. `FRIDAY_ACTIVITY=0` turns those lines off.
- **Node.js and npm are updated after setup ends.** They run the setup, so they cannot be replaced from inside it. When a newer release exists, a hidden helper installs it as soon as this window's npm command ends (a Windows prompt may appear; log: `%TEMP%\friday-running-tools-upgrade.log`). The next `npm run setup`, `npm run doctor` or `npm run build:win` waits for it by itself, then says once whether it took effect: `ok Node.js was updated from 26.5.1 to 26.13.1 after the last setup`, or a `WARN` line with the exit code, the version that still answers and the one command to run in a new terminal. The installed version keeps working either way. `FRIDAY_SETUP_UPDATE_RUNNING_TOOLS=0` turns it off, and the two commands are printed instead.
- Setup never waits for a typed answer. If another window asks something, close it and run `npm run doctor`.
- Run it again any time: it is safe to repeat. A tool that is already new enough is reused; an old or missing one is installed at the latest stable release. The Node libraries are not reinstalled when `node_modules` already matches `package-lock.json` (`FRIDAY_FORCE_NPM_CI=1` installs them anyway), models already on disk are checked and not downloaded again, and a second run is much shorter than the first.

**What you should see at the end:** the Doctor verdict `DOCTOR PASS - FRIDAY is ready to test, build and run.` and then the line `SETUP PASS - FRIDAY is ready to test, build and run.` If Node.js was installed during this run and the next command says `node` is not found, close CMD, open a new one, `cd /d C:\FRIDAY`, and run `npm run setup` again.

**If it fails:** read the last lines; setup says which step failed and why. Then run `npm run doctor` (next step): it repairs and checks again. Most failures are a dropped network. More in [section 15](#15-quick-fixes).

### 5.4 Run Doctor

```cmd
npm run doctor
```

Doctor checks everything and repairs what it can. It is also the backup if setup stopped halfway. It runs **ten numbered checks** (`doctor 1/10` to `doctor 10/10`: dependencies, the environment table, the packs for the EXE, speech and chat models, the voice files (it makes FRIDAY speak a test line), the voice stack, runtime folders and database, main-process dependencies, the environment registry, and the pinned local runners against their newest release). **What you should see:** the table rows say `PASS` (a row that cannot apply to your PC, such as CUDA without an NVIDIA graphics card or Windows Sandbox on Windows Home, says `not applicable` and also counts as a pass), the table ends with `Ready to build.`, and the last line is `DOCTOR PASS - FRIDAY is ready to test, build and run.` If a row says MISSING, run `npm run doctor` again; if it stays, the row names the reason. Right after a successful setup Doctor does not repeat the speech and voice downloads (it says `verified by npm run setup a moment ago`); run `npm run doctor` later and it checks them in full.

### 5.5 Build the EXE

```cmd
npm run build:win
```

This packs **both** the Setup installer and the Portable EXE. It checks the PC again, builds the app window, packs the files, verifies them and runs the built program once as a test. It has **thirteen numbered steps** (`build 1/13 prepare-environment` to `build 13/13 installer-smoke`). A real run took about 8 to 10 minutes after setup, and the packing step alone (`packing the installer and portable EXE`) took about 4 minutes for two EXEs of 1.4 GB in all, so a quiet minute there is normal. **What you should see at the end:** a framed table that starts with **FRIDAY BUILD READY**, one `PASS` line per step, then the files to use. Two steps are **SKIP** on purpose on a local build and the table says so: `readiness` (installs the build and chats with it once) and `installer-smoke` (installs and uninstalls FRIDAY on this PC). That is still **READY**. If it ends with **FAILED**, it names the step and the reason; fix that, then run the same command again.

Your files are in the `release` folder inside your FRIDAY folder:

- `release\FRIDAY-Setup-1.2.5.7.exe` (the installer)
- `release\FRIDAY-Portable-1.2.5.7.exe` (no installer)
- `release\win-unpacked\FRIDAY.exe` (the unpacked program)

After a green run the build also copies the Setup, the Portable EXE, `friday-update.json` and `friday-bundle.json` into `installer\installers\<version>` inside your FRIDAY folder and adds a `placed` row to the closing table (SKIP, with the reason, when it could not). `set FRIDAY_PLACE_BUILD=0` turns that off. `set FRIDAY_BUILD_PACKS=1` also builds the FRIDAY weight packs into `installer\packs\<tag>` (off by default, about 28 GB, and only when your FRIDAY folder is not the source checkout). Unverified on Windows until you run it. Details: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

Optional: `npm run verify:install` runs the finished build once in a throwaway folder and chats with it (it needs a loaded local model or a cloud key for the chat part).

Want only one? `scripts\build-windows.cmd nsis` builds Setup only, `scripts\build-windows.cmd portable` builds Portable only, and `npm run build:win:dir` builds only the unpacked folder (fastest, for testing).

### 5.6 Just try it without installing (optional)

To run the program straight from this folder without installing an EXE:

```cmd
npm run desktop:start
```

(`npm run desktop:dev` is the developer version.) You still need the FRIDAY folder and a ready kernel; [section 7](#7-open-friday-the-first-time) onwards applies.

### 5.7 The whole of Path B on one screen

```cmd
git clone https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.git C:\FRIDAY
cd /d C:\FRIDAY
npm run setup
npm run doctor
npm run build:win
```

Packing needs Windows. On Linux or macOS `npm run build:win` is not available by design.

### 5.8 What a good run looks like

This is what the real commands print on a healthy Windows 11 PC, so you know what "fine" is. The exact numbers on your PC differ.

| Command             | What you see                                                                                                                                                                                                              | The last lines                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run setup`     | `Step 1 of 9` PC toolchain, `2` Node libraries, `3` Electron, `4` Python environment and voice models, `5` agent tools, `6` packs for the EXE, `7` runtime folders and database, `8` repair, `9` final readiness (Doctor) | `DOCTOR PASS`, then `SETUP PASS - FRIDAY is ready to test, build and run.`                 |
| `npm run doctor`    | `doctor 1/10` to `doctor 10/10`, the environment table, then a short list of the ten checks                                                                                                                               | `DOCTOR PASS - FRIDAY is ready to test, build and run.`                                    |
| `npm run build:win` | `build 1/13` to `build 13/13`                                                                                                                                                                                             | a framed table: `FRIDAY BUILD READY`, `PASS` or `SKIP` per step, and the paths of the EXEs |

How to read the colours on a normal console (Windows Terminal, or CMD on Windows 10 and 11):

- A finished step starts with a **green `√`** and then its name, with the time and the size in **purple** (`√ pip  done in 37s · 296 MB`). A step that failed starts with a red `×`.
- A **progress bar** is a row of small rectangles: the part that is done is **green**, the rest dark grey, a failed one red. The same bar is used for model downloads, packs and the numbered steps.
- In a log file, in CI, or with `NO_COLOR=1`, the same bars are plain text (`[#####-----]`) and nothing is lost. `FRIDAY_ASCII=1` makes the spinner plain ASCII for an old console.
- Lines that begin with `INFO` or `SKIP` are not failures. Typical on a healthy PC: `Sandbox runner (Windows Sandbox) skipped: not available on this Windows edition` on Windows Home; `readiness` and `installer-smoke` skipped on a local build; `latest-release check: off for this run` when setup already checked within the last day.
- A line that says `already installed; not downloaded again` is the setup being careful, not slow.

## 6. Install the program you built

1. Close any FRIDAY that is running.
2. Open the `release` folder and double-click `release\FRIDAY-Setup-1.2.5.7.exe`. The wizard is the same as in [section 4](#4-path-a-install-the-ready-made-program-from-github). Because you built in your FRIDAY folder, the wizard already offers that folder as the install folder: accept it.
3. A packed **TEST** build (`FRIDAY-Test-Setup-…`) installs beside Official and keeps its own data; do not mix their folders.
4. Installing a locally built Setup over an older Official of the **same** four-part version is a rebuild of that version, not a version bump. Changing the version number is the owner's decision (`config/friday-version.json`).

Then go to [section 7](#7-open-friday-the-first-time).

## 7. Open FRIDAY the first time

1. **Start it** from the Start menu or desktop shortcut (or `<root>\App\FRIDAY.exe`). It opens a window and a small icon appears in the system tray (near the clock). With the installed (Setup) FRIDAY, closing the window hides her to the tray so she keeps running; to quit completely use the tray icon menu. With the Portable EXE, closing the window quits her.
2. **Choose the FRIDAY folder** if the app asks. Pick a writable folder (not `Program Files`). If you set up in `C:\FRIDAY` or installed there, it is already chosen. Models downloaded during setup and waiting in `.friday-dev` are moved into your folder on this first launch; an item your folder already has is never overwritten, and nothing is downloaded twice.
3. **Wait for the kernel to become ready.** Look at the title strip, or open **FRIDAY Status** in the left menu. Until the kernel is ready, chat and Doctor are not meaningful. A few minutes on the very first start is normal.
   - If it stays down, open **Setup & Doctor** and press the repair button, then **Install Manager**. A leftover `PythonSetupPending` means the installer's Python repair did not finish; the same pages finish it.
4. **Know the left menu.** The pages you will use now:
   - **Friday (Main Window):** the chat. Manual or Auto, a model picker, streaming answers.
   - **Models:** local and cloud models, providers and keys.
   - **Install Manager:** tools, services and voice models; updates for them.
   - **Setup & Doctor:** checks and repairs.
   - **FRIDAY Status:** read-only health of the kernel and Python.
   - **Settings:** voice, look, updates, start at sign-in, autonomy.

**Two modes of chat.** **Manual** is typing only. **Auto** is the voice mode: the microphone is open and FRIDAY speaks her answers. Manual and chat never listen and never speak. Hands-free is the Auto conversation; turning it off means you must say the wake word first.

## 8. Install models (so FRIDAY can think, hear and speak)

FRIDAY needs three kinds of models. You can start with the first only.

### 8.1 A chat model (the brain)

You need **at least one**: a local model, or a cloud key from [section 9](#9-connect-a-cloud-provider-with-an-api-key).

- **If you did Path B,** setup already installed Ollama and downloaded the chat model that fits this PC (setup measures the PC first and prints a "this PC" block; the tier follows the PC's total memory and its graphics card: a PC with a 6 GB card gets `qwen3.5:4b`, a 4 GB PC gets `qwen3.5:0.8b` with a 2048-token window, a PC with 3 GB or less gets none, and a large-memory PC gets a larger one; an already installed model that is as good is kept; a small `qwen3.5:0.8b` or `qwen3.5:2b` is also pulled as the fast voice twin, as an optional extra) into it. Check in **Models → LOCAL AI → Installed**; it should be listed as installed.
- **Otherwise (Path A),** add one:
  1. Open **Models** and the **LOCAL AI** section, then **Catalog**.
  2. The Catalog opens on **Runs on this PC**: FRIDAY measured your RAM, graphics card and free disk space and ranks models best-fit first (Optimal, Supported, Tight, CPU only, Unsupported). Pick one marked Optimal or Supported. A good first choice is `llama3.2-3b`.
  3. Press **Install**. A row with progress, **Pause** and **Cancel** appears. Wait until it says installed. If Ollama is missing, Install Manager (below) installs it first.
  4. Search a model by name in the search box (Enter or **Search online** also looks in the Hugging Face index) or **Import & Connect** to add your own `.gguf` file.
- **Local engines FRIDAY finds by herself** once they are running: Ollama (port 11434), LM Studio (1234, with a model loaded), llama.cpp (8080), vLLM (8000), LocalAI (8081), Jan, KoboldCpp (5001), GPT4All (4891, with its Local API Server turned on). Their models appear when the engine answers.

**What you should see:** in **Friday (Main Window)** the model picker lists the model. Pick it, type "hello", press send, and an answer streams in.

### 8.2 The voice packages (hearing and speaking)

Voice needs two Python packages in FRIDAY's own environment: `faster-whisper` (hearing) and `edge-tts` (speaking). Path B installs them. If they are missing, open **Install Manager**, find the rows `faster-whisper` and `edge-tts` and press **Install**. FRIDAY also works without voice (typing only).

- **Speech size (hearing quality).** **Settings → Voice → Speech model size** lists faster-whisper sizes `tiny`, `base`, `small`, `medium`, `large-v3` and `large-v3-turbo`. Bigger is more accurate and slower, and needs more memory. Leave it on **Auto** if unsure; pick `large-v3-turbo` only if you want it, and FRIDAY downloads it from inside the app.
- **Voices (speaking).** The default voice is `hi-IN-SwaraNeural` (a female Indian voice) when the internet is on and Privacy mode is off. Offline, **Supertonic 3** (voice F2) speaks when installed, otherwise a female Indian Windows voice. In Install Manager you can add optional voice models: Silero VAD, Smart Turn, Supertonic 3. In a source folder, `npm run voice:install` downloads Supertonic, Smart Turn and the English Moonshine hearing model, and `npm run voice:check` prints PASS or FAIL for each stage.
- **Teach FRIDAY your voice (optional).** **Settings → Voice → My voice** records you so FRIDAY wakes for your voice. **Settings → Voice → FRIDAY's voice** picks her voice.

### 8.3 Install Manager: tools and services

Open **Install Manager** for the tools FRIDAY can use on your PC: Git, Node, Python, ffmpeg, Docker, Graphviz and many more.

- The page re-reads your PC every five minutes and after every install. A row shows installed or missing, the installed version and the newest version.
- Press **Install** on a row, or **Update** to update it. It uses `winget` first and the vendor's own checked installer if winget cannot. **Refresh** reads again; **Update all** updates what has a newer version; **Cancel** stops a download or an installer.
- On an app installed from a release, the button **Install agent toolkit** installs the same toolkit Path B installs (search and convert helpers, Git and build tools, Go, Rust, Java with Maven and Gradle, C and C++ (GCC), Ruby, PHP with Composer, .NET with dotnet-script, eSpeak NG, WSL 2, Docker, Windows Sandbox, and CUDA with an NVIDIA card). Some of these ask for administrator approval.
- **Local builds:** the **Local builds** panel looks on this PC for a build made with `build:win` (or a Setup folder that carries `friday-bundle.json`) and **Use local builds** copies the models it holds into your FRIDAY folder, so they are not downloaded again. Only files that match the recorded SHA-256 are used, nothing is overwritten and the build folder is never changed. The switch **Look for local builds before downloading** is on by default (setting `install.useLocalBuilds`; `FRIDAY_LOCAL_BUNDLES=0` turns it off for a run). Order for a model: a local build, the FRIDAY release, the official source. Unverified on Windows.
- **Your own tools:** the **Software** section can add anything that installs with winget, npm or pip.
- **Services** (Ollama, LM Studio, Docker Desktop) can be started and stopped there.

### 8.4 Diagram tools (optional)

Flow Studio draws and exports without extra tools. Install Manager can add Graphviz 16.1.0 and D2 0.9.0 for compiled diagrams; a missing compiler leaves the canvas working.

## 9. Connect a cloud provider with an API key

A cloud provider lets FRIDAY use a big model over the internet. **This is optional**: a local model alone works offline. Keys cost nothing to create on the free tiers below; paid models stay switched off until you allow them.

### 9.1 Get a key (free tiers)

Open the provider's website, sign in or sign up, create an API key, and copy it.

| Provider          | Where to create the key                |
| ----------------- | -------------------------------------- |
| **Groq**          | https://console.groq.com/keys          |
| **OpenRouter**    | https://openrouter.ai/keys             |
| **Google Gemini** | https://aistudio.google.com/app/apikey |

Other providers (OpenAI, Anthropic, DeepSeek, Mistral, Together, xAI, Cohere, Perplexity, Hugging Face and more) have a card in **Models → CLOUD AI → Providers** that names the official page. Azure OpenAI, Bedrock, Vertex, "OpenAI-compatible" and "Custom" are listed as "no connector yet" and cannot be connected.

### 9.2 Paste the key into FRIDAY

1. Open **Models** and the **CLOUD AI** section, then **Providers**.
2. Find the provider's card. Open **Connections**, paste the key, and press **Connect**.
3. FRIDAY checks the key and says what happened: **"connected — N models ready"**, or "did not connect" with the provider's reason (a wrong key, no credit, a network problem).
4. The key is stored encrypted in Windows (Electron `safeStorage`) for your Windows user only. It is never written to a plain file, and on another PC or another Windows account you enter it again.

**What you should see:** the provider's models appear in the chat model picker and in **Models → CLOUD AI → Catalog**.

### 9.3 Free, paid and private: what FRIDAY will and will not do

- **Free models appear on their own.** A model counts as free only when the provider's own pricing page says so. Free models are available for Auto and for a manual pick.
- **Paid and unknown-cost models stay hidden** until you turn paid access on and set a budget. Select **Confirm paid** before a paid model can be chosen; **Save selection** is your allowlist. A valid key is not the same as a verified free model.
- **Private text never goes to the cloud.** The privacy firewall keeps sensitive text on a local model. Privacy mode also keeps FRIDAY from using online voices.
- **Local first.** A local model answers when it can; the cloud is used only when it cannot and both firewalls allow it.
- A key that hits its limit stays listed, greyed, with the reason and when it comes back.
- Full rules: [docs/FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md).

## 10. Check that FRIDAY really works

Do these in order. Each takes a minute.

1. **Status.** Open **FRIDAY Status** and **Setup & Doctor**. The kernel and the Python environment should be healthy.
2. **Manual chat.** In **Friday (Main Window)** choose Manual, pick a model, send "hello". An answer must arrive. It needs a local model with a pulled model, or a cloud key that connected.
3. **Which model answered.** The strip above the conversation says which model will answer before you send and which did answer after.
4. **Auto (voice).** Switch to Auto. Auto is ready only when the speech model is actually loaded, not merely installed. Say "FRIDAY, what time is it?" You should hear the answer and see it on screen. Say "stop" while she speaks: she stops. Mute stops the microphone; the tray icon pauses it.
5. **Wake word (optional).** FRIDAY ships no trained wake model yet; until one is trained and passes its test, the wake word is matched in the transcript. A model of your own needs `{word}.onnx` in `<root>\models\wake`; a word `jarvis` must load `jarvis.onnx`, `friday.onnx` is not a substitute.
6. **A real microphone and speaker test is yours to do.** The checks above are only real on your hardware. A longer voice checklist is in [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md).

## 11. Safety settings in plain words

- **Autonomy** (Settings, and the toolbar of Auto mode and Flow Studio): **Ask every time**, **Balanced** (the default on a fresh install: she asks before she writes or runs something), **Full autonomy** (she acts without asking each time). **Stop everything** always halts her.
- Running commands needs your approval by default (`auto_approve_exec` is off).
- Screen, web, file, e-mail and tool text is treated as data, never as orders. A password field, a payment and a captcha are never touched.

## 12. Update FRIDAY

### 12.1 From inside the app (the normal way)

1. Open **Settings → Updates**. Read the short guide at the top.
2. **Repository.** Press **Use the official FRIDAY repository** (or paste the address `https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT`). A public repository needs no token. For a private one, create a GitHub fine-grained token with only this repository and the permission **Contents: Read-only** and paste it. That token can read but never write, so updating cannot change your repository.
3. Press **Test connection**. It tells you public or private, whether the token is read-only, and the newest Stable and Test builds.
4. Pick **Stable** (normal) or **Test** (early builds, for testing only).
5. Press **Check for updates**, read what the files are for, then **Install**.
6. FRIDAY checks the installer's SHA-256, backs up your protected data, closes, installs silently, and reopens on the new version. If the new version does not start, the panel offers to restore the backup and the old program is reopened.

Good to know: the connection is remembered; FRIDAY checks a few seconds after start and tells you in Notifications when a new version exists; she downloads and checks the installer in the background (switch off under **Automatic updates**) so Install is instant, but **nothing installs until you press Install**. From the second update on, only the changed parts are downloaded. A dropped download continues from the same place (Cancel stops it, Retry resumes). Your chats, memory, settings, models, voices, downloads and uploads are never replaced. After an update FRIDAY installs any new Python packages the version needs and asks you to restart. An installed FRIDAY is never replaced by a source ZIP; **Update content** may merge only new skills, agents, plugins, modules, workflows, resources and docs.

### 12.2 By hand

Download the new `FRIDAY-Setup-<version>.exe` from the GitHub release and run it over the old install, choosing the **same FRIDAY folder**. Setup replaces `<root>\App` only; everything else in your folder stays.

### 12.3 Update the tools FRIDAY uses

Open **Install Manager**, press **Refresh**, then **Update** on a row or **Update all**.

### 12.4 Update your own build (Path B)

```cmd
cd /d C:\FRIDAY
git pull origin main
npm run setup
npm run doctor
npm run build:win
```

Then run the new `release\FRIDAY-Setup-1.2.5.7.exe` (the file name carries the version of the code you pulled). If `git pull` reports local changes, stop and ask before overwriting anything.

## 13. Reinstall FRIDAY

Reinstalling keeps your data when you do it right.

1. Uninstall with the **keep data** choice ([section 14](#14-uninstall-friday)).
2. Run `FRIDAY-Setup-1.2.5.7.exe` again and choose the **same FRIDAY folder**.
3. Open FRIDAY: your chats, memory, models, settings and keys-to-reconnect are still there. Doctor repairs the Python engine if needed.

A clean start instead: uninstall with **Delete all FRIDAY data**, then install.

## 14. Uninstall FRIDAY

**Back up first if the data matters.** Everything that is yours (chats, memory, library, settings, models, database) lives in your FRIDAY folder. Close FRIDAY, then copy that folder to another drive: that is a backup. API keys are stored encrypted for your Windows user and are not part of a copy that works on another PC or account, so connect them again ([section 9](#9-connect-a-cloud-provider-with-an-api-key)). A normal update also makes its own safety backup before it installs (`backup\releases` in your FRIDAY folder).

1. Open Windows **Settings → Apps → Installed apps**, find **FRIDAY** (or **FRIDAY Test**) and choose **Uninstall**. Close FRIDAY first, or let the uninstaller close it; it also stops FRIDAY's own Python and Node helper programs.
2. **Keep data (default).** Only `<root>\App` is removed. Your database, models, memory, library and the rest of the FRIDAY folder stay. Reinstall later and you are back.
3. **Delete everything.** Tick **Delete all FRIDAY data and resources**, and confirm. The uninstaller first stops FRIDAY and every program that runs from the FRIDAY folder or stands in it (a leftover runner, an Ollama that FRIDAY started, a Python process; your own command windows, editors and file manager are never closed), then removes the folder, so the folder itself disappears and Windows no longer answers "try again". If a program of yours keeps a command window open inside that folder, close that window and delete the empty folder. This removes the whole FRIDAY folder. If your FRIDAY folder is the **source checkout** you built in (the usual case after `git clone ... C:\FRIDAY`), the page shows a second box, **...but keep my source code, Git history and build output in it**, unticked: with only the first box ticked and the question answered Yes, the whole folder is removed, source code and Git history included (the question says so). Tick the second box to remove only the data folders and downloaded models and keep the code. Close any command window or editor that is open inside the folder first: a window standing in a folder keeps Windows from removing it. A silent `/S /DELETEDATA` uninstall never removes a source checkout.
4. From a script: `Uninstall FRIDAY.exe /S /DELETEDATA` does the delete-all uninstall silently.
5. The uninstaller also removes the "start at sign-in" entry.
6. **Portable:** delete the `FRIDAY-Portable-1.2.5.7.exe` file and, if you want its chats, memory, models and settings gone too, the `FRIDAY-Portable-Data` folder next to it; there is no entry in Apps & Features, and nothing of an installed FRIDAY is touched.

Windows will not silently wipe your folder: the installer is set to keep data unless you tick the delete box.

## 15. Quick fixes

| What you see                                                 | What to do                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'npm' is not recognized`                                    | Node.js is not installed yet. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows.ps1`, then open a **new** CMD.                                                                                                                                                                       |
| `node` is not found right after setup installed it           | Close CMD, open a new `cmd.exe`, `cd /d` back to your FRIDAY folder, run `npm run setup` again.                                                                                                                                                                                                                   |
| `python` opens the Microsoft Store                           | Windows Settings → Apps → Advanced app settings → App execution aliases → turn off `python.exe` and `python3.exe`.                                                                                                                                                                                                |
| Setup stops on one step                                      | Only a blocker stops setup (Node.js, npm, the dependency install, Electron, build tools, NSIS, the Python environment with its core kernel packages, SQLite). Read its reason, then run `npm run doctor`: it repairs and checks again. Network errors: run it again; set `HTTPS_PROXY` if you are behind a proxy. |
| The bars or the tick show as boxes or strange characters     | Use **Windows Terminal** or a current CMD with a normal font (Consolas, Cascadia). `NO_COLOR=1` turns colours off and `FRIDAY_ASCII=1` makes the spinner plain; the numbers and words are the same.                                                                                                               |
| The build ends `FRIDAY BUILD READY` but two lines say `SKIP` | Normal on a local build: `readiness` and `installer-smoke` are left for `npm run verify:install` and `FRIDAY_BUILD_INSTALLER_SMOKE=1`.                                                                                                                                                                            |
| A quiet minute while packing or downloading                  | Normal. The packing step takes about 4 minutes for two EXEs; a `still working` line appears every 15 seconds. Do not close the window.                                                                                                                                                                            |
| The next npm command seems to wait after setup               | Setup is installing a newer Node.js in the background (log: `%TEMP%\friday-running-tools-upgrade.log`). The command waits for it by itself.                                                                                                                                                                       |
| `build:win` says FAILED                                      | The last lines name the step. Fix it (often a re-run of `npm run doctor`), then run `npm run build:win` again.                                                                                                                                                                                                    |
| FRIDAY opens but the kernel never becomes ready              | **Setup & Doctor** and **Install Manager**; look for `PythonSetupPending`. The repair is the environment in `<root>\runtime\.venv`, never a global Python.                                                                                                                                                        |
| Chat says "No models loaded"                                 | Install a local model ([section 8.1](#81-a-chat-model-the-brain)) or connect a key ([section 9](#9-connect-a-cloud-provider-with-an-api-key)).                                                                                                                                                                    |
| Key says "did not connect"                                   | Read the reason on the card: wrong key, no credit, or no network. Create a new key and paste it again.                                                                                                                                                                                                            |
| FRIDAY does not hear me                                      | Set it to Auto; check Windows microphone permission; unmute; make sure the tray pause is off; check that the speech model is loaded (Settings → Voice).                                                                                                                                                           |
| SmartScreen warning                                          | The default build is unsigned. Use More info → Run anyway for a file you downloaded from the official repository.                                                                                                                                                                                                 |
| Official and TEST are both installed                         | Expected: different app ids. Uninstall the one you do not want.                                                                                                                                                                                                                                                   |
| Anything else                                                | Open **Setup & Doctor**, press repair, then see the technical table in [section 16.6](#166-troubleshooting-technical).                                                                                                                                                                                            |

## 16. Technical reference

Everything below is the exact detail behind the steps above. You do not need it to follow the guide.

Notes that apply to everything below:

- Every command is run from the **project root** (the folder that contains `package.json`) in Windows `cmd.exe`. `npm run build:win` must stay the backslash CMD path: it is the owner-verified pack launcher.
- Hosted GitHub Actions (PR Validation, FRIDAY Test Build, FRIDAY Release) are run by the owner on GitHub, never from this guide. An official release is Actions → **FRIDAY Release**, not a CMD command; a branch EXE is Actions → **FRIDAY Test Build**.
- On Linux or macOS `npm run setup` and `npm run build:win` are not available by design (they need `winget`, `msiexec` and `cmd.exe`); `setup:python`, `setup:electron`, `init:runtime` and `check:env` do run there.

### 16.1 What `npm run setup` does inside

From that same folder:

```cmd
npm run setup
```

That runs `scripts\setup-windows.ps1` via `powershell.exe` (Windows PowerShell 5.1). The script is 7-bit ASCII so 5.1 can parse it. It is idempotent: a tool already at or above its floor is reused, never downgraded; a tool that is missing or older is installed at the **latest stable release** from the official source. **Nothing is optional:** everything the setup installs is needed, so a tool, model or package that cannot be installed stops the setup with its reason (and `npm run doctor` repairs and checks again). Only what cannot apply to your PC is skipped and shown as `not applicable` (CUDA without an NVIDIA GPU, Windows Sandbox on an edition that lacks it); hosted CI, an offline build, `FRIDAY_PREFETCH=0` and `FRIDAY_PREFETCH_TOOLKIT_ELEVATED=0` are choices you make on purpose.

**Latest releases (once a day).** Setup detects each tool first, keeps a supported one, and asks its official source for a newer release: `winget upgrade` for Python, Git, PowerShell, FFmpeg and Tesseract; `pip install --upgrade` (and a pip self-upgrade) for the Python packages; the published, SHA-256-checked, Authenticode-checked installer for Ollama. Node.js and npm run this very setup, so a newer release is only named, never swapped under it. The check runs at most once a day (`.cache/setup-update.json`); `FRIDAY_SETUP_UPDATE=1` asks now, `FRIDAY_SETUP_UPDATE=0` (also set by hosted CI and `FRIDAY_OFFLINE=1`) turns it off. A newer release that cannot be installed leaves the supported copy in place and the setup goes on. The package list is saved before a newest-release install (`temporary/downloads/pip-before-upgrade.txt`) and restored when the kernel no longer loads. The python.org fallback never goes past the series whose wheels are proven (`pythonWheelProven`). When the capability list fails as a set, each package is installed on its own, so one package without a wheel cannot leave the others out.

**llama.cpp.** Setup installs the pinned CPU build of llama.cpp when the PC plan says so (`FRIDAY_PREFETCH_LLAMACPP=0` opts out); a CUDA or Vulkan build is only offered in Install Manager for a PC with a real graphics card. `node scripts/prefetch-models.cjs --plan` prints what setup would do on this PC and downloads nothing. The speech engine, faster-whisper, installs with the Python packages and its weights come from the model step below; setup brings the speech sizes `tiny`, `base`, `small`, `medium` and `large-v3` (the last two only on a PC with enough memory), Moonshine, the offline voice and one Qwen model in Ollama (`qwen3:4b`). `large-v3-turbo` is not part of setup: pick it in Settings, Voice, Speech size and FRIDAY downloads it from inside the app (`FRIDAY_PREFETCH_STT_BIG=1` adds it to setup). `npm run voice:stack` checks every runner, model, package, router, gate and connection of the voice mode and exits 1 on a gap (`--root <FRIDAY folder>` also checks what is on disk).

**Models.** The Python packages install first and the speech, voice and chat models after, so one failed model never stops the capability packages. When Ollama's registry cannot be reached (`FRIDAY_OLLAMA_PULL_IDLE_S`, default 60 s without progress, ends a stalled pull), the small chat model is downloaded as a GGUF and registered in Ollama under its tag, so later runs do not pull again. A Hugging Face client that fails once in a run is skipped for the rest of it (30 minutes) and FRIDAY's own downloader is used. A failed download or optional install is a notice, not a stop: setup goes on, records the item in `runtime\setup-notices.json`, and FRIDAY shows it under **Needs finishing** in Install Manager and Models with an Install or Repair button. `FRIDAY_SETUP_STRICT=1` restores the stop. Details: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md), Notice tier.

**Doctor** (`npm run doctor`) marks every package of `kernel/requirements-capabilities.txt` as required on a Windows PC that builds FRIDAY (chromadb stays optional: SQLite memory is the fallback) and gives every SKIPPED row its reason.

The whole chain is: `npm run setup` (install everything) → `npm run doctor` (check and repair; the backup when setup stopped halfway; it also runs the voice files for real and checks the voice stack) → `npm run build:win` (check the PC again, install what is still missing, build, verify, run the requirement tests, print **FRIDAY BUILD READY** with the files to use).

Inside the script, in order (the number is the `[FRIDAY] Step N of 9` line it prints):

1. **Step 1, the PC toolchain.** Node, Python, Git, PowerShell, npm: each is detected, a supported one is kept, and each method prints `method failed:` before the next official source runs. FFmpeg, Tesseract and the VC++ runtime are required and installed the same way; setup stops if one stays missing.
2. **Step 2, Node dependencies.** `node scripts\node-modules-current.cjs` asks whether `node_modules` already matches `package-lock.json`; if so `npm ci` is skipped (`FRIDAY_FORCE_NPM_CI=1` installs anyway). Otherwise `npm ci` from `package-lock.json`; on failure `npm cache verify` then `npm ci` again with `https://registry.npmjs.org/`.
3. **Step 3, Electron.** `node scripts\ensure-electron.cjs` (npm installer, GitHub Electron zip checked against its SHA-256 list, the public npmmirror copy of the same zip, then `@electron/get`), then the installer tools (NSIS) electron-builder needs, cached under `.cache\electron-builder`.
4. **Step 4, Python environment and voice models.** `node scripts\setup-python.cjs`: the venv at the selected FRIDAY folder `runtime\.venv` (or checkout `.venv` if no folder is selected), the kernel packages, the capability extras, the semantic-memory model, the NVIDIA speech libraries on a PC with an NVIDIA card, Ollama and the speech, voice and chat models, and the voice tests. On a PC the voice plan says can carry it, it also downloads the optional streaming ear (about 755 MB); if that download fails setup prints a NOTE and goes on, because the normal listening path stays in use (unverified on Windows).
5. **Step 5, agent tools.** `node scripts\prefetch-toolkit.cjs` installs the agent toolkit of `config\agent-toolkit.json` (ripgrep, jq, yq, Ninja, uv, aria2, FFmpeg, Git, GitHub CLI, CMake, 7-Zip, Pandoc, Graphviz, Tesseract, PowerShell 7, Go, Rust, OpenJDK, Maven, Gradle, GCC and G++, Ruby, PHP, Composer, .NET SDK, dotnet-script, eSpeak NG, WSL 2, Docker Desktop, Windows Sandbox, and CUDA on an NVIDIA PC). Installed tools are reused, older ones updated, WSL 2 / Docker / Sandbox / CUDA show a Windows administrator prompt, and a failure never fails setup. `FRIDAY_PREFETCH_TOOLKIT=0` skips it, `FRIDAY_PREFETCH_TOOLKIT_ELEVATED=0` skips only the administrator ones. Re-run it alone with `npm run setup:toolkit`.
6. **Step 6, packs for the EXE.** The packs that ship inside the EXE (Python embed, get-pip, Node, whisper.cpp, a small speech model) are fetched into `.cache`, so the build downloads nothing.
7. **Step 7, runtime folders and database.** `node scripts\init-runtime.cjs`: folders, wake model, database.
8. **Step 8, repair.** `node scripts\check-environment.cjs --fix`.
9. **Step 9, final readiness verification.** `npm run doctor`. Success prints `DOCTOR PASS` and `SETUP PASS`; items that can be finished later are counted on the `DOCTOR PASS` line and do not stop it. The interface bundle (`dist-desktop`) is **not** required here; `npm run build:win` builds it. For the toolchain alone, `scripts\setup-windows.ps1 -ToolchainOnly` installs only Node.js, npm, Python, Git, PowerShell, FFmpeg, Tesseract and the Visual C++ runtime (doctor and the build call it, and it prints no `Step 1 of 9` there).

What the log tells you on a real PC:

- A line such as `Git LFS ... left as it is` or `... is the newest version winget offers` is not a failure: winget had nothing newer, or the tool came inside another package (Git LFS inside Git for Windows). When the vendor's own feed lists a newer release than winget does (Git for Windows `.windows.4`, a Go patch release), the update continues with the vendor's installer after its SHA-256 and signature check, asking for administrator rights once for a copy under Program Files; if that installer cannot finish, the working copy stays and the line says so. A tool already on the PC is used from where it is: the folders the toolkit probes (Go, CMake, 7-Zip, cargo, winget's link folder ...) are added to the PATH of FRIDAY and of the commands she starts when they exist, and nothing is downloaded or copied again.
- Windows Sandbox is reported `not applicable` on Windows Home (the feature exists only on Pro, Enterprise and Education). It never stops setup or the build.
- Rust counts as installed only when `rustc` runs. It installs from the official `rustup-init` (SHA-256 from static.rust-lang.org, per user, `-y`, no administrator, no prompt) before winget is tried, because the winget package is only the launcher. The install reads only the small digest file first; the large channel document that names the version has a 45-second limit and falls back to the compiler's GitHub release, so a slow line can no longer make the whole official source look unavailable, and a feed that gives nothing says why. The install then runs `rustup default stable`. The digest file rust-lang.org publishes holds the bare hash with no file name, and `rustup-init.exe` carries no Authenticode signature, so the installer is accepted on that SHA-256 alone (a signature that is present must still be valid). If `rustup` is already on this PC, even when winget's launcher folder is not on PATH, it is finished in place (`rustup default stable`, or `rustup update stable` for an update) and nothing is downloaded.
- Nothing in setup waits for a typed answer: installers run with the keyboard closed (stdin ignored) and with their own yes flags, winget is asked for its own source only (no Microsoft Store agreement prompt), and Chocolatey, which needs administrator rights and otherwise stops at "Do you want to continue?", is used only when FRIDAY is elevated. If a window ever does ask something, close it and run `npm run doctor`; it repairs and checks again.
- Model downloads go through the official Hugging Face client first (`huggingface_hub` with `hf_xet`, already installed in FRIDAY's Python environment, run with `HF_XET_HIGH_PERFORMANCE=1`): a plain download link for a Xet file is served through Hugging Face's compatibility bridge, which is slower than the client's own chunked path. Every file it fetches is checked against the SHA-256 and size Hugging Face lists, and it is cut off after a minute without a byte. If it is missing or fails, FRIDAY's own downloader (`electron/model-download.cjs`) takes over: a file over 24 MB is cut into 8 MB chunks that a pool of connections pulls, starting at 4 and adding two at a time while the speed still rises (up to 16 for one file, 24 in all); a connection with no byte, or a server with no answer, for 20 seconds is ended and the chunk is asked again on the next host; SHA-256 and resume as before. `FRIDAY_HF_ENGINE=own` skips the client, `hub` uses only it. One model downloads at a time (`FRIDAY_PREFETCH_PARALLEL=2..4` runs more) and the optional larger speech size goes last, so everything FRIDAY needs is in place before it. The terminal shows one live line (bar, percent, MB of MB, MB/s, ETA, connections), a log one line per ten percent, and a finished model prints its size, time and average speed. Hugging Face is the only official host of these weights; `FRIDAY_HF_MIRROR=1` adds hf-mirror.com as a last resort and its bytes are still checked against Hugging Face's own digest.
- Setup, Doctor and the build read the Machine and User PATH from the registry again, so FFmpeg, Pandoc and Rust that setup just installed are found without opening a new window. A tool still missing after that is genuinely missing.
- Models are downloaded once. With no FRIDAY folder chosen they wait in `.friday-dev` and the installed app moves them into your folder on first launch ([section 7](#7-open-friday-the-first-time)).

Official download floors (tried in order):

| Tool                  | Floor            | Sources                                                                                                              |
| --------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Node.js               | 22.19.0          | winget `OpenJS.NodeJS.LTS` → nodejs.org LTS MSI → nodejs.org floor MSI                                               |
| npm                   | 10.9.0           | Bundled with Node → `npm install -g npm@latest`                                                                      |
| Python                | 3.12.10 (64-bit) | winget `Python.Python.3.13` → `Python.Python.3.12` → python.org listing → python.org floor installer                 |
| SQLite (that CPython) | 3.45.3           | Comes with python.org / winget CPython                                                                               |
| Git                   | 2.49.0           | winget `Git.Git` → GitHub `git-for-windows/git`                                                                      |
| PowerShell 7          | 7.5.0            | winget `Microsoft.PowerShell` → GitHub `PowerShell/PowerShell`                                                       |
| Electron binary       | 45.0.0           | `scripts/ensure-electron.cjs`                                                                                        |
| FFmpeg                | —                | winget `Gyan.FFmpeg` → `Gyan.FFmpeg.Essentials` → Gyan.dev ZIP (per user)                                            |
| Tesseract             | —                | winget `UB-Mannheim.TesseractOCR` → GitHub `UB-Mannheim/tesseract` v5.4.0.20240606, Windows installer SHA-256 pinned |
| VC++ Redist           | —                | winget `Microsoft.VCRedist.2015+.x64` → `https://aka.ms/vs/17/release/vc_redist.x64.exe`                             |

Downloads use `curl.exe` first (resumable, five retries), then `Invoke-WebRequest`. TLS 1.2 is switched on for older Windows PowerShell and certificate checks stay on. A downloaded installer is run only after its publisher signature is checked (a corrupt or altered file is deleted and refused); the Node.js installer is also checked against nodejs.org's SHA-256 list and a GitHub release that publishes a `.sha256` file against it.

If setup installed Node and the current window still cannot see `node`, **close CMD and open a new `cmd.exe`**, `cd` back to the clone, and run `npm run setup` again.

If `python` opens the Microsoft Store stub: Settings → Apps → Advanced app settings → App execution aliases → turn off `python.exe` / `python3.exe`.

Pip inside `setup-python.cjs`: `ensurepip` → `get-pip.py` from `bootstrap.pypa.io` → the same file from GitHub `pypa/get-pip`. Kernel `requirements.txt` tries `--only-binary=:all:` first, then prefer-binary, `--no-cache-dir`, explicit `https://pypi.org/simple`, then prefer-binary with extra retries. Capability extras (`requirements-capabilities.txt`, including PyAutoGUI on Python 3.14) start at prefer-binary because a wheels-only pass can miss a `py3-none-any` closure. Windows fail-closes if `faster-whisper` / `edge-tts` cannot import.

Installer-time Python (`installer/build/install-python.ps1`, called from `repair-runtime.ps1`) also retries python.org with `curl.exe` and then winget `Python.Python.3.13` / `3.12` when the FTP listing or MSI download fails.

After a successful setup:

- Electron: `node_modules\electron\dist\electron.exe` (verified by executing it with `ELECTRON_RUN_AS_NODE=1`).
- Kernel interpreter: selected folder `runtime\.venv\Scripts\python.exe`, else checkout `.venv\Scripts\python.exe`. The running EXE uses the same resolver (`electron/python.cjs` `resolveManagedPython`).
- Database: `<FRIDAY folder>\database\friday.sqlite3` created by `init-runtime` (`from db import SCHEMA`).
- Wake model: `<FRIDAY folder>\models\wake`.

Nothing in this chain uses a global `pip install` as the kernel. If a Store alias or a broken venv is on PATH, delete the isolated `.venv` folder and run `npm run setup:python` again.

### 16.2 What `npm run build:win` does inside

Prerequisites: [16.1](#161-what-npm-run-setup-does-inside) succeeded (`npm run setup` already did the floors). Then, still in the clone root:

```cmd
npm run build:win
```

That is `scripts\build-windows.cmd` with no extra argument: **Setup installer and Portable**. It is two steps. Step 1: on a PC without Node.js 22.19.0+ it runs `scripts\setup-windows.ps1 -ToolchainOnly` (so run `scripts\build-windows.cmd` itself there, since `npm` comes with Node) and puts `%ProgramFiles%\nodejs` on PATH. Step 2: the pipeline. Its first phase, `prepare-environment`, checks the PC again (`setup-windows.ps1 -ToolchainOnly`: Git, PowerShell, FFmpeg, Tesseract, Visual C++ are installed when missing), then `npm ci`, Electron, the Python environment and models, the agent toolkit, the runtime and the repair pass; any of them that cannot finish stops the build with its reason. The last thing printed is **FRIDAY BUILD READY** (every phase passed) or **FAILED**, with the files to use.

Other pack shapes from the same `.cmd`:

```cmd
scripts\build-windows.cmd nsis
scripts\build-windows.cmd portable
npm run build:win:dir
```

| Command                              | Output                                               |
| ------------------------------------ | ---------------------------------------------------- |
| `npm run build:win`                  | Setup **and** Portable in `release\`                 |
| `scripts\build-windows.cmd nsis`     | Setup EXE only                                       |
| `scripts\build-windows.cmd portable` | Portable EXE only                                    |
| `npm run build:win:dir`              | Unpacked `release\win-unpacked\` only (faster debug) |

The `.cmd` calls `scripts\build-pipeline.cjs`. The pipeline prints `build N/13` for each of its thirteen phases (`prepare-environment`, `verify-versions`, `stage-toolchain`, `build-renderer`, `package`, `packaged-requires`, `sign-hook`, `manifest`, `verify-artifacts`, `verify-boot`, `readiness`, `packaged-self-check`, `installer-smoke`) and writes `release\build-report.json`. It does, in order:

1. Sets `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` under this repo `.cache\`. Removes a leftover `winCodeSign` cache that used to break symlink creation. Then `scripts\setup-windows.ps1 -ToolchainOnly` (local Windows only; hosted CI keeps its own toolchain): Node.js, npm, Python, Git, PowerShell, FFmpeg, Tesseract and the Visual C++ runtime are reused when they meet the floor and installed at the latest stable release when not.
2. `scripts\check-engines.cjs` (same `package.json` engines as CI) **before** `npm ci`.
3. `npm ci --no-audit --no-fund`. On failure: `npm cache verify` and a second `npm ci` against `https://registry.npmjs.org/`.
4. `scripts\ensure-electron.cjs --quiet`.
5. `scripts\setup-python.cjs` (Python venv, then the model prefetch: speech weights, turn-taking and wake models, and on Windows an installed Ollama is reused (or a per-user one installed) with one light, fast chat model, each with a progress bar and none downloaded twice; details and opt-outs in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md) section 7) then `scripts\init-runtime.cjs`.
6. `scripts\check-environment.cjs --fix` then `scripts\env-registry.cjs repair`.
7. `scripts\release-engine.cjs heal` then `verify`.
8. `scripts\verify-deps.cjs`.
9. Deletes previous `release\` and `dist-desktop\`, then `npm run build:desktop`.
10. `scripts\electron-pack.cjs` with `electron-builder.yml`. The pinned toolchain packs download first with a progress bar and fall back to pinned mirrors. Names use the public four-part identity, not npm `1.0.0`.
11. Optional Authenticode if `CSC_LINK` + `CSC_KEY_PASSWORD` are set (`scripts\sign-windows.ps1`).
12. `scripts\verify-build.cjs` (Setup and Portable must clear the toolchain size floor and stay under 2 GiB, the update manifest and block map must match, and the packaged requires are checked once), `scripts\verify-boot.cjs`, `scripts\readiness-test.cjs --pack` (Chat without a loaded local model is a WARN; it does not fail the pack), then the packaged self-check and the installer smoke when the target includes NSIS. On a **local** build `readiness` and `installer-smoke` are `SKIP`: a local build stops at a verified, bootable installer, and `FRIDAY_BUILD_READINESS=1` / `FRIDAY_BUILD_INSTALLER_SMOKE=1` (or `npm run verify:install`) run them on demand. A skipped phase is listed as `SKIP` with its reason and is only allowed where it does not apply.

Expected files after a full pack:

- `release\FRIDAY-Setup-1.2.5.7.exe`
- `release\FRIDAY-Portable-1.2.5.7.exe`
- `release\win-unpacked\FRIDAY.exe` (always, including `dir`)

Python wheels: floors, not pins. Missing capability extras do not fail kernel boot. Windows `setup-python` still fail-closes on missing voice imports.

`scripts\build-windows.cmd` checks that Node is on PATH, then calls `node scripts\build-pipeline.cjs --channel production`. `npm run build:win`, `build:win:dir`, `build:all`, `release:package`, `build:portable`, `desktop:build`, and `desktop:pack` call that same pipeline. `desktop:build` packs NSIS. `desktop:pack` packs the unpacked directory. They are not a thinner second recipe. The first pack needs the network so the toolchain packs can be fetched and hashed. A later pack reuses `.cache\toolchain`. A skipped toolchain stage is refused.

Packaging identity, TEST vs Official, and GitHub Actions: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md). Assistants must not dispatch those workflows. Official publish is Actions → **FRIDAY Release** on GitHub, not a CMD command. A branch EXE is Actions → **FRIDAY Test Build**.

### 16.3 First launch: technical details

This section applies after Path A **or** Path B install, and also after `npm run desktop:start` from a checkout.

The window is allowed to open without a completed first-run flag. AppShell does not park you on a mandatory model-connect screen. A folder must still exist; if none is selected, the app asks. After that, kernel status in the title strip / FRIDAY Status must become ready before Chat and Doctor are meaningful.

Auto mode listens and speaks. Manual and chat do not. Hands-free is the Auto conversation unless you turn that control off, which requires the wake word again. Exec approval stays off.

Do these in order on the running app:

1. **Folder.** Choose a writable root (not Program Files). Build time and first run share it: `npm run setup` and `build:win` download the speech, voice and chat models into the FRIDAY folder they can find (`HKCU\Software\FRIDAY\WorkspacePath`, or `FRIDAY_WORKSPACE_ROOT`). With none selected on Windows, the folder the setup CMD runs in is the FRIDAY folder (whatever it is called): downloads go straight into it, it is recorded in `HKCU\Software\FRIDAY\WorkspacePath`, and the installer offers it as the install folder. Where that folder cannot be a home (Program Files, unwritable) they are staged in `.friday-dev` inside the checkout and the installed app moves them (`electron/staged-assets.cjs`) into the folder you choose on first launch, so no model is downloaded twice. An item the chosen folder already has is never overwritten. To download straight into the final folder instead, run `set FRIDAY_WORKSPACE_ROOT=<your FRIDAY folder>` before `npm run setup` and `npm run build:win`. Canonical names and what uninstall may delete: [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md). Live venv after a folder is chosen: `<root>\runtime\.venv`.
2. **Kernel.** Wait until status is ready. If it stays down, open **Setup & Doctor** (and Install Manager). A leftover `PythonSetupPending` from Setup means repair-runtime did not finish — Doctor / `npm run doctor` from a checkout, or Install Manager on the EXE, is the follow-up.
3. **Voice runtime (hear / speak).** Install Manager catalog rows `faster-whisper` and `edge-tts` (same names as `BOOTSTRAP_VOICE_PACKAGES` in `src/lib/friday/first-run.ts`). Windows CMD `setup-python` already fail-closes if those two cannot import in the live venv. The kernel still boots when no voice model is installed. Optional rows, downloaded on demand and not bundled in the EXE: Silero VAD (`silero-vad`), Supertonic 3 (`supertonic-3`, code MIT, weights OpenRAIL-M, voice F2), and Smart Turn (`smart-turn`, checksum-checked). `npm run voice:install` fetches Supertonic, Smart Turn, and the English Moonshine streaming weights into the selected FRIDAY folder. Hindi and Hinglish stay on faster-whisper. edge-tts is cloud speech: a fresh install asks for hi-IN-SwaraNeural when the network is on and Privacy mode is off, and it does not run for sensitive text. Supertonic 3 F2 speaks when that model is installed; otherwise a female Indian Windows voice is preferred. kokoro-onnx, piper-tts, and sherpa-onnx are not installed: their licenses or bundled phonemizers are not permissive. `npm run voice:check` prints PASS or FAIL for each stage and still exits 0 when a model is missing.
4. **Offline chat model.** Models page / Install Manager: `llama3.2-3b` (`BOOTSTRAP_MODEL_ID`). Optional bootstrap from first-run still enqueues that model plus the two voice packages; it is not a startup gate.
5. **Wake word (optional).** FRIDAY ships no trained wake model yet: until one is trained on real recordings and passes its held-out evaluation (`scripts/train-friday-wake.py`, see `docs/FRIDAY_VOICE_ENGINE.md`), the wake word is matched in the transcript. A model of your own needs `{word}.onnx` in `<root>\models\wake`. `jarvis` must load `jarvis.onnx` — `friday.onnx` is not a silent substitute.
6. **Chat Manual.** Friday (Main Window): pick a connected model, type, send. Needs at least one local engine with a pulled model **or** a free-tier cloud key that validated.
7. **Chat Auto.** Same conversation as Manual. Auto Mode is ready only after local STT reports `ready` (Whisper model actually loaded in the persistent worker), not merely because pip installed `faster-whisper`.
8. **Local engines (optional, offline-friendly).** Models page connects engines FRIDAY already knows. Typical loopbacks: Ollama `11434`, LM Studio `1234`, llama.cpp `8080`, vLLM `8000`, LocalAI `8081`. Start the engine yourself or use Install Manager where the catalog already has a row. llama.cpp / vLLM start only when exactly one matching weight sits under `<root>\models`.
9. **Diagram compilers (optional).** Flow Studio draws and exports without them. Install Manager can add Graphviz 16.1.0 and D2 0.9.0. Each Windows installer is hash-checked. A missing compiler leaves the canvas working. Doctor shows those two rows as missing until they are installed.
10. **Free-tier cloud keys (optional).** Models page: Groq, OpenRouter, Google Gemini. Paste a key; FRIDAY stores it in the encrypted credential store and validates it. A valid key is not the same as a verified free model — see [FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md). Paid hosts stay behind the billing firewall — no silent spend. Key URLs live in `FREE_TIER_PROVIDERS` in `src/lib/friday/first-run.ts`.
11. **Confirm.** FRIDAY Status (read-only overlay) and Doctor should show kernel + Python venv healthy. Mic hardware and wake-word on a real Windows device are still required for a physical voice pass.

Section-by-section use after this: [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md).

### 16.4 Every owner-facing CMD and npm command

Run from the project root in `cmd.exe`.

#### 16.4.1 Pack and run

| Command                              | What it actually runs                  | Use it when                                                                                  |
| ------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm ci`                             | Lockfile install (`package-lock.json`) | After a clone, if you are not using `npm run setup`                                          |
| `npm run setup`                      | `scripts\setup-windows.ps1`            | First time on a Windows PC: toolchain + lockfile + Electron + Python venv + runtime + Doctor |
| `npm run build:win`                  | `scripts\build-windows.cmd`            | Pack Setup **and** Portable into `release\`                                                  |
| `npm run build:win:dir`              | `scripts\build-windows.cmd dir`        | Unpacked `release\win-unpacked\` only                                                        |
| `scripts\build-windows.cmd nsis`     | Same `.cmd` with `nsis`                | Setup EXE only                                                                               |
| `scripts\build-windows.cmd portable` | Same `.cmd` with `portable`            | Portable EXE only                                                                            |
| `npm run desktop:start`              | `electron electron/main.cjs`           | Run the desktop app from this checkout (not a pack)                                          |
| `npm run desktop:dev`                | `electron electron/dev.cjs`            | Dev desktop from this checkout                                                               |

#### 16.4.2 Repair one piece

| Command                           | What it actually runs                                                                                                                      | Use it when                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run setup:python`            | `scripts\setup-python.cjs`                                                                                                                 | Recreate/repair only the isolated venv and pip packages                                                                                                                                                                                                                                                                                                                                                  |
| `scripts\install-python-deps.cmd` | Same `setup-python.cjs`                                                                                                                    | CMD alias if you prefer a `.cmd` entry                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run setup:electron`          | `scripts\ensure-electron.cjs`                                                                                                              | Electron binary missing after `npm ci`                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run init:runtime`            | `scripts\init-runtime.cjs`                                                                                                                 | Canonical folders, wake model copy, SQLite schema                                                                                                                                                                                                                                                                                                                                                        |
| `npm run setup:toolkit`           | `scripts\prefetch-toolkit.cjs`                                                                                                             | Install or update the agent toolkit only (the same step `setup` and `build:win` run)                                                                                                                                                                                                                                                                                                                     |
| `npm run check:env`               | `scripts\check-environment.cjs`                                                                                                            | Print what is missing (does not install). Where the setup installs a tool (FFmpeg, Tesseract, VC++, Ollama, the agent toolkit) a missing one is MISSING and fails; `not applicable` rows are hardware or editions this PC cannot have, and `SKIPPED` rows (hosted CI, offline, a `FRIDAY_PREFETCH*=0` opt-out) name the step that does not run on that machine; `npm run setup` installs them on your PC |
| `npm run check:env:fix`           | `check-environment.cjs --fix`                                                                                                              | Repair through the same scripts as setup: the toolchain, Electron, Python, the models and the agent toolkit                                                                                                                                                                                                                                                                                              |
| `npm run doctor`                  | `scripts\doctor.cjs`: `npm ci` when node_modules is stale, `check-environment --fix`, `init-runtime`, `verify-deps`, `env-registry repair` | Check **and repair** everything; the backup when `npm run setup` stopped halfway. Every step runs, and it exits 1 if any failed                                                                                                                                                                                                                                                                          |
| `npm run verify:env`              | `scripts\env-registry.cjs`                                                                                                                 | Show the recorded environment registry                                                                                                                                                                                                                                                                                                                                                                   |
| `npm run repair:env`              | `env-registry.cjs repair`                                                                                                                  | Rewrite/repair that registry                                                                                                                                                                                                                                                                                                                                                                             |
| `npm run verify:boot`             | `scripts\verify-boot.cjs`                                                                                                                  | EXE + browser boot checks                                                                                                                                                                                                                                                                                                                                                                                |
| `npm run verify:install`          | `scripts\readiness-test.cjs`                                                                                                               | Post-pack kernel/database/chat/voice/model/task probe                                                                                                                                                                                                                                                                                                                                                    |
| `npm run clean:cache`             | `scripts\clean-build-cache.cjs`                                                                                                            | Clear project pack caches under `.cache\`                                                                                                                                                                                                                                                                                                                                                                |

#### 16.4.3 Checks that do not pack an EXE

| Command                                    | What it actually runs        | Use it when                                                |
| ------------------------------------------ | ---------------------------- | ---------------------------------------------------------- |
| `npm run typecheck`                        | `tsc --noEmit`               | After TypeScript edits                                     |
| `npm test`                                 | `vitest run`                 | Contract tests                                             |
| `npm run docs:sync` / `npm run docs:check` | `scripts\docs-engine.cjs`    | After Markdown edits                                       |
| `npm run verify:version`                   | `release-engine.cjs verify`  | Version-governed docs vs `config/friday-version.json`      |
| `npm run validate:local`                   | `scripts\validate-local.cjs` | Local substitute for PR Validation (Linux skips NSIS pack) |
| `npm run sign:win`                         | `scripts\sign-windows.ps1`   | Sign already-packed EXEs when a PFX is configured          |

Linux notes: `npm run setup` needs `node.exe` / winget / `msiexec`. `npm run build:win` needs `cmd.exe`. Those two are Windows-only by design. `setup:python`, `setup:electron`, `init:runtime`, and `check:env` do run on Linux.

### 16.5 Where files land

One scannable root: the folder you run setup and `build:win` in is it, unless you already chose another folder (the installer then offers it as the install folder). Setup may replace `<root>\App` on upgrade. User folders beside `App` stay. The forty-folder table lives in [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

| Location                                                 | What it is                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<root>\App`                                             | Program files (`FRIDAY.exe`, resources). Replaced by a normal upgrade / keep-data uninstall                                                         |
| `<root>\installer\installers\<version>`                  | The built Setup, Portable, `friday-update.json` and `friday-bundle.json`, placed by `build:win`; never deleted by an update or uninstall of the app |
| `<root>\runtime\.venv`                                   | Isolated CPython the installed app launches (after a folder is chosen)                                                                              |
| `<root>\database`                                        | `friday.sqlite3` — the kernel database                                                                                                              |
| `<root>\models` and `<root>\models\wake`                 | Downloaded weights and wake `.onnx` files                                                                                                           |
| `<root>\config`                                          | Including `first-run.json`, `github.json` (update channel)                                                                                          |
| `HKCU\Software\FRIDAY\WorkspacePath`                     | Pointer to the root                                                                                                                                 |
| Checkout `.venv`                                         | Only on a machine where the checkout cannot be the root (not Windows, or Program Files)                                                             |
| Checkout `.cache\electron` and `.cache\electron-builder` | Project-local pack caches (`build-windows.cmd` sets `ELECTRON_CACHE`)                                                                               |
| Checkout `temporary\downloads`                           | Official installer payloads during `npm run setup`                                                                                                  |
| Checkout `dist-desktop\`                                 | Renderer bundle                                                                                                                                     |
| Checkout `release\`                                      | `FRIDAY-Setup-1.2.5.7.exe`, `FRIDAY-Portable-1.2.5.7.exe`, `win-unpacked\FRIDAY.exe`                                                                |

### 16.6 Troubleshooting (technical)

| Symptom                                                                                                                                         | What to do                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Setup finished but kernel never becomes ready                                                                                                   | Doctor + Install Manager. Look for `PythonSetupPending`. Repair is `runtime\.venv`, not a second global Python                                                                                                                                                                                                                                                                                         |
| `npm run setup` cannot find `node.exe`                                                                                                          | Let the script install Node; open a **new** `cmd.exe` if PATH did not refresh, then re-run                                                                                                                                                                                                                                                                                                             |
| `python` opens the Microsoft Store                                                                                                              | Disable the App execution alias; reuse python.org / winget CPython                                                                                                                                                                                                                                                                                                                                     |
| `npm ci` fails once                                                                                                                             | The scripts retry after `npm cache verify` and pin `registry.npmjs.org`. Check proxy (`HTTPS_PROXY`)                                                                                                                                                                                                                                                                                                   |
| `faster-whisper` / `edge-tts` import fails on Windows                                                                                           | `npm run setup:python` fail-closes on purpose. Retry on a network that can reach PyPI; do not skip those floors                                                                                                                                                                                                                                                                                        |
| `build:win` not found on Linux / macOS                                                                                                          | Expected. Pack on Windows `cmd.exe`. Do not wrap the `.cmd` in a Unix script                                                                                                                                                                                                                                                                                                                           |
| SQLite / Git below floor on Linux CI agents                                                                                                     | Floors in `config/toolchain-versions.json` are Windows product requirements. Do not lower them to green a Linux agent                                                                                                                                                                                                                                                                                  |
| SmartScreen warning                                                                                                                             | Unsigned default. See [16.7](#167-signing-a-packed-exe-optional)                                                                                                                                                                                                                                                                                                                                       |
| Official and TEST both installed                                                                                                                | Different appIds — expected. Uninstall the one you meant                                                                                                                                                                                                                                                                                                                                               |
| Packed app will not take a GitHub source ZIP as an update                                                                                       | Intentional. Use Settings → Updates / a verified Setup EXE                                                                                                                                                                                                                                                                                                                                             |
| `kernel/requirements.txt not found` during `npm run build:win`                                                                                  | This Git clone is also the FRIDAY data root, so `kernel/` was treated as a data alias of `backend/`. Re-run the pack; `setup-python` restores `kernel/`. Clone the repo into a folder that is not the installed FRIDAY root                                                                                                                                                                            |
| ParserError `Unexpected token '$('` in `setup-windows.ps1`                                                                                      | Windows PowerShell 5.1 read a non-ASCII character as a quote. Every `powershell.exe` script in this tree is 7-bit ASCII, so keep it that way and run `npm run setup` again                                                                                                                                                                                                                             |
| `check:env` / `doctor` report no `runtime\.venv` and no Electron binary right after a failed setup                                              | Expected cascade: setup never reached `setup-python` / `ensure-electron`. Re-run `npm run setup`. If setup already passed, `npm run setup:electron` then `npm run setup:python` then `npm run doctor`                                                                                                                                                                                                  |
| `build:win` produced Setup/Portable EXEs then `readiness FAILED` on CHAT (`No models loaded`, `coder-ds` 404, `All connection attempts failed`) | The pack is good; no local model is loaded, and the `--pack` gate continues past that. Load a model in Ollama or LM Studio, or add a free-tier key, then Chat works. `npm run verify:install` without `--pack` still fails Chat                                                                                                                                                                        |
| `npm warn allow-scripts electron-winstaller`                                                                                                    | The package is explicitly denied in `package.json` `allowScripts`. Its install script only copies Squirrel 7-Zip. NSIS and Portable do not use it. `electron` is explicitly allowed. Electron 43 has no install script, so `npm run setup:electron` still downloads the binary                                                                                                                         |
| `build:win` stops with `'vite' is not recognized` or `'node' is not recognized`                                                                 | `cmd.exe` on that PC could not find the tool by name. The build now runs vite and every build script with the running Node, so update to the latest FRIDAY and run `npm run build:win` again. `npm run doctor` shows a note row **Shell PATH (cmd.exe)**: if it says cmd.exe cannot find node or npm, close the window and open a new terminal (a console opened before an install keeps the old PATH) |

Hosted GitHub Actions (PR Validation, FRIDAY Test Build, FRIDAY Release) are owner-run. This guide does not dispatch them.

### 16.7 Signing a packed EXE (optional)

```cmd
set CSC_LINK=C:\path\to\publisher.pfx
set CSC_KEY_PASSWORD=********
npm run build:win
```

Or `npm run sign:win` against `scripts\sign-windows.ps1` after a pack. Unset `CSC_LINK` means unsigned. Details: [SECURITY.md](SECURITY.md).

### 16.8 Update and uninstall: how they work

**Update.**

In the running **packaged** app: Settings → Updates. The Stable vs Test selector is described in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md). The updater reads GitHub Releases and `friday-update.json`, verifies SHA256, then `electron/update-safety.cjs` (backup → install → health → rollback). Packaged FRIDAY is never replaced by a source ZIP. User data under the root is not deleted by a normal update.

From source, packing a new EXE and running that Setup is an upgrade of `<root>\App` only.

**Uninstall.**

1. Windows Settings → Apps → Installed apps → FRIDAY (Official) or FRIDAY Test.
2. Default (keep-data): only `<root>\App` is removed. Database, models, memory, library, and the rest of the root stay.
3. Tick **Delete all FRIDAY data and resources** to remove the whole root (`$FridayUnMode == "delete"`). `nsis.deleteAppDataOnUninstall` is `false` in `electron-builder.yml`, so Windows will not silently wipe the root. Before the program folder is removed, Setup and Uninstall close the installed FRIDAY tree and also any Python or Node process started on a file inside the program folder (its executable can sit outside it, and it stands in that folder), never the process that started the closer; a detached helper then removes `<root>\App` and `<root>` for about a minute and a half. Keep-data removes `<root>\App` only.
4. Portable: delete the extracted folder yourself; there is no Apps & Features row.

Typed plans: `installer/uninstall/index.ts`. Contract: [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

### 16.9 The Setup installer step by step

No CMD pack is required for daily use.

1. On the Windows PC, open GitHub Latest for repository `devendrarj25/FRIDAY-AI-ASSISTANT`, tag **v1.2.5.7**.
2. Download `FRIDAY-Setup-1.2.5.7.exe`. Optionally check `SHA256SUMS.txt` on that release.
3. Double-click Setup while signed in as the user who will run FRIDAY. The product is per-user (`perMachine: false` in `electron-builder.yml`). Do not “Run as administrator” unless that account should own the install.
4. The wizard has one folder page: where the FRIDAY root should live. Default is `%USERPROFILE%\FRIDAY`. Setup refuses `Program Files`, `Windows`, and a nested `FRIDAY\FRIDAY` folder.
5. Program files go into `<chosen root>\App` (`$INSTDIR`). The chosen root is written to `HKCU\Software\FRIDAY\WorkspacePath`.
6. After copy, Setup launches `installer/build/repair-runtime.ps1`. That helper **never aborts Setup**. It reuses a healthy `runtime\.venv`, installs `kernel\requirements.txt` (startup + voice floors), then tries `kernel\requirements-capabilities.txt` as best-effort extras. When Python repair cannot finish, shortcuts and the uninstaller still register, and Setup records `PythonSetupPending` so Doctor / Install Manager can finish later.
7. Tick launch if the wizard offers it, or start FRIDAY from the Start menu / desktop shortcut (`FRIDAY.exe` inside `<root>\App`).
8. Continue at [section 7](#7-open-friday-the-first-time).

SmartScreen may warn on an unsigned build. That is the honest local/CI default until `CSC_LINK` / `CSC_KEY_PASSWORD` are set at pack time. Signing does not by itself clear SmartScreen for a new publisher.

If you clone Git into a folder that is **already** the installed FRIDAY data root (same path as `HKCU\Software\FRIDAY\WorkspacePath`), `kernel/` can be treated as a data alias of `backend/`. `setup-python` restores that tree. Prefer cloning into a **different** folder than the installed root.
