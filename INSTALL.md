# FRIDAY — Windows Install and Build Guide

**Shipping version: 1.0.1.2**  
**Publisher:** Devendra Singh Meena (devendrarj25)

🪟 This is the owner start-to-finish guide: get FRIDAY onto a Windows PC, pack the Windows EXEs from this checkout, install those EXEs, update, uninstall, and bring Chat / voice / local engines / cloud keys to a working state.

Related documents (do not copy their tables here): version numbers [VERSIONING.md](VERSIONING.md); what Setup may replace on disk [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md); using each sidebar section after the app is open [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md); how CMD / TEST / Official packs differ, and how Stable vs Test updates behave, [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

Every command in this file is run from the **project root** (the folder that contains `package.json`) in **Windows `cmd.exe`**, unless a step says otherwise. `npm run build:win` must stay the backslash CMD path — it is the owner-verified pack launcher.

## 1. Pick one path

| Path | Who it is for | What you do |
| --- | --- | --- |
| A. Published GitHub EXE | Daily use. No Node, Python, or Git required. | Download `FRIDAY-Setup-1.0.1.2.exe` (uninstaller in Apps & Features) or `FRIDAY-Portable-1.0.1.2.exe` (no uninstaller) |
| B. Source checkout + Windows CMD | Packing a new EXE, changing code, or running the desktop app from this tree | Clone this repo, then `npm run setup`, then `npm run build:win` (or `npm run desktop:start` without packing) |

Both paths share one disk root once a folder is chosen. Do not install Official and then overwrite it with a TEST EXE expecting the same Windows appId — TEST uses `dev.friday.desk.test` so it can sit beside Official. Isolation: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md).

If you clone Git into a folder that is **already** the installed FRIDAY data root (same path as `HKCU\Software\FRIDAY\WorkspacePath`), `kernel/` can be treated as a data alias of `backend/`. `setup-python` restores that tree. Prefer cloning into a **different** folder than the installed root.

## 2. Path A — install the published Setup EXE

No CMD pack is required for daily use.

