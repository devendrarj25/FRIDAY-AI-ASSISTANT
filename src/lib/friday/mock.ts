import type {
  ChatTurn,
  KernelStatus,
  LogLine,
  MemoryRecord,
  ModelEntry,
  ModuleEntry,
  RuntimeEntry,
  Task,
  ToolDef,
} from "./types";

/**
 * Mock bridge data. In the packaged desktop app these payloads arrive from the
 * local Python kernel over the WebSocket bridge (see kernel/ and electron/).
 * The shapes here are the wire contract.
 */

export const kernelStatus: KernelStatus = {
  connected: true,
  host: "127.0.0.1:8765",
  version: "0.1.0",
  uptime: "04:12:38",
  gpu: "NVIDIA RTX 4070 · CUDA 12.4",
  vramUsedGb: 7.4,
  vramTotalGb: 12,
  dataDir: "C:\\FRIDAY\\data",
};

export const models: ModelEntry[] = [
  {
    id: "brain-qwen",
    label: "Qwen2.5 32B Instruct",
    provider: "llamacpp",
    endpoint: "http://127.0.0.1:8080/v1",
    params: "32B · Q4_K_M",
    status: "ready",
    role: "brain",
    contextK: 32,
  },
  {
    id: "coder-ds",
    label: "DeepSeek Coder V2 16B",
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    params: "16B · Q5",
    status: "ready",
    role: "coder",
    contextK: 64,
  },
  {
    id: "fast-llama",
    label: "Llama 3.2 3B",
    provider: "lmstudio",
    endpoint: "http://127.0.0.1:1234/v1",
    params: "3B · Q8",
    status: "ready",
    role: "fast",
    contextK: 16,
  },
  {
    id: "research-online",
    label: "Online reasoning model",
    provider: "online",
    endpoint: "https://api.provider.example/v1",
    params: "hosted · your key",
    status: "ready",
    role: "researcher",
    contextK: 200,
  },
  {
    id: "embed-bge",
    label: "bge-m3 embeddings",
    provider: "llamacpp",
    endpoint: "http://127.0.0.1:8081/v1",
    params: "560M · F16",
    status: "loading",
    role: "embed",
    contextK: 8,
  },
  {
    id: "vllm-mixtral",
    label: "Mixtral 8x7B",
    provider: "vllm",
    endpoint: "http://127.0.0.1:8000/v1",
    params: "MoE · AWQ",
    status: "offline",
    role: "researcher",
    contextK: 32,
  },
];

export const chatTurns: ChatTurn[] = [
  {
    id: "t1",
    role: "user",
    text: "Scan my project folder, find why the build fails, and prepare a fix branch.",
    at: "09:41",
  },
  {
    id: "t2",
    role: "assistant",
    modelId: "brain-qwen",
    reasoning:
      "Recalled 2 past runs on this repo. Prior lesson: this project pins Node 20, and the failure signature matches a mismatched lockfile. Plan: read logs, confirm, branch, patch, verify.",
    text: "Build fails in `postinstall` because the lockfile was generated on Node 22 while the project pins Node 20. I prepared branch `fix/lockfile-node20` with a regenerated lockfile. Approving the shell step will run the verification build.",
    at: "09:41",
  },
  {
    id: "t3",
    role: "assistant",
    modelId: "coder-ds",
    text: "Second opinion: same root cause. I would also add an `engines` field and a CI guard so this cannot regress.",
    at: "09:41",
  },
];

export const tools: ToolDef[] = [
  {
    name: "fs.read",
    summary: "Read files and directories inside allowed roots",
    risk: "safe",
    enabled: true,
  },
  { name: "fs.write", summary: "Create, edit and delete files", risk: "write", enabled: true },
  { name: "shell.cmd", summary: "Run a Windows cmd command", risk: "exec", enabled: true },
  {
    name: "shell.powershell",
    summary: "Run a PowerShell script block",
    risk: "exec",
    enabled: true,
  },
  { name: "git", summary: "Clone, branch, commit, diff, push", risk: "write", enabled: true },
  {
    name: "python.exec",
    summary: "Run a Python snippet in the managed venv",
    risk: "exec",
    enabled: true,
  },
  { name: "http.fetch", summary: "Fetch a URL and extract text", risk: "write", enabled: true },
  {
    name: "test.run",
    summary: "Run the detected test suite and parse results",
    risk: "exec",
    enabled: false,
  },
];

