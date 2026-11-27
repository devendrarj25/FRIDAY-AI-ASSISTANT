# FRIDAY — Storage, Installation, Update & Uninstall Contract (v1.2.5.7)

💾 One disk root and what Setup / update / uninstall may touch. Pack steps: [INSTALL.md](../INSTALL.md). Stable versus Test in the running app: [FRIDAY_BUILD_AND_RELEASE.md](FRIDAY_BUILD_AND_RELEASE.md).

## 1. `FRIDAY_ROOT`

Resolved only by `electron/friday-paths.cjs` (`ensureStructure()`) using `electron/friday-contract.cjs` (`FOLDERS`, `NAMES`, `TREES`). Order: session selection (`workspace:set`, `--workspace`, env) → persisted pointer → `HKCU\Software\FRIDAY\WorkspacePath` → none (first run asks). Setup, Doctor and the build (`scripts/friday-root.cjs`) add one last step on Windows: with none of those chosen, the folder the setup CMD runs in is the root and is written to `WorkspacePath`. Persistent data is not stored in AppData, IndexedDB, or `process.cwd()`.

When that root is also the Git clone, `kernel/` (FastAPI `main.py` + `requirements.txt`) and `src/` (renderer `routes/` + `lib/friday`) stay as source trees. They are not data aliases of `backend` / `frontend`. `ensureStructure` restores them if they were already renamed, then creates sibling data folders. `scripts/setup-python.cjs` uses `resolveKernelSource` so `npm run build:win` still finds `requirements.txt` if a rename cannot run. Pack from a clone that is not the installed FRIDAY data root when you can. Walkthrough: [INSTALL.md](../INSTALL.md).

Setup `$INSTDIR` is `<chosen root>\App`. Normal upgrade replaces `App` wholesale. User folders beside it stay.

## 2. What lives under the root

Forty canonical top-level names including `app`, `runtime`, `models`, `memory`, `library`, `security`, `config`, `skills`, `tools`, `agents`, `plugins`, `modules`, `workflows`. Capability trees also have `TREES` segments (`skills/custom`, `plugins/installed`, …).

Python live venv: `<root>\runtime\.venv` when a folder is chosen.

### Where each thing goes, and why `App` is separate

`<root>\App` is only the program: `FRIDAY.exe` and the files that ship inside it. An update or reinstall replaces it wholesale, which is why nothing FRIDAY downloads or the owner adds is stored there. Everything else is a sibling folder in the root that an update never touches, so the new program finds the same models, libraries, memory and files and nothing is fetched again. After an update the program is new and the data is the old data.

**FRIDAY Test has a program folder of its own (2026-11-21).** The FRIDAY Test installer (`PRODUCT_NAME` "FRIDAY Test", app id `dev.friday.desk.test`) installs into `<root>\TestApp`, not `<root>\App`: `installer/build/installer.nsh` sets `FRIDAY_APP_DIR` and its length `FRIDAY_APP_TAIL` once per product, before the installer-only block, so both passes use it. Test still shares the FRIDAY folder (models, voices, runtime) and keeps its own data under `<root>\profiles\test`; its uninstaller removes only `<root>\TestApp`, `profiles\test` and `HKCU\Software\FRIDAY Test`. **One-time step on a PC that had FRIDAY Test before this change:** the old FRIDAY Test lives in `<root>\App`, the official program folder, and its uninstaller (old code, run by the new Test Setup before it installs) removes that folder. Uninstall the old FRIDAY Test first, then install the official FRIDAY again over the same folder (data is kept), then install the new FRIDAY Test. Compiled with NSIS 3.09 on Linux in both passes for both products, 0 warnings. The FRIDAY Test Build run of 2026-11-21 (run 4) proved the Test installer on a hosted Windows runner puts the program in `<root>\TestApp` and records `HKCU\Software\FRIDAY Test\InstallPath`; it failed only because `scripts/windows-installer-smoke.ps1` still looked in `<root>\App`, and the smoke now takes the program folder from `-Product` the same way.