1. On the Windows PC, open GitHub Latest for repository `devendrarj25/FRIDAY-AI-ASSISTANT`, tag **v1.0.1.2**.
2. Download `FRIDAY-Setup-1.0.1.2.exe`. Optionally check `SHA256SUMS.txt` on that release.
3. Double-click Setup while signed in as the user who will run FRIDAY. The product is per-user (`perMachine: false` in `electron-builder.yml`). Do not “Run as administrator” unless that account should own the install.
4. The wizard has one folder page: where the FRIDAY root should live. Default is `%USERPROFILE%\FRIDAY`. Setup refuses `Program Files`, `Windows`, and a nested `FRIDAY\FRIDAY` folder.
5. Program files go into `<chosen root>\App` (`$INSTDIR`). The chosen root is written to `HKCU\Software\FRIDAY\WorkspacePath`.
6. After copy, Setup launches `installer/build/repair-runtime.ps1`. That helper **never aborts Setup**. It reuses a healthy `runtime\.venv`, installs `kernel\requirements.txt` (startup + voice floors), then tries `kernel\requirements-capabilities.txt` as best-effort extras. When Python repair cannot finish, shortcuts and the uninstaller still register, and Setup records `PythonSetupPending` so Doctor / Install Manager can finish later.
7. Tick launch if the wizard offers it, or start FRIDAY from the Start menu / desktop shortcut (`FRIDAY.exe` inside `<root>\App`).
8. Continue at [section 8](#8-first-launch--make-friday-actually-work).

SmartScreen may warn on an unsigned build. That is the honest local/CI default until `CSC_LINK` / `CSC_KEY_PASSWORD` are set at pack time. Signing does not by itself clear SmartScreen for a new publisher.

## 3. Path A — Portable EXE (no Apps & Features row)

`FRIDAY-Portable-1.0.1.2.exe` is the same public version with no Apps & Features entry and no NSIS uninstaller. Run or extract it, then pick the same kind of FRIDAY root as Setup. Updates still come from GitHub Releases when the running app is packaged. Prefer Setup when you want a Start-menu shortcut and a keep-data vs delete-all uninstall.

Then continue at [section 8](#8-first-launch--make-friday-actually-work).

## 4. Path B — open CMD in the Git clone

Packing needs a Windows PC with `cmd.exe`. Floors live in `config/toolchain-versions.json`. A newer compatible tool is reused; setup never downgrades.

1. Install Git for Windows if it is not already there (setup can also install it).
2. Open **Command Prompt** (`cmd.exe`). Do not use Git Bash for `npm run build:win`.
3. Clone into a folder that is **not** already the installed FRIDAY data root:

```cmd
git clone https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.git
cd friday
git pull origin main
```

If the repo already exists:

```cmd
cd /d D:\FRIDAY
git pull origin main
```

Replace `D:\FRIDAY` with the real clone path. You are in the right folder when `dir package.json` shows that file.

## 5. Path B — first-time setup (toolchain + venv + Doctor)

From that same folder:

```cmd
npm run setup
```

That runs `scripts\setup-windows.ps1` via `powershell.exe` (Windows PowerShell 5.1). The script is 7-bit ASCII so 5.1 can parse it. It is idempotent: tools already at or above the floor are reused.

Inside the script, in order:

1. Node, Python, Git, PowerShell, npm — each method prints `method failed:` and the next official source runs.
2. Optional FFmpeg, Tesseract, VC++ — setup continues if they stay missing; Install Manager can add them later.
3. `npm ci` from `package-lock.json`. On failure: `npm cache verify` then `npm ci` again with `https://registry.npmjs.org/`.
4. `node scripts\ensure-electron.cjs` (npm installer, GitHub Electron zip, then `@electron/get`).
5. `node scripts\setup-python.cjs` — venv at the selected FRIDAY folder `runtime\.venv`, or checkout `.venv` if no folder is selected.
6. `node scripts\init-runtime.cjs` — folders, wake model, database.
7. `node scripts\check-environment.cjs --fix`.
8. `npm run doctor`. Success prints `SETUP PASS`. The interface bundle (`dist-desktop`) is **not** required here; `npm run build:win` builds it. A missing Tesseract is an in-app Doctor row (Missing) and does not fail this command.

Official download floors (tried in order):

| Tool | Floor | Sources |
| --- | --- | --- |
| Node.js | 22.19.0 | winget `OpenJS.NodeJS.LTS` → nodejs.org LTS MSI → nodejs.org floor MSI |
| npm | 10.9.0 | Bundled with Node → `npm install -g npm@latest` |
| Python | 3.12.10 (64-bit) | winget `Python.Python.3.13` → `Python.Python.3.12` → python.org listing → python.org floor installer |
| SQLite (that CPython) | 3.45.3 | Comes with python.org / winget CPython |
| Git | 2.49.0 | winget `Git.Git` → GitHub `git-for-windows/git` |
| PowerShell 7 | 7.5.0 | winget `Microsoft.PowerShell` → GitHub `PowerShell/PowerShell` |
| Electron binary | 43.0.0 | `scripts/ensure-electron.cjs` |
| FFmpeg (optional) | — | winget `Gyan.FFmpeg` → `Gyan.FFmpeg.Essentials` |
| Tesseract (optional) | — | winget `UB-Mannheim.TesseractOCR` → GitHub `UB-Mannheim/tesseract` v5.4.0.20240606, Windows installer SHA-256 pinned |
| VC++ Redist (optional) | — | winget `Microsoft.VCRedist.2015+.x64` → `https://aka.ms/vs/17/release/vc_redist.x64.exe` |

Downloads use `Invoke-WebRequest` first, then `curl.exe --fail --location --retry`. TLS certificate checks stay on.

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

## 6. Path B — pack the Windows EXEs

Prerequisites: section 5 succeeded (`npm run setup` already did the floors). Then, still in the clone root:

```cmd
npm run build:win
```

That is `scripts\build-windows.cmd` with no extra argument: **Setup installer and Portable**.

Other pack shapes from the same `.cmd`:

```cmd
scripts\build-windows.cmd nsis
scripts\build-windows.cmd portable
npm run build:win:dir
```

| Command | Output |
| --- | --- |
| `npm run build:win` | Setup **and** Portable in `release\` |
| `scripts\build-windows.cmd nsis` | Setup EXE only |
| `scripts\build-windows.cmd portable` | Portable EXE only |
| `npm run build:win:dir` | Unpacked `release\win-unpacked\` only (faster debug) |

The `.cmd` does, in order:

1. Sets `ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` under this repo `.cache\`. Removes a leftover `winCodeSign` cache that used to break symlink creation.
2. `scripts\check-engines.cjs` (same `package.json` engines as CI) **before** `npm ci`.
3. `npm ci --no-audit --no-fund`. On failure: `npm cache verify` and a second `npm ci` against `https://registry.npmjs.org/`.
4. `scripts\ensure-electron.cjs --quiet`.
5. `scripts\setup-python.cjs` then `scripts\init-runtime.cjs`.
6. `scripts\check-environment.cjs --fix` then `scripts\env-registry.cjs repair`.
7. `scripts\release-engine.cjs heal` then `verify`.
8. `scripts\verify-deps.cjs`.
9. Deletes previous `release\` and `dist-desktop\`, then `npm run build:desktop`.
10. `scripts\electron-pack.cjs` with `electron-builder.yml`. Names use the public four-part identity, not npm `1.0.0`.
11. Optional Authenticode if `CSC_LINK` + `CSC_KEY_PASSWORD` are set (`scripts\sign-windows.ps1`).
12. `scripts\verify-build.cjs`, `scripts\verify-boot.cjs`, `scripts\readiness-test.cjs --pack` (Chat without a loaded local model is a WARN; it does not fail the pack).

Expected files after a full pack:

- `release\FRIDAY-Setup-1.0.1.2.exe`
- `release\FRIDAY-Portable-1.0.1.2.exe`
- `release\win-unpacked\FRIDAY.exe` (always, including `dir`)

Python wheels: floors, not pins. Missing capability extras do not fail kernel boot. Windows `setup-python` still fail-closes on missing voice imports.

`desktop:build` / `desktop:pack` exist as thinner electron-builder wrappers. They skip the CMD readiness chain (`check-engines`, isolated venv, heal/verify, readiness-test). For a shippable Windows build use `npm run build:win`, not those aliases.

Packaging identity, TEST vs Official, and GitHub Actions: [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md). Assistants must not dispatch those workflows. Official publish is Actions → **Release / Build** or **Official Publish** on GitHub, not a CMD command.

## 7. Path B — install the EXE you just packed

1. Close any running FRIDAY that uses the same Windows appId you are about to install.
2. Run `release\FRIDAY-Setup-1.0.1.2.exe` (or the Portable) the same way as [section 2](#2-path-a--install-the-published-setup-exe).
3. A **TEST** artifact (`FRIDAY-Test-Setup-…`) installs beside Official; it does not replace Official user data. Do not mix their folders.
4. Follow [section 8](#8-first-launch--make-friday-actually-work) on the new install (venv under that root’s `runtime\.venv`).

Installing a locally packed Setup over an older Official of the **same** four-part version is a rebuild of that version, not a bump. Bumping `config/friday-version.json` is owner-only.

## 8. First launch — make FRIDAY actually work

This section applies after Path A **or** Path B install, and also after `npm run desktop:start` from a checkout.

The window is allowed to open without a completed first-run flag. AppShell does not park you on a mandatory model-connect screen. A folder must still exist; if none is selected, the app asks. After that, kernel status in the title strip / FRIDAY Status must become ready before Chat and Doctor are meaningful.

Auto mode listens and speaks. Manual and chat do not. Hands-free is the Auto conversation unless you turn that control off, which requires the wake word again. Exec approval stays off.

Do these in order on the running app:

1. **Folder.** Choose a writable root (not Program Files). Canonical names and what uninstall may delete: [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md). Live venv after a folder is chosen: `<root>\runtime\.venv`.
2. **Kernel.** Wait until status is ready. If it stays down, open **Setup & Doctor** (and Install Manager). A leftover `PythonSetupPending` from Setup means repair-runtime did not finish — Doctor / `npm run doctor` from a checkout, or Install Manager on the EXE, is the follow-up.
3. **Voice runtime (hear / speak).** Install Manager catalog rows `faster-whisper` and `edge-tts` (same names as `BOOTSTRAP_VOICE_PACKAGES` in `src/lib/friday/first-run.ts`). Windows CMD `setup-python` already fail-closes if those two cannot import in the live venv. The kernel still boots when no voice model is installed. Optional rows, downloaded on demand and not bundled in the EXE: Silero VAD (`silero-vad`), Supertonic 3 (`supertonic-3`, code MIT, weights OpenRAIL-M, voice F2), and Smart Turn (`smart-turn`, checksum-checked). `npm run voice:install` fetches Supertonic, Smart Turn, and the English Moonshine streaming weights into the selected FRIDAY folder. Hindi and Hinglish stay on faster-whisper. edge-tts is cloud speech: it runs only after that Neural voice is selected, and it does not run for sensitive text. System voices speak until Supertonic is on disk. kokoro-onnx, piper-tts, and sherpa-onnx are not installed: their licenses or bundled phonemizers are not permissive. `npm run voice:check` prints PASS or FAIL for each stage and still exits 0 when a model is missing.
4. **Offline chat model.** Models page / Install Manager: `llama3.2-3b` (`BOOTSTRAP_MODEL_ID`). Optional bootstrap from first-run still enqueues that model plus the two voice packages; it is not a startup gate.
5. **Wake word (optional).** Bundled `friday.onnx` is copied into `<root>\models\wake` by `init-runtime`. A custom name needs `{word}.onnx` in that folder. `jarvis` must load `jarvis.onnx` — `friday.onnx` is not a silent substitute.
6. **Chat Manual.** Friday (Main Window): pick a connected model, type, send. Needs at least one local engine with a pulled model **or** a free-tier cloud key that validated.
7. **Chat Auto.** Same conversation as Manual. Auto Mode is ready only after local STT reports `ready` (Whisper model actually loaded in the persistent worker), not merely because pip installed `faster-whisper`.
8. **Local engines (optional, offline-friendly).** Models page connects engines FRIDAY already knows. Typical loopbacks: Ollama `11434`, LM Studio `1234`, llama.cpp `8080`, vLLM `8000`, LocalAI `8081`. Start the engine yourself or use Install Manager where the catalog already has a row. llama.cpp / vLLM start only when exactly one matching weight sits under `<root>\models`.
9. **Diagram compilers (optional).** Flow Studio draws and exports without them. Install Manager can add Graphviz 16.1.0 and D2 0.9.0. Each Windows installer is hash-checked. A missing compiler leaves the canvas working. Doctor shows those two rows as missing until they are installed.
10. **Free-tier cloud keys (optional).** Models page: Groq, OpenRouter, Google Gemini. Paste a key; FRIDAY stores it in the encrypted credential store and validates it. A valid key is not the same as a verified free model — see [FRIDAY_PROVIDERS_AND_SECRETS.md](docs/FRIDAY_PROVIDERS_AND_SECRETS.md). Paid hosts stay behind the billing firewall — no silent spend. Key URLs live in `FREE_TIER_PROVIDERS` in `src/lib/friday/first-run.ts`.
11. **Confirm.** FRIDAY Status (read-only overlay) and Doctor should show kernel + Python venv healthy. Mic hardware and wake-word on a real Windows device are still required for a physical voice pass.

Section-by-section use after this: [docs/FRIDAY_USER_GUIDE.md](docs/FRIDAY_USER_GUIDE.md).

## 9. Run from this checkout without packing

Useful while developing. Not a substitute for the Setup EXE on a daily-driver PC.

```cmd
npm run setup
npm run desktop:start
```

`npm run desktop:dev` uses `electron/dev.cjs` instead of `electron/main.cjs`. You still need a FRIDAY folder and a ready kernel. Chat / voice / model steps in section 8 still apply.

## 10. Every owner-facing CMD / npm command

Run from the project root in `cmd.exe`.

### 10.1 Pack and run

| Command | What it actually runs | Use it when |
| --- | --- | --- |
| `npm ci` | Lockfile install (`package-lock.json`) | After a clone, if you are not using `npm run setup` |
| `npm run setup` | `scripts\setup-windows.ps1` | First time on a Windows PC: toolchain + lockfile + Electron + Python venv + runtime + Doctor |
| `npm run build:win` | `scripts\build-windows.cmd` | Pack Setup **and** Portable into `release\` |
| `npm run build:win:dir` | `scripts\build-windows.cmd dir` | Unpacked `release\win-unpacked\` only |
| `scripts\build-windows.cmd nsis` | Same `.cmd` with `nsis` | Setup EXE only |
| `scripts\build-windows.cmd portable` | Same `.cmd` with `portable` | Portable EXE only |
| `npm run desktop:start` | `electron electron/main.cjs` | Run the desktop app from this checkout (not a pack) |
| `npm run desktop:dev` | `electron electron/dev.cjs` | Dev desktop from this checkout |

### 10.2 Repair one piece

| Command | What it actually runs | Use it when |
| --- | --- | --- |
| `npm run setup:python` | `scripts\setup-python.cjs` | Recreate/repair only the isolated venv and pip packages |
| `scripts\install-python-deps.cmd` | Same `setup-python.cjs` | CMD alias if you prefer a `.cmd` entry |
| `npm run setup:electron` | `scripts\ensure-electron.cjs` | Electron binary missing after `npm ci` |
| `npm run init:runtime` | `scripts\init-runtime.cjs` | Canonical folders, wake model copy, SQLite schema |
| `npm run check:env` | `scripts\check-environment.cjs` | Print what is missing (does not install) |
| `npm run check:env:fix` | `check-environment.cjs --fix` | Repair Electron + Python via the same scripts as setup |
| `npm run doctor` | `init-runtime` + `check-environment` + `verify-deps` + `env-registry` | Full readiness after setup or when the EXE kernel is sick |
| `npm run verify:env` | `scripts\env-registry.cjs` | Show the recorded environment registry |
| `npm run repair:env` | `env-registry.cjs repair` | Rewrite/repair that registry |
| `npm run verify:boot` | `scripts\verify-boot.cjs` | EXE + browser boot checks |
| `npm run verify:install` | `scripts\readiness-test.cjs` | Post-pack kernel/database/chat/voice/model/task probe |
| `npm run clean:cache` | `scripts\clean-build-cache.cjs` | Clear project pack caches under `.cache\` |

### 10.3 Checks that do not pack an EXE

| Command | What it actually runs | Use it when |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` | After TypeScript edits |
| `npm test` | `vitest run` | Contract tests |
| `npm run docs:sync` / `npm run docs:check` | `scripts\docs-engine.cjs` | After Markdown edits |
| `npm run verify:version` | `release-engine.cjs verify` | Version-governed docs vs `config/friday-version.json` |
| `npm run validate:local` | `scripts\validate-local.cjs` | Local substitute for PR Validation (Linux skips NSIS pack) |
| `npm run sign:win` | `scripts\sign-windows.ps1` | Sign already-packed EXEs when a PFX is configured |

Linux Cloud Agent notes: `npm run setup` needs `node.exe` / winget / `msiexec`. `npm run build:win` needs `cmd.exe`. Those two are Windows-only by design. `setup:python`, `setup:electron`, `init:runtime`, and `check:env` do run on Linux.

## 11. Where files land

One scannable root. Setup may replace `<root>\App` on upgrade. User folders beside `App` stay. The forty-folder table lives in [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

| Location | What it is |
| --- | --- |
| `<root>\App` | Program files (`FRIDAY.exe`, resources). Replaced by a normal upgrade / keep-data uninstall |
| `<root>\runtime\.venv` | Isolated CPython the installed app launches (after a folder is chosen) |
| `<root>\database` | `friday.sqlite3` — the kernel database |
| `<root>\models` and `<root>\models\wake` | Downloaded weights and wake `.onnx` files |
| `<root>\config` | Including `first-run.json`, `github.json` (update channel) |
| `HKCU\Software\FRIDAY\WorkspacePath` | Pointer to the root |
| Checkout `.venv` | Only when packing/running from source with **no** selected folder |
| Checkout `.cache\electron` and `.cache\electron-builder` | Project-local pack caches (`build-windows.cmd` sets `ELECTRON_CACHE`) |
| Checkout `temporary\downloads` | Official installer payloads during `npm run setup` |
| Checkout `dist-desktop\` | Renderer bundle |
| Checkout `release\` | `FRIDAY-Setup-1.0.1.2.exe`, `FRIDAY-Portable-1.0.1.2.exe`, `win-unpacked\FRIDAY.exe` |

## 12. Update

In the running **packaged** app: Settings → Updates. The Stable vs Test selector is described in [docs/FRIDAY_BUILD_AND_RELEASE.md](docs/FRIDAY_BUILD_AND_RELEASE.md). The updater reads GitHub Releases and `friday-update.json`, verifies SHA256, then `electron/update-safety.cjs` (backup → install → health → rollback). Packaged FRIDAY is never replaced by a source ZIP. User data under the root is not deleted by a normal update.

From source, packing a new EXE and running that Setup is an upgrade of `<root>\App` only.

## 13. Uninstall

1. Windows Settings → Apps → Installed apps → FRIDAY (Official) or FRIDAY Test.
2. Default (keep-data): only `<root>\App` is removed. Database, models, memory, library, and the rest of the root stay.
3. Tick **Delete all FRIDAY data and resources** to remove the whole root (`$FridayUnMode == "delete"`). `nsis.deleteAppDataOnUninstall` is `false` in `electron-builder.yml`, so Windows will not silently wipe the root.
4. Portable: delete the extracted folder yourself; there is no Apps & Features row.

Typed plans: `installer/uninstall/index.ts`. Contract: [docs/FRIDAY_STORAGE_CONTRACT.md](docs/FRIDAY_STORAGE_CONTRACT.md).

## 14. Signing a packed EXE (optional)

```cmd
set CSC_LINK=C:\path\to\publisher.pfx
set CSC_KEY_PASSWORD=********
npm run build:win
```

Or `npm run sign:win` against `scripts\sign-windows.ps1` after a pack. Unset `CSC_LINK` means unsigned. Details: [SECURITY.md](SECURITY.md).

## 15. Troubleshooting (install / pack / first kernel)

| Symptom | What to do |
| --- | --- |
| Setup finished but kernel never becomes ready | Doctor + Install Manager. Look for `PythonSetupPending`. Repair is `runtime\.venv`, not a second global Python |
| `npm run setup` cannot find `node.exe` | Let the script install Node; open a **new** `cmd.exe` if PATH did not refresh, then re-run |
| `python` opens the Microsoft Store | Disable the App execution alias; reuse python.org / winget CPython |
| `npm ci` fails once | The scripts retry after `npm cache verify` and pin `registry.npmjs.org`. Check proxy (`HTTPS_PROXY`) |
| `faster-whisper` / `edge-tts` import fails on Windows | `npm run setup:python` fail-closes on purpose. Retry on a network that can reach PyPI; do not skip those floors |
| `build:win` not found on Linux / macOS | Expected. Pack on Windows `cmd.exe`. Do not wrap the `.cmd` in a Unix script |
| SQLite / Git below floor on Linux CI agents | Floors in `config/toolchain-versions.json` are Windows product requirements. Do not lower them to green a Linux agent |
| SmartScreen warning | Unsigned default. See section 14 |
| Official and TEST both installed | Different appIds — expected. Uninstall the one you meant |
| Packed app will not take a GitHub source ZIP as an update | Intentional. Use Settings → Updates / a verified Setup EXE |
| `kernel/requirements.txt not found` during `npm run build:win` | This Git clone is also the FRIDAY data root, so `kernel/` was renamed to `backend/`. Pull `main` and re-run; `setup-python` restores `kernel/`. Clone the repo to a folder that is not the installed FRIDAY root when you can |
| ParserError `Unexpected token '$('` in `setup-windows.ps1` | Windows PowerShell 5.1 read a UTF-8 dash as a quote and never started setup. This checkout's `powershell.exe` scripts are ASCII. Run `npm run setup` again |
| `check:env` / `doctor` report no `runtime\.venv` and no Electron binary right after a failed setup | Expected cascade: setup never reached `setup-python` / `ensure-electron`. Re-run `npm run setup`. If setup already passed, `npm run setup:electron` then `npm run setup:python` then `npm run doctor` |
| Doctor `not ready: renderer` / `MISSING FRIDAY interface bundle` before `build:win` | Fixed on this tree: the interface is optional until pack. Pull `main` and re-run `npm run doctor`. `npm run build:win` still builds `dist-desktop` |
| `build:win` produced Setup/Portable EXEs then `readiness FAILED` on CHAT (`No models loaded`, `coder-ds` 404, `All connection attempts failed`) | Pack is good; no local LLM is loaded. This tree's `--pack` gate continues. Load a model in Ollama / LM Studio, or add a free-tier key, then Chat works. `npm run verify:install` without `--pack` still fail-closes Chat |
| Doctor reports `MISSING npm` right after `npm ci` added hundreds of packages | npm is present. A checkout folder with a space (`FRIDAY- AI OS`) plus a broken `cmd.exe /S /C` quote strip made `--version` fail. Pull `main` and re-run `npm run doctor`. Do not reinstall Node |
| `The directory name is invalid` while cleaning `release` | Cosmetic when `rmdir` runs on a name that is not a folder. Pack continues (`2>nul`). Do **not** write `if exist "release\\"` — cmd.exe escapes the quote and can stop the pack |
| `npm warn allow-scripts electron-winstaller` | Warning only. The pack does not require that install script |
| `(node:…) [DEP0190] DeprecationWarning` after `check:env` | Node 22+ warning when `shell: true` was used with an args array. This tree spawns `.cmd` via `cmd.exe /c` instead |

Hosted GitHub Actions (PR Validation, Test EXE, Official Publish) are owner-run. This guide does not dispatch them.

## 16. Copy-paste order (source path, Windows CMD)

From a fresh clone on a Windows PC:

```cmd
git clone https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT.git
cd friday
git pull origin main
npm run setup
npm run doctor
npm run build:win
```

Then run `release\FRIDAY-Setup-1.0.1.2.exe`, pick a FRIDAY folder, wait for kernel ready, then follow section 8 until Chat Manual sends a reply.
