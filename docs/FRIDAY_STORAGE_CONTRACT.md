# FRIDAY — Storage, Installation, Update & Uninstall Contract (v1.0.1.2)

💾 One disk root and what Setup / update / uninstall may touch. Pack steps: [INSTALL.md](../INSTALL.md). Stable versus Test in the running app: [FRIDAY_BUILD_AND_RELEASE.md](FRIDAY_BUILD_AND_RELEASE.md).

## 1. `FRIDAY_ROOT`

Resolved only by `electron/friday-paths.cjs` (`ensureStructure()`) using `electron/friday-contract.cjs` (`FOLDERS`, `NAMES`, `TREES`). Order: session selection (`workspace:set`, `--workspace`, env) → persisted pointer → `HKCU\Software\FRIDAY\WorkspacePath` → none (first run asks). Persistent data is not stored in AppData, IndexedDB, or `process.cwd()`.

When that root is also the Git clone, `kernel/` (FastAPI `main.py` + `requirements.txt`) and `src/` (renderer `routes/` + `lib/friday`) stay as source trees. They are not data aliases of `backend` / `frontend`. `ensureStructure` restores them if they were already renamed, then creates sibling data folders. `scripts/setup-python.cjs` uses `resolveKernelSource` so `npm run build:win` still finds `requirements.txt` if a rename cannot run. Pack from a clone that is not the installed FRIDAY data root when you can. Walkthrough: [INSTALL.md](../INSTALL.md).

Setup `$INSTDIR` is `<chosen root>\App`. Normal upgrade replaces `App` wholesale. User folders beside it stay.

## 2. What lives under the root

Forty canonical top-level names including `app`, `runtime`, `models`, `memory`, `library`, `security`, `config`, `skills`, `tools`, `agents`, `plugins`, `modules`, `workflows`. Capability trees also have `TREES` segments (`skills/custom`, `plugins/installed`, …).

Python live venv: `<root>\runtime\.venv` when a folder is chosen.

## 3. Update backup / rollback

`electron/update-safety.cjs`: verify → `backupState` into `<root>/backup/releases/<stamp>` → install → health → `rollback` if needed. Protected copies exclude bulky `models` / `voices` from the backup set but must not be deleted by an update.

## 4. Uninstall

Typed in `installer/uninstall/index.ts` (`KEEP_DATA_PLAN` / `DELETE_EVERYTHING_PLAN`). NSIS welcome: default keep-data removes `<root>\App` only. Tick “Delete all FRIDAY data and resources” (`StrCpy $FridayUnMode "delete"`) to remove the whole root. `electron-builder.yml` `nsis.deleteAppDataOnUninstall: false`.

TEST installs use `dev.friday.desk.test` so they cannot overwrite Official data. Isolation: [FRIDAY_BUILD_AND_RELEASE.md](FRIDAY_BUILD_AND_RELEASE.md).

## 5. Layout boundary

The folders under `FRIDAY_ROOT` stay the storage layout. A second tree that moves user data was not adopted. Official payload can be replaced. User components, user runtimes, and user data stay.

## 6. Logical records

Request, task, run, capability, provider, action, observation, verification, and evidence records are checked in `src/lib/friday/self/run-receipt.ts` (`acceptRequest`, `backendInvariants`). The task graph calls them when a request is queued and when a run finishes. Secret rows are refused by `secretStaysOutOfMemory` before `memory.remember` writes. The kernel keeps one SQLite file. `kernel/db.py` `migrate()` copies that file before new columns, then stores `schema_version`. The same idempotency key does not open a second task. There is no second task database, model registry, approval store, memory system, or connector registry.

Research, 2026-10-08:

| Source | Decision | Reason |
| --- | --- | --- |
| [OpenAI Agents SDK](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) and [Agents API](https://openai.com/index/introducing-the-agents-api/) | ADAPT | Long runs stay on the existing task graph. No hosted agent sandbox. |
| [Gemini background execution](https://ai.google.dev/gemini-api/docs/background-execution) and [computer use](https://ai.google.dev/gemini-api/docs/computer-use) | ADAPT | The desktop loop already checkpoints. A tool success is not external proof. |
| [Claude Opus 4.6](https://www.anthropic.com/news/claude-opus-4-6) | REJECT | No hosted agent team. Child authority stays inside the parent scope. |
| [MCP revision 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/) and [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks) | ADAPT | Tasks stay in the existing kernel tables. No second protocol server. |