| Thing                                                                                       | Home                                                        | Survives update, reinstall, normal uninstall | Removed by "Delete all FRIDAY data"             |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------- |
| Models (GGUF, imported, downloaded)                                                         | `models`                                                    | yes                                          | yes                                             |
| Speech weights                                                                              | `cache\stt`                                                 | yes                                          | yes                                             |
| Semantic-memory model (Chroma all-MiniLM, about 79 MB)                                      | `cache\chroma`                                              | yes                                          | yes                                             |
| pip libraries (faster-whisper, torch, ...)                                                  | `runtime\.venv`                                             | yes                                          | yes                                             |
| Tools FRIDAY unpacks herself (portable Node, MinGit, ...)                                   | `runtime\<tool>`                                            | yes                                          | yes                                             |
| Skills, agents, plugins, modules, workflows                                                 | their own folders                                           | yes                                          | yes                                             |
| Owner uploads and generated files                                                           | `library`                                                   | yes                                          | yes                                             |
| The owner's own voice (recordings of the owner, the encrypted voiceprint and wake template) | `preferences\voice-enrollment`                              | yes                                          | yes (and "Forget my voice" in Settings → Voice) |
| Memory, conversations, database, settings, keys                                             | `memory`, `conversations`, `database`, `config`, `security` | yes                                          | yes                                             |
| winget and vendor installs (Git, Go, Rust, Docker, CUDA, FFmpeg, ...)                       | Windows' own folders and PATH                               | yes                                          | no (they belong to the PC)                      |
| npm global packages                                                                         | the user's npm prefix                                       | yes                                          | no                                              |
| Ollama's own models                                                                         | `%USERPROFILE%\.ollama`                                     | yes                                          | no                                              |

`<root>\inventory.json` (`electron/install-inventory.cjs`) writes down the real state of that table: one row per tool, model and speech weight with its home, path, version and whether a newer one exists. It is rebuilt from the Install Manager scan and the real folders, written only when it changed, and hashed in `integrity.json`. It adds no second detector or installer.

**Deleting voice data** (Settings, Voice) clears the voiceprint, the voice caches and the temp clips, and also the local reply clips in the spoken-reply cache. It removes only files named the way FRIDAY names them (a 16-hex clip, or a 40-hex `.mp3` or `.wav` reply), never follows a link out of its root, removes no folder, and reports the counts it removed. Linux unit tests only; Windows unverified.

