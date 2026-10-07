/**
 * FRIDAY · expertise
 *
 * FRIDAY's own built-in engineering knowledge — the part of her brain that
 * does not need an AI model at all.
 *
 * It holds three kinds of real, checkable knowledge:
 *   1. TOOLS      — what a tool is, where it officially comes from, how it is
 *                   installed on Windows and how its presence is verified.
 *   2. ERRORS     — real error signatures (the exact strings Windows, Node,
 *                   Python, Electron, Git, CUDA and the model providers emit),
 *                   what they mean, and the concrete fix steps.
 *   3. GUIDES +   — short operational guides, plus practical language and
 *      LANGUAGES    coding knowledge (TypeScript, JavaScript, Python, React,
 *                   SQL, PowerShell, JSON/YAML) she can quote and apply.
 *
 * Nothing here is generated at runtime and nothing here is invented per answer:
 * it is a curated corpus with official sources, so when FRIDAY explains a fix
 * she can point at where the tool really comes from.
 */

export type ExpertiseKind = "tool" | "error" | "guide" | "language";

export type ExpertiseEntry = {
  id: string;
  kind: ExpertiseKind;
  title: string;
  /** Extra search words beyond the title/summary. */
  keywords: string[];
  summary: string;
  /** Official download / documentation source, when the entry has one. */
  source?: string;
  /** How the problem shows up (error entries). */
  symptoms?: string[];
  /** Ordered, concrete steps. Commands are real Windows commands. */
  steps?: string[];
  /** A short snippet or command worth quoting verbatim. */
  snippet?: string;
};

/* ------------------------------------------------------------------ tools */

