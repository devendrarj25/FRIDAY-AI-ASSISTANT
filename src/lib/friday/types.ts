export type ProviderKind = "ollama" | "llamacpp" | "lmstudio" | "vllm" | "online";

export type ModelEntry = {
  id: string;
  label: string;
  provider: ProviderKind;
  endpoint: string;
  params: string;
  status: "ready" | "loading" | "offline";
  role: "brain" | "coder" | "researcher" | "fast" | "embed";
  contextK: number;
};

export type ChatTurn = {
  id: string;
  role: "user" | "assistant";
  modelId?: string;
  text: string;
  reasoning?: string;
  at: string;
};

export type RiskLevel = "safe" | "write" | "exec";

export type ToolDef = {
  name: string;
  summary: string;
  risk: RiskLevel;
  enabled: boolean;
};

export type TaskStep = {
  id: string;
  title: string;
  tool?: string;
  state: "pending" | "running" | "done" | "blocked" | "failed";
  detail?: string;
};

export type Task = {
  id: string;
  goal: string;
  state: "queued" | "running" | "awaiting-approval" | "done" | "failed";
  createdAt: string;
  model: string;
  steps: TaskStep[];
};

export type RuntimeEntry = {
  name: string;
  installed: string | null;
  latest: string;
  source: string;
  size: string;
  kind: "runtime" | "engine" | "tool";
};

export type ModuleEntry = {
  name: string;
  version: string;
  description: string;
  permissions: string[];
  enabled: boolean;
  entry: string;
};

export type MemoryRecord = {
  id: string;
  kind: "lesson" | "document" | "task" | "chat";
  title: string;
  snippet: string;
  score: number;
  at: string;
};

export type LogLine = {
  id: string;
  at: string;
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
};

export type KernelStatus = {
  connected: boolean;
  host: string;
  version: string;
  uptime: string;
  gpu: string;
  vramUsedGb: number;
  vramTotalGb: number;
  dataDir: string;
};