export const tasks: Task[] = [
  {
    id: "task-118",
    goal: "Fix failing build and open a verified fix branch",
    state: "awaiting-approval",
    createdAt: "09:41",
    model: "Qwen2.5 32B → DeepSeek Coder",
    steps: [
      {
        id: "s1",
        title: "Read build logs",
        tool: "fs.read",
        state: "done",
        detail: "3 files, 812 lines",
      },
      {
        id: "s2",
        title: "Recall prior runs on this repo",
        tool: "memory.search",
        state: "done",
        detail: "2 hits",
      },
      { id: "s3", title: "Create branch fix/lockfile-node20", tool: "git", state: "done" },
      {
        id: "s4",
        title: "Regenerate lockfile on Node 20",
        tool: "shell.cmd",
        state: "blocked",
        detail: "Needs your approval (exec)",
      },
      { id: "s5", title: "Run verification build", tool: "test.run", state: "pending" },
    ],
  },
  {
    id: "task-117",
    goal: "Summarise 14 research PDFs into a comparison table",
    state: "running",
    createdAt: "08:55",
    model: "Online reasoning model",
    steps: [
      {
        id: "s1",
        title: "Index PDFs into vector memory",
        tool: "memory.index",
        state: "done",
        detail: "14 docs · 1,902 chunks",
      },
      {
        id: "s2",
        title: "Extract claims per paper",
        tool: "model.map",
        state: "running",
        detail: "9 / 14",
      },
      { id: "s3", title: "Merge into table", state: "pending" },
    ],
  },
  {
    id: "task-116",
    goal: "Install and warm up DeepSeek Coder V2",
    state: "done",
    createdAt: "Yesterday",
    model: "kernel",
    steps: [
      {
        id: "s1",
        title: "Pull model weights",
        tool: "runtime.install",
        state: "done",
        detail: "9.6 GB",
      },
      { id: "s2", title: "Warm up + benchmark", state: "done", detail: "42 tok/s" },
    ],
  },
];

export const runtimes: RuntimeEntry[] = [
  {
    name: "Python",
    installed: "3.12.4",
    latest: "3.12.7",
    source: "python.org",
    size: "28 MB",
    kind: "runtime",
  },
  {
    name: "Node.js",
    installed: "20.15.1",
    latest: "22.9.0",
    source: "nodejs.org",
    size: "31 MB",
    kind: "runtime",
  },
  {
    name: "Git",
    installed: "2.45.2",
    latest: "2.46.0",
    source: "git-scm.com",
    size: "54 MB",
    kind: "tool",
  },
  {
    name: "llama.cpp",
    installed: "b3821",
    latest: "b3902",
    source: "github.com/ggml-org",
    size: "18 MB",
    kind: "engine",
  },
  {
    name: "Ollama",
    installed: "0.3.12",
    latest: "0.3.14",
    source: "ollama.com",
    size: "290 MB",
    kind: "engine",
  },
  {
    name: "CUDA Toolkit",
    installed: "12.4",
    latest: "12.6",
    source: "developer.nvidia.com",
    size: "2.9 GB",
    kind: "runtime",
  },
  {
    name: "VS Code",
    installed: null,
    latest: "1.94",
    source: "code.visualstudio.com",
    size: "105 MB",
    kind: "tool",
  },
  {
    name: "Java (Temurin)",
    installed: null,
    latest: "21 LTS",
    source: "adoptium.net",
    size: "190 MB",
    kind: "runtime",
  },
];

export const modules: ModuleEntry[] = [
  {
    name: "repo-import",
    version: "0.2.0",
    description: "Clone a Git repo, detect its stack and prepare a working environment.",
    permissions: ["fs.write", "git", "shell.cmd"],
    enabled: true,
    entry: "modules/repo-import/main.py",
  },
  {
    name: "research-desk",
    version: "0.1.4",
    description: "Multi-model research runs with citation capture into vector memory.",
    permissions: ["http.fetch", "memory.index"],
    enabled: true,
    entry: "modules/research-desk/main.py",
  },
  {
    name: "doc-writer",
    version: "0.1.1",
    description: "Generate and maintain project documentation from the codebase.",
    permissions: ["fs.read", "fs.write"],
    enabled: false,
    entry: "modules/doc-writer/main.py",
  },
];

export const memoryRecords: MemoryRecord[] = [
  {
    id: "m1",
    kind: "lesson",
    title: "Always check Node version before regenerating a lockfile",
    snippet:
      "Task 91 failed because the lockfile was rebuilt on a newer Node than the project pins.",
    score: 0.94,
    at: "3 days ago",
  },
  {
    id: "m2",
    kind: "task",
    title: "Task 104 — migrate scraper to async",
    snippet: "Plan, diffs and the final passing test output for the async migration.",
    score: 0.88,
    at: "1 week ago",
  },
  {
    id: "m3",
    kind: "document",
    title: "cuda-offload-notes.md",
    snippet: "n_gpu_layers 33 fits in 12 GB VRAM for a 32B Q4_K_M model at 8k context.",
    score: 0.81,
    at: "2 weeks ago",
  },
  {
    id: "m4",
    kind: "chat",
    title: "Personality tuning session",
    snippet: "Prefers short answers, no hedging, always states the risk before running exec tools.",
    score: 0.77,
    at: "2 weeks ago",
  },
];

export const logLines: LogLine[] = [
  {
    id: "l1",
    at: "09:41:02",
    level: "info",
    source: "bridge",
    message: "client connected · token ok",
  },
  {
    id: "l2",
    at: "09:41:03",
    level: "info",
    source: "router",
    message: "resolved role=brain -> llamacpp/qwen2.5-32b",
  },
  {
    id: "l3",
    at: "09:41:05",
    level: "debug",
    source: "memory",
    message: "vector search k=6 in 41ms",
  },
  {
    id: "l4",
    at: "09:41:09",
    level: "warn",
    source: "permission",
    message: "shell.cmd blocked, awaiting user approval",
  },
  { id: "l5", at: "09:41:14", level: "info", source: "planner", message: "step 3/5 complete" },
  {
    id: "l6",
    at: "09:38:51",
    level: "error",
    source: "runtime",
    message: "vllm endpoint unreachable at 127.0.0.1:8000",
  },
];