const TOOLS: ExpertiseEntry[] = [
  {
    id: "tool.node",
    kind: "tool",
    title: "Node.js",
    keywords: ["node", "npm", "npx", "javascript runtime"],
    summary:
      "JavaScript runtime that builds and runs FRIDAY's renderer and Electron shell. npm ships with it.",
    source: "https://nodejs.org/en/download",
    steps: [
      "Install the Windows LTS MSI from nodejs.org (or `winget install OpenJS.NodeJS.LTS`).",
      "Verify with `node -v` and `npm -v` in a new terminal — a stale terminal keeps the old PATH.",
      "FRIDAY needs Node 20 or newer for Vite 7 and Electron builds.",
    ],
    snippet: "winget install OpenJS.NodeJS.LTS",
  },
  {
    id: "tool.python",
    kind: "tool",
    title: "Python",
    keywords: ["python", "pip", "venv", "kernel"],
    summary:
      "Runs FRIDAY's kernel (planner, router, tools, device control). 3.12.10 or newer is required.",
    source: "https://www.python.org/downloads/windows/",
    steps: [
      "Install Python 3.12+ and tick 'Add python.exe to PATH'.",
      "Verify with `python --version`; if Windows opens the Store instead, disable the App Execution Alias for python.exe.",
      "FRIDAY creates its own virtual environment under <root>/runtime and installs kernel/requirements.txt into it.",
    ],
    snippet:
      "python -m venv .venv && .venv\\Scripts\\python -m pip install -r kernel/requirements.txt",
  },
  {
    id: "tool.git",
    kind: "tool",
    title: "Git",
    keywords: ["git", "clone", "repository", "version control"],
    summary: "Used by the Hub to import capability packs and repositories by URL.",
    source: "https://git-scm.com/download/win",
    steps: [
      "Install Git for Windows (or `winget install Git.Git`).",
      "Verify with `git --version`.",
      "For long paths run `git config --system core.longpaths true` as administrator.",
    ],
  },
  {
    id: "tool.ollama",
    kind: "tool",
    title: "Ollama",
    keywords: ["ollama", "local model", "llama", "gguf", "11434"],
    summary:
      "Local model runner. FRIDAY talks to it over http://127.0.0.1:11434 and lists whatever models are pulled.",
    source: "https://ollama.com/download",
    steps: [
      "Install Ollama for Windows and let it start its background service.",
      "Pull a model, e.g. `ollama pull llama3.1:8b` or `ollama pull qwen2.5:7b`.",
      "Verify with `ollama list` and `curl http://127.0.0.1:11434/api/tags`.",
      "If FRIDAY shows no local models, start the service first — the model list is read live, never cached as fake.",
    ],
    snippet: "ollama pull qwen2.5:7b && ollama list",
  },
  {
    id: "tool.cuda",
    kind: "tool",
    title: "NVIDIA CUDA / drivers",
    keywords: ["cuda", "gpu", "nvidia", "nvidia-smi", "vram", "acceleration"],
    summary:
      "GPU acceleration for local models. FRIDAY reads real GPU state from nvidia-smi — no GPU claim is ever simulated.",
    source: "https://developer.nvidia.com/cuda-downloads",
    steps: [
      "Update the NVIDIA driver first; CUDA needs a matching driver version.",
      "Verify with `nvidia-smi` — it prints driver version, CUDA version, VRAM and running processes.",
      "If `nvidia-smi` is not recognised, add C:\\Windows\\System32 (or the NVIDIA NVSMI folder) to PATH.",
    ],
    snippet: "nvidia-smi",
  },
  {
    id: "tool.electron-builder",
    kind: "tool",
    title: "electron-builder / NSIS",
    keywords: ["electron-builder", "nsis", "installer", "exe", "packaging"],
    summary:
      "Packages FRIDAY into a Windows EXE and NSIS installer, driven by electron-builder.yml.",
    source: "https://www.electron.build/",
    steps: [
      "Build with `scripts\\build-windows.cmd` — it sets the local cache directories that avoid symlink failures.",
      "Artifacts land in releases/installers.",
      "Icon, publisher and version metadata come from electron-builder.yml plus scripts/brand-windows.cjs.",
    ],
  },
  {
    id: "tool.vite",
    kind: "tool",
    title: "Vite",
    keywords: ["vite", "bundler", "dev server", "hmr", "build"],
    summary:
      "Builds the renderer. Dev server runs on port 8080; the packaged app loads via the friday:// scheme.",
    source: "https://vite.dev/guide/",
  },
  {
    id: "tool.sqlite",
    kind: "tool",
    title: "SQLite",
    keywords: ["sqlite", "database", "friday.sqlite3", "db"],
    summary:
      "FRIDAY's single database, always at <root>/database/friday.sqlite3. Conversations, memory and task history live there.",
    source: "https://www.sqlite.org/docs.html",
    steps: [
      "If the DB is missing, Setup & Doctor recreates and migrates it.",
      "Never open the same file from two FRIDAY installs at once — that is what causes 'database is locked'.",
    ],
  },
  {
    id: "tool.adb",
    kind: "tool",
    title: "ADB (Android Platform Tools)",
    keywords: ["adb", "android", "phone", "usb debugging", "scrcpy"],
    summary: "Cable/Wi-Fi control of an Android phone from the Devices page.",
    source: "https://developer.android.com/tools/releases/platform-tools",
    steps: [
      "Enable Developer options → USB debugging on the phone.",
      "Run `adb devices` and accept the RSA prompt on the phone.",
      "For wireless: `adb tcpip 5555` then `adb connect <phone-ip>:5555`.",
    ],
    snippet: "adb devices",
  },
  {
    id: "tool.ffmpeg",
    kind: "tool",
    title: "FFmpeg",
    keywords: ["ffmpeg", "audio", "video", "convert", "tts"],
    summary: "Audio/video conversion used by voice capture and media tools.",
    source: "https://www.gyan.dev/ffmpeg/builds/",
  },
  {
    id: "tool.vcredist",
    kind: "tool",
    title: "Visual C++ Redistributable",
    keywords: ["vcruntime", "vcredist", "msvcp140", "dll"],
    summary:
      "Native modules (SQLite bindings, llama runtimes) need the VC++ 2015–2022 x64 runtime.",
    source: "https://aka.ms/vs/17/release/vc_redist.x64.exe",
  },
  {
    id: "tool.openrouter",
    kind: "tool",
    title: "OpenRouter (free-first cloud models)",
    keywords: ["openrouter", "cloud model", "api key", "free models"],
    summary:
      "FRIDAY's free-first cloud route. Free models are discovered live; paid ones are only used when explicitly enabled.",
    source: "https://openrouter.ai/docs/api-reference/overview",
    steps: [
      "Create a key at openrouter.ai and paste it into Models → Providers.",
      "FRIDAY refreshes the live catalogue before routing, so a newly added key works without a restart.",
    ],
  },
  {
    id: "tool.lmstudio",
    kind: "tool",
    title: "LM Studio",
    keywords: ["lm studio", "lmstudio", "local server", "1234"],
    summary: "Alternative local runner exposing an OpenAI-compatible server on port 1234.",
    source: "https://lmstudio.ai/",
  },
  {
    id: "tool.huggingface",
    kind: "tool",
    title: "Hugging Face",
    keywords: ["huggingface", "hf", "gguf", "model download"],
    summary:
      "Source for GGUF weights used by local runners; FRIDAY's downloader can pull from multiple mirrors.",
    source: "https://huggingface.co/docs/hub/index",
  },
  {
    id: "tool.powershell",
    kind: "tool",
    title: "PowerShell",
    keywords: ["powershell", "pwsh", "script", "execution policy"],
    summary: "Drives FRIDAY's Windows setup, repair and process-lifecycle scripts.",
    source: "https://learn.microsoft.com/powershell/",
    steps: [
      "If a script is blocked: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.",
      "Run elevated only when the task truly needs it (installs, service control).",
    ],
  },
];