Research (2026-10-25). Program and data apart: [electron-builder NSIS](https://www.electron.build/docs/nsis) keeps `deleteAppDataOnUninstall` off by default and identifies the install by its GUID, so ADOPT (already the contract). Forcing winget installs into the root: [winget install](https://learn.microsoft.com/en-us/windows/package-manager/winget/install) `--location` only works when the package manifest exposes a location to the installer, and Docker, Visual Studio and CUDA need system folders, services and PATH, so REJECT; they stay on the PC and are recorded. Ollama keeps models in `%USERPROFILE%\.ollama` (`OLLAMA_MODELS` changes it) and its uninstaller leaves a custom folder alone ([Ollama on Windows](https://docs.ollama.com/windows)); moving it would change the owner's own Ollama, so REJECT, and the inventory lists Ollama and the models page reads its tags. The official pages could not be fetched from the build machine; the claims above come from search snippets of those pages and are unverified against the pages themselves.

In a source checkout the nine `memory/*` folders are tracked only as `.gitkeep` files; `.gitignore` keeps everything stored inside them out of git, so a fresh clone has the layout `npm run arrange:check` expects and a checkout used as the FRIDAY root does not show memories as changes.

Downloads staged before a folder exists: setup and the build write models to `.friday-dev` in the checkout when no folder is selected and record that location. On boot and on `workspace:set` the app moves each staged speech weight (`cache/stt/*`), model (`models/*`) and installer (`runtime/installers/*`) into the root through `electron/staged-assets.cjs`, only into a place that is still free, so nothing is overwritten and nothing is downloaded twice. The staged database, memory and settings are never moved. `FRIDAY_ADOPT_STAGED=0` turns it off.

### The portable EXE has its own root

The portable EXE is not an installation, so it never uses the installed FRIDAY's root, its settings folder (`%APPDATA%\FRIDAY`) or its registry pointer. `electron/portable-data.cjs` gives it `FRIDAY-Portable-Data` beside the portable file (else `%LOCALAPPDATA%\FRIDAY-Portable-Data`, also when the file sits inside a source checkout whose `release\` the next build deletes; `FRIDAY_PORTABLE_DATA` names another home and `FRIDAY_PORTABLE_ROOT` another FRIDAY root; a `FRIDAY_WORKSPACE_ROOT` in the shell is ignored): `userData` for Electron's settings and single-instance lock, and `FRIDAY` as its FRIDAY root. It never writes `HKCU\Software\FRIDAY\WorkspacePath`. Removing the portable file removes nothing else; deleting `FRIDAY-Portable-Data` removes its data.

## 3. Update backup / rollback

`electron/update-safety.cjs`: verify → `backupState` into `<root>/backup/releases/<stamp>` → install → health → `rollback` if needed. Protected copies exclude bulky `models` / `voices` from the backup set but must not be deleted by an update.

## 4. Uninstall

Typed in `installer/uninstall/index.ts` (`KEEP_DATA_PLAN` / `DELETE_EVERYTHING_PLAN`). NSIS welcome: default keep-data removes `<root>\App` only. Tick “Delete all FRIDAY data and resources” (`StrCpy $FridayUnMode "delete"`) to remove the whole root. A silent uninstall (`/S`) always keeps the data; `Uninstall FRIDAY.exe /S /DELETEDATA` is the scripted form of the ticked box (FRIDAY Test never erases). `electron-builder.yml` `nsis.deleteAppDataOnUninstall: false`.

TEST installs use `dev.friday.desk.test` so they cannot overwrite Official data. Isolation: [FRIDAY_BUILD_AND_RELEASE.md](FRIDAY_BUILD_AND_RELEASE.md).

## 4a. Who owns each folder (`OWNERSHIP` in `electron/friday-contract.cjs`)

Updating by replacing the program from the new package, and never touching the owner's data, is already how every path works. `OWNERSHIP` is the one table that says which folder is which, and the importer (`USER_DATA_DIRS`), the update safety net (`PROTECTED`, `MUST_PRESERVE`) and the storage janitor (`PROTECTED_AREAS`) all read it instead of keeping their own lists (`core/__tests__/ownership-contract.test.ts` fails if a folder is in two classes, is in none, or a path disagrees).

- **program** (`app`, `src`, `electron`, `kernel`, `scripts`, `core`, `docs`, ...): replaced from the package.
- **shared** (`config`, `skills`, `agents`, `plugins`, `modules`, `workflows`, `tools`, `models`, ...): the package adds or replaces only the files it carries; nothing the owner added is removed. `models` is here because the source tree ships code in `models/` while the same folder holds downloaded weights.
- **data** (`memory`, `conversations`, `database`, `library`, `knowledge`, `voices`, `runtime`, `cache`, `logs`, `security`, ...): a package never replaces a file that is already there and nothing is deleted.

An update writes only files the package contains and deletes nothing outside `App`, so data that no package carries cannot be reset by it. A single "data folder" that moves all of this was weighed again on 2026-10-25 and not adopted: about 150 files read `models`, 130 read `config`, 84 read `memory` and 74 read `runtime` by their top-level name (installer, uninstall, rollback, kernel, scripts, tests), and the install, update and uninstall paths cannot be run on Windows from the build machine. The table above gives the same safety without moving a file.

## 5. Layout boundary

The folders under `FRIDAY_ROOT` stay the storage layout. A second tree that moves user data was not adopted. Official payload can be replaced. User components, user runtimes, and user data stay.

## 6. Logical records

Request, task, run, capability, provider, action, observation, verification, and evidence records are checked in `src/lib/friday/self/run-receipt.ts` (`acceptRequest`, `backendInvariants`). The task graph calls them when a request is queued and when a run finishes. Secret rows are refused by `secretStaysOutOfMemory` before `memory.remember` writes. The kernel keeps one SQLite file. `kernel/db.py` `migrate()` copies that file before new columns, then stores `schema_version`. The same idempotency key does not open a second task. There is no second task database, model registry, approval store, memory system, or connector registry.