/* ----------------------------------------------------------------- errors */

const ERRORS: ExpertiseEntry[] = [
  {
    id: "err.eaddrinuse",
    kind: "error",
    title: "EADDRINUSE — port already in use",
    keywords: ["eaddrinuse", "port", "address in use", "8080", "11434"],
    summary: "Another process already owns the port the service wants.",
    symptoms: ["listen EADDRINUSE", "address already in use"],
    steps: [
      "Find the owner: `netstat -ano | findstr :<port>`.",
      'Identify it: `tasklist /fi "pid eq <pid>"`.',
      "Close that app, or stop it: `taskkill /pid <pid> /f`.",
      "A second FRIDAY instance is the usual cause — check the tray before killing anything.",
    ],
    snippet: "netstat -ano | findstr :8080",
  },
  {
    id: "err.enoent",
    kind: "error",
    title: "ENOENT — file or command not found",
    keywords: ["enoent", "no such file", "spawn", "not recognized"],
    summary: "The path or executable does not exist where the caller looked.",
    symptoms: [
      "ENOENT: no such file or directory",
      "spawn npm ENOENT",
      "is not recognized as an internal or external command",
    ],
    steps: [
      "For a command: confirm it is installed and on PATH, then reopen the terminal (PATH is read at start).",
      "On Windows, Node must spawn `npm.cmd`, not `npm` — a bare `npm` spawn always throws ENOENT.",
      "For a path: check the FRIDAY root folder is still where it was selected; Setup & Doctor revalidates it.",
    ],
  },
  {
    id: "err.eacces",
    kind: "error",
    title: "EACCES / EPERM — permission denied",
    keywords: ["eacces", "eperm", "access denied", "permission"],
    summary: "The process lacks rights on that file, folder or service.",
    steps: [
      "Close anything holding the file (antivirus, editor, a running FRIDAY).",
      "Re-run the action as administrator when it installs or writes outside the root folder.",
      "Prefer moving the FRIDAY root out of Program Files — a user-owned folder avoids this class entirely.",
    ],
  },
  {
    id: "err.symlink",
    kind: "error",
    title: "Cannot create symbolic link: a required privilege is not held",
    keywords: ["symbolic link", "symlink", "privilege", "electron-builder", "winCodeSign"],
    summary:
      "electron-builder's cache extraction needs symlink rights that a normal Windows user does not have.",
    steps: [
      "Build via `scripts\\build-windows.cmd`, which points ELECTRON_BUILDER_CACHE at a local folder.",
      "Or enable Developer Mode (Settings → Privacy & security → For developers).",
      "Or run the build shell as administrator once so the cache is extracted.",
    ],
  },
  {
    id: "err.module-not-found",
    kind: "error",
    title: "MODULE_NOT_FOUND / Cannot find module",
    keywords: ["module_not_found", "cannot find module", "npm install", "node_modules"],
    summary: "A dependency is missing from node_modules or was not bundled into the package.",
    steps: [
      "Run `npm ci` (clean, lockfile-exact) rather than `npm install` when the lockfile is authoritative.",
      "If it only fails in the packaged EXE, the module was tree-shaken out — it must be a real dependency, not devDependency.",
      "Delete node_modules and the Vite cache, then reinstall if the tree is inconsistent.",
    ],
    snippet: "npm ci",
  },
  {
    id: "err.429",
    kind: "error",
    title: "HTTP 429 — rate limited by a model provider",
    keywords: ["429", "rate limit", "too many requests", "quota"],
    summary:
      "The provider is throttling. It is not a FRIDAY bug and retrying the same route immediately makes it worse.",
    steps: [
      "FRIDAY marks that model unhealthy and falls back to the next free candidate automatically.",
      "Add a second free provider key so the fallback chain has somewhere to go.",
      "For steady work, pull a local Ollama model — local routes are never rate limited.",
    ],
  },
  {
    id: "err.401",
    kind: "error",
    title: "HTTP 401/403 — invalid or missing API key",
    keywords: ["401", "403", "unauthorized", "invalid api key", "forbidden"],
    summary: "The provider rejected the credential.",
    steps: [
      "Re-paste the key in Models → Providers; a trailing space or newline is the usual cause.",
      "Confirm the key's account still has access to that specific model.",
      "FRIDAY never silently pretends a keyless provider answered — a 401 is surfaced as-is.",
    ],
  },
  {
    id: "err.econnrefused",
    kind: "error",
    title: "ECONNREFUSED — local service not running",
    keywords: ["econnrefused", "connection refused", "ollama", "kernel", "11434"],
    summary: "Nothing is listening on that port — the service is stopped, not broken.",
    steps: [
      "Ollama: start it, then `curl http://127.0.0.1:11434/api/tags`.",
      "FRIDAY kernel: Setup & Doctor → repair Python runtime, then restart FRIDAY.",
      "Check a firewall rule is not blocking loopback for that executable.",
    ],
  },
  {
    id: "err.cuda-oom",
    kind: "error",
    title: "CUDA out of memory",
    keywords: ["cuda out of memory", "oom", "vram", "gpu memory"],
    summary: "The model does not fit in free VRAM alongside what is already loaded.",
    steps: [
      "Close other GPU consumers (browser with hardware acceleration, games) and re-check `nvidia-smi`.",
      "Use a smaller quantisation (Q4_K_M instead of Q8) or a smaller parameter count.",
      "Reduce context length — context is the fastest-growing part of VRAM use.",
    ],
  },
  {
    id: "err.python-missing",
    kind: "error",
    title: "Python was not found / Microsoft Store opens instead",
    keywords: ["python was not found", "app execution alias", "store", "python not found"],
    summary: "Windows' Store alias is shadowing a real Python install.",
    steps: [
      "Settings → Apps → Advanced app settings → App execution aliases → turn off python.exe and python3.exe.",
      "Reinstall Python 3.12+ with 'Add to PATH' ticked, then reopen the terminal.",
      "Setup & Doctor will then detect and reuse the existing interpreter instead of downloading one.",
    ],
  },
  {
    id: "err.white-screen",
    kind: "error",
    title: "Packaged Electron app opens to a blank/white window",
    keywords: ["white screen", "blank window", "packaged", "renderer", "asar"],
    summary:
      "The renderer bundle failed to load inside the package — almost always a path or scheme problem.",
    steps: [
      "FRIDAY loads the renderer through the custom friday:// scheme; a file:// fallback breaks ESM and CORS.",
      "Open the packaged app's devtools and read the first console error — it names the failing request.",
      "Rebuild with `scripts\\build-windows.cmd` so the renderer output is packaged fresh.",
    ],
  },
  {
    id: "err.db-locked",
    kind: "error",
    title: "SQLite: database is locked",
    keywords: ["database is locked", "sqlite busy", "sqlite_busy"],
    summary: "Two processes are writing the same database file.",
    steps: [
      "Make sure only one FRIDAY instance is running (check the tray).",
      "Close any external SQLite browser holding the file.",
      "Setup & Doctor can rebuild the database from backup if the lock survives a restart.",
    ],
  },
  {
    id: "err.adb-unauthorized",
    kind: "error",
    title: "ADB device shows 'unauthorized' or 'offline'",
    keywords: ["adb unauthorized", "device offline", "usb debugging"],
    summary: "The phone has not trusted this PC's ADB key yet.",
    steps: [
      "Unlock the phone and accept the 'Allow USB debugging' prompt (tick 'always allow').",
      "If no prompt appears: revoke USB debugging authorisations on the phone, then `adb kill-server && adb devices`.",
      "Try a data-capable cable — charge-only cables enumerate as offline.",
    ],
  },
  {
    id: "err.ts2307",
    kind: "error",
    title: "TS2307 — cannot find module or its type declarations",
    keywords: ["ts2307", "typescript", "cannot find module", "types"],
    summary: "TypeScript cannot resolve the import path or the package ships no types.",
    steps: [
      "Check the path alias (`@/...`) matches tsconfig paths and the file really exists.",
      "Install the types package, or add a small .d.ts declaring the module.",
      "Restart the TS server after changing tsconfig — it caches resolution.",
    ],
  },
  {
    id: "err.hydration",
    kind: "error",
    title: "React hydration mismatch",
    keywords: ["hydration", "mismatch", "ssr", "did not match"],
    summary: "Server-rendered markup differs from the first client render.",
    steps: [
      "Do not read Date.now(), window, or storage during the first render — move it into useEffect.",
      "Guard browser-only components behind a hydrated flag rather than a typeof window check in useState.",
    ],
  },
  {
    id: "err.aborted",
    kind: "error",
    title: "Error: aborted (abortIncoming)",
    keywords: ["aborted", "abortincoming", "socket", "client disconnect"],
    summary:
      "A client disconnected mid-request. It is expected noise, not an application fault, and must never blank the UI.",
    steps: [
      "Ignore it when it comes from a page navigation or a dev-server restart.",
      "Only investigate if it repeats on one specific route while the page is idle.",
    ],
  },
];

/* -------------------------------------------------- guides and languages  */

const GUIDES: ExpertiseEntry[] = [
  {
    id: "guide.build-exe",
    kind: "guide",
    title: "Building the Windows EXE and installer",
    keywords: ["build", "exe", "installer", "package", "release"],
    summary: "The one supported build path for FRIDAY on Windows.",
    steps: [
      "`npm ci` — install exactly what the lockfile pins.",
      "`npm run doctor` — confirm Node, Python, Git and the runtime folders are healthy first.",
      "`scripts\\build-windows.cmd` — builds the renderer, packages Electron, brands the EXE and writes the installer.",
      "Install the artifact from releases/installers and launch it once to confirm readiness reaches READY.",
    ],
  },
  {
    id: "guide.upgrade-in-place",
    kind: "guide",
    title: "Upgrading an installed FRIDAY without losing data",
    keywords: ["upgrade", "update", "in place", "migration", "backup"],
    summary:
      "Everything the owner cares about lives in the selected root folder, not in the install directory.",
    steps: [
      "Install the new version over the old one — the installer closes the running app first.",
      "On first launch FRIDAY revalidates the root and migrates the database if the schema moved.",
      "A rollback point is written before a migration; Setup & Doctor can restore it.",
    ],
  },
  {
    id: "guide.connect-model",
    kind: "guide",
    title: "Connecting a model (local or cloud)",
    keywords: ["connect model", "add model", "provider", "routing"],
    summary: "Local first when privacy or rate limits matter; free cloud when quality matters.",
    steps: [
      "Local: install Ollama, `ollama pull qwen2.5:7b`, then refresh Models — it appears automatically.",
      "Cloud: paste a provider key in Models → Providers; free models are preferred by policy.",
      "Pin a model per task (brain / coding / reasoning / vision) in Models → Routing; the pin always wins.",
    ],
  },
  {
    id: "guide.slow-app",
    kind: "guide",
    title: "When FRIDAY feels slow or unresponsive",
    keywords: ["slow", "freeze", "lag", "unresponsive", "performance"],
    summary: "Almost always a heavy background job, not the UI itself.",
    steps: [
      "Check the System page for real CPU/RAM/GPU load and which subsystem is busy.",
      "A first-run workspace scan and a model download are the two heaviest jobs — both run in workers and finish.",
      "If a local model is loaded, its VRAM/RAM footprint is the cost; unload it when idle.",
    ],
  },
  {
    id: "guide.local-stt",
    kind: "guide",
    title: "Local speech recognition (faster-whisper)",
    keywords: [
      "faster-whisper",
      "speech recognition",
      "microphone",
      "stt",
      "can't hear",
      "voice input",
      "mic permission",
    ],
    summary:
      "Auto Mode transcribes on-device with faster-whisper. FRIDAY cannot grant Windows microphone permission or download that model without you.",
    steps: [
      "Open Install Manager and install faster-whisper — that is FRIDAY's on-device transcriber. Browser cloud speech is never used.",
      "Windows Settings → Privacy & security → Microphone: allow FRIDAY.exe. FRIDAY cannot grant herself that permission.",
      "Confirm a working microphone is plugged in and selected in Settings → Voice.",
      "Switch Auto Mode off and on, or say “what's wrong”, so FRIDAY retries for real instead of looping a dead engine.",
    ],
  },
  {
    id: "guide.reset-safely",
    kind: "guide",
    title: "Resetting safely without losing memory",
    keywords: ["reset", "clean", "reinstall", "cache"],
    summary: "Clear caches, never the root folder.",
    steps: [
      "Safe to clear: temporary/, debug/, build caches, Vite cache.",
      "Never delete: database/, memory/, conversations/, config/ — that is FRIDAY's actual life.",
      "Take a backup from Setup & Doctor before anything destructive.",
    ],
  },
];

const LANGUAGES: ExpertiseEntry[] = [
  {
    id: "lang.typescript",
    kind: "language",
    title: "TypeScript",
    keywords: ["typescript", "ts", "types", "interface", "generic", "tsconfig"],
    summary:
      "Typed JavaScript. Prefer narrow unions over enums, `unknown` over `any`, and let inference do the work; type only the boundaries.",
    snippet: "type Result<T> = { ok: true; value: T } | { ok: false; error: string };",
    steps: [
      "Strict mode on: it turns whole error classes into compile-time failures.",
      "Model absence explicitly (`T | null`) instead of leaning on optional chaining everywhere.",
      "Narrow with type guards; a cast silences the compiler without fixing anything.",
    ],
  },
  {
    id: "lang.javascript",
    kind: "language",
    title: "JavaScript",
    keywords: ["javascript", "js", "async", "promise", "event loop", "node"],
    summary:
      "Single-threaded with an event loop: anything synchronous and long blocks everything, which is exactly how UIs freeze.",
    snippet: "const results = await Promise.all(items.map(work));",
    steps: [
      "Await in parallel with Promise.all when the calls are independent.",
      "Always attach a catch — an unhandled rejection can take a process down.",
      "Move CPU-heavy work to a worker; in Electron, off the main process.",
    ],
  },
  {
    id: "lang.python",
    kind: "language",
    title: "Python",
    keywords: ["python", "py", "asyncio", "venv", "pip", "fastapi"],
    summary:
      "FRIDAY's kernel language. Use a virtual environment per project, type hints on public functions, and asyncio for I/O.",
    snippet: "python -m venv .venv && .venv\\Scripts\\activate && pip install -r requirements.txt",
    steps: [
      "Catch specific exceptions; a bare `except:` hides the bug you are chasing.",
      "Use pathlib for paths — string joins break the moment a path has a space.",
      "subprocess.run(..., capture_output=True, text=True) gives you the real error text to report.",
    ],
  },
  {
    id: "lang.react",
    kind: "language",
    title: "React",
    keywords: ["react", "hooks", "usestate", "useeffect", "render", "component"],
    summary:
      "Render from state, never mutate it. Most 'random' React bugs are a stale closure or an effect that re-runs.",
    snippet:
      "useEffect(() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }, []);",
    steps: [
      "Every subscription, timer and listener returns a cleanup function.",
      "Derive values during render instead of mirroring them into extra state.",
      "Keys must be stable identities, not array indexes, or list state jumps between rows.",
    ],
  },
  {
    id: "lang.sql",
    kind: "language",
    title: "SQL / SQLite",
    keywords: ["sql", "sqlite", "query", "index", "join", "transaction"],
    summary:
      "Bind parameters, index what you filter on, and wrap multi-statement writes in a transaction.",
    snippet: "SELECT id, title FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 50;",
    steps: [
      "Never build SQL by string concatenation — parameters are both safer and faster.",
      "EXPLAIN QUERY PLAN tells you whether an index is actually used.",
      "Batch inserts inside one transaction; per-row commits are the classic slowdown.",
    ],
  },
  {
    id: "lang.powershell",
    kind: "language",
    title: "PowerShell / CMD",
    keywords: ["powershell", "cmd", "batch", "shell", "script", "windows"],
    summary: "Windows automation. Objects flow through the pipeline, so filter before you format.",
    snippet: "Get-Process | Where-Object CPU -gt 100 | Select-Object Name, CPU",
    steps: [
      "Quote paths with spaces and prefer `Join-Path` over manual concatenation.",
      "Check `$LASTEXITCODE` after calling native executables — PowerShell will not throw for you.",
      "Use `-ErrorAction Stop` with try/catch when a failure must abort the script.",
    ],
  },
  {
    id: "lang.json-yaml",
    kind: "language",
    title: "JSON / YAML",
    keywords: ["json", "yaml", "config", "manifest", "parse error"],
    summary:
      "FRIDAY's manifests and build config. Most parse failures are a trailing comma (JSON) or a tab (YAML).",
    steps: [
      "JSON has no comments and no trailing commas.",
      "YAML forbids tabs for indentation — spaces only, consistently.",
      "Validate a manifest before importing it; the Hub reports the exact line it choked on.",
    ],
  },
];

export const EXPERTISE: ExpertiseEntry[] = [...TOOLS, ...ERRORS, ...GUIDES, ...LANGUAGES];

/* --------------------------------------------------------------- retrieval */

const words = (value: string) =>
  String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9+._#-]+/)
    .filter((word) => word.length > 2);

function scoreEntry(entry: ExpertiseEntry, query: string): number {
  const lower = query.toLowerCase();
  let score = 0;
  if (lower.includes(entry.title.toLowerCase())) score += 6;
  for (const keyword of entry.keywords) {
    if (lower.includes(keyword.toLowerCase())) score += keyword.includes(" ") ? 4 : 3;
  }
  for (const symptom of entry.symptoms ?? []) {
    if (lower.includes(symptom.toLowerCase())) score += 8;
  }
  const haystack = words(`${entry.title} ${entry.summary} ${entry.keywords.join(" ")}`);
  for (const token of new Set(words(query))) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

/** Ranked lookup across every entry. Pure and fast — no I/O. */
export function searchExpertise(query: string, k = 3): ExpertiseEntry[] {
  const text = String(query || "").trim();
  if (!text) return [];
  return EXPERTISE.map((entry) => ({ entry, score: scoreEntry(entry, text) }))
    .filter((row) => row.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k))
    .map((row) => row.entry);
}

/** Matches pasted error text against known signatures. */
export function diagnoseError(errorText: string): ExpertiseEntry[] {
  const text = String(errorText || "");
  if (!text.trim()) return [];
  return EXPERTISE.filter((entry) => entry.kind === "error")
    .map((entry) => ({ entry, score: scoreEntry(entry, text) }))
    .filter((row) => row.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((row) => row.entry);
}

/** True when the text looks like a pasted error/stack rather than a question. */
export function looksLikeError(text: string): boolean {
  const value = String(text || "");
  return (
    /\b(error|exception|traceback|failed|fatal)\b/i.test(value) &&
    (/\b[A-Z]{4,}\b/.test(value) ||
      /\bat\s+[\w.$]+\s*\(/.test(value) ||
      /exit (code|status)\s*\d+/i.test(value) ||
      /\b(errno|code)\s*[:=]/i.test(value) ||
      /https?:\/\/|\\|\//.test(value))
  );
}

/** Renders one entry the way FRIDAY speaks: short, concrete, sourced. */
export function formatEntry(entry: ExpertiseEntry): string {
  const lines = [`**${entry.title}** — ${entry.summary}`];
  if (entry.symptoms?.length) lines.push(`Looks like: ${entry.symptoms.join(" · ")}`);
  if (entry.steps?.length) lines.push(...entry.steps.map((step, i) => `${i + 1}. ${step}`));
  if (entry.snippet) lines.push("```\n" + entry.snippet + "\n```");
  if (entry.source) lines.push(`Source: ${entry.source}`);
  return lines.join("\n");
}

/** A compact block of relevant expertise to hand a model as context. */
export function expertiseContext(prompt: string, k = 2): string[] {
  return searchExpertise(prompt, k).map(
    (entry) =>
      `[${entry.kind}] ${entry.title}: ${entry.summary}${entry.source ? ` (source: ${entry.source})` : ""}`,
  );
}
