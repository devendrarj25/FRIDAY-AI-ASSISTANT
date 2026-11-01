/**
 * FRIDAY brain catalog — identity, agents, memory layers, intent rules,
 * workspace tree and update targets.
 *
 * Pure data + pure helpers. All runtime state lives in brain-engine.ts.
 */

import type { RoutingTask } from "./model-catalog";

/* ---------------------------------------------------------------- identity */

export const identity = {
  name: "FRIDAY",
  role: "Personal AI Assistant",
  owner: "Devendra Singh Meena",
  handle: "devendrarj25",
  voice: "Professional, calm, friendly female tone",
  traits: [
    "Helpful",
    "Intelligent",
    "Organized",
    "Technical",
    "Honest",
    "Creative",
    "Explains decisions clearly",
    "Adapts to the user's working style",
    "Never acts without confirmation on important changes",
  ],
  charter:
    "FRIDAY is not a language model. She keeps her own identity, memory, reasoning layer, workflows and personality while orchestrating local and cloud models through official APIs and supported runtimes.",
} as const;

/* ------------------------------------------------------------------ agents */

export type AgentId =
  | "developer"
  | "research"
  | "coding"
  | "automation"
  | "vision"
  | "voice"
  | "security"
  | "learning"
  | "workflow"
  | "monitor"
  | "installer"
  | "update";

export type AgentSpec = {
  id: AgentId;
  name: string;
  duty: string;
  task: RoutingTask;
  tools: string[];
  risk: "safe" | "write" | "exec";
};

export const agentSpecs: AgentSpec[] = [
  {
    id: "developer",
    name: "Developer Agent",
    duty: "Project structure, architecture calls, repo hygiene",
    task: "reasoning",
    tools: ["fs.read", "git.status"],
    risk: "safe",
  },
  {
    id: "coding",
    name: "Coding Agent",
    duty: "Write, refactor and review code",
    task: "coding",
    tools: ["fs.read", "fs.write", "shell.run"],
    risk: "write",
  },
  {
    id: "research",
    name: "Research Agent",
    duty: "Read long sources and synthesise findings",
    task: "research",
    tools: ["http.get", "memory.search"],
    risk: "safe",
  },
  {
    id: "automation",
    name: "Automation Agent",
    duty: "Chain tools into repeatable jobs",
    task: "fast",
    tools: ["workflow.run", "shell.run"],
    risk: "exec",
  },
  {
    id: "vision",
    name: "Vision Agent",
    duty: "Screenshots, documents, diagrams, OCR",
    task: "vision",
    tools: ["vision.describe", "fs.read"],
    risk: "safe",
  },
  {
    id: "voice",
    name: "Voice Agent",
    duty: "Speech in, spoken answers out",
    task: "voice",
    tools: ["stt.transcribe", "tts.speak"],
    risk: "safe",
  },
  {
    id: "security",
    name: "Security Agent",
    duty: "Permission gates, secret hygiene, risk review",
    task: "reasoning",
    tools: ["policy.check"],
    risk: "safe",
  },
  {
    id: "learning",
    name: "Learning Agent",
    duty: "Write lessons and preferences into memory",
    task: "embedding",
    tools: ["memory.write"],
    risk: "safe",
  },
  {
    id: "workflow",
    name: "Workflow Agent",
    duty: "Plan multi-step work and schedule it",
    task: "reasoning",
    tools: ["workflow.plan", "scheduler.add"],
    risk: "safe",
  },
  {
    id: "monitor",
    name: "Monitor Agent",
    duty: "Watch CPU, GPU, VRAM, disk and job health",
    task: "fast",
    tools: ["system.probe"],
    risk: "safe",
  },
  {
    id: "installer",
    name: "Installer Agent",
    duty: "Install runtimes, engines and models from official sources",
    task: "fast",
    tools: ["installer.run"],
    risk: "exec",
  },
  {
    id: "update",
    name: "Update Agent",
    duty: "Check app, plugins, modules, agents and providers",
    task: "fast",
    tools: ["update.check"],
    risk: "safe",
  },
];

export const agentById = new Map(agentSpecs.map((a) => [a.id, a]));

/* ------------------------------------------------------------------ intent */

export type IntentId =
  | "coding"
  | "research"
  | "reasoning"
  | "vision"
  | "voice"
  | "automation"
  | "system"
  | "memory"
  | "install"
  | "chat";

export type IntentRule = {
  id: IntentId;
  label: string;
  keywords: string[];
  agents: AgentId[];
  tasks: RoutingTask[];
};

export const intentRules: IntentRule[] = [
  {
    id: "coding",
    label: "Coding",
    keywords: [
      "code",
      "bug",
      "refactor",
      "function",
      "typescript",
      "python",
      "compile",
      "test",
      "repo",
      "git",
      "build",
    ],
    agents: ["coding", "developer", "security"],
    tasks: ["coding", "reasoning"],
  },
  {
    id: "research",
    label: "Research",
    keywords: [
      "research",
      "find",
      "compare",
      "source",
      "docs",
      "explain",
      "summarise",
      "summarize",
      "read",
    ],
    agents: ["research", "learning"],
    tasks: ["research", "embedding"],
  },
  {
    id: "reasoning",
    label: "Reasoning",
    keywords: [
      "plan",
      "design",
      "architecture",
      "strategy",
      "decide",
      "why",
      "trade-off",
      "tradeoff",
    ],
    agents: ["workflow", "developer"],
    tasks: ["reasoning", "brain"],
  },
  {
    id: "vision",
    label: "Vision",
    keywords: ["screenshot", "image", "picture", "diagram", "ocr", "scan", "photo"],
    agents: ["vision"],
    tasks: ["vision"],
  },
  {
    id: "voice",
    label: "Voice",
    keywords: ["speak", "say", "voice", "audio", "listen", "transcribe", "dictate"],
    agents: ["voice"],
    tasks: ["voice", "speech"],
  },
  {
    id: "automation",
    label: "Automation",
    keywords: ["automate", "workflow", "schedule", "every day", "cron", "pipeline", "batch"],
    agents: ["automation", "workflow", "security"],
    tasks: ["fast", "reasoning"],
  },
  {
    id: "system",
    label: "System",
    keywords: [
      "cpu",
      "gpu",
      "vram",
      "ram",
      "disk",
      "status",
      "temperature",
      "monitor",
      "performance",
    ],
    agents: ["monitor"],
    tasks: ["fast"],
  },
  {
    id: "memory",
    label: "Memory",
    keywords: ["remember", "forget", "note", "preference", "recall", "knowledge"],
    agents: ["learning"],
    tasks: ["embedding"],
  },
  {
    id: "install",
    label: "Install / update",
    keywords: ["install", "download", "update", "upgrade", "runtime", "driver", "model"],
    agents: ["installer", "update", "security"],
    tasks: ["fast"],
  },
  { id: "chat", label: "Conversation", keywords: [], agents: ["developer"], tasks: ["brain"] },
];

const keywordCache = new Map<string, RegExp>();

/**
 * A keyword counts when the word starts there: "plan" is in "planning" but not in "airplane", and "ram" is not in
 * "program". Long keywords may carry a short ending ("install" in "installing"); short ones ("ram", "say", "why")
 * must be the whole word. Letters from any script count as letters, so Devanagari is not cut in the middle.
 */
function keywordRegExp(keyword: string): RegExp {
  let rx = keywordCache.get(keyword);
  if (!rx) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    const ending = keyword.length >= 4 ? "[\\p{L}]{0,4}" : "";
    rx = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${ending}(?![\\p{L}\\p{N}])`, "iu");
    keywordCache.set(keyword, rx);
  }
  return rx;
}

export function analyseIntent(text: string): {
  rule: IntentRule;
  score: number;
  matched: string[];
  /** The next-best rule, when one matched at all. */
  runnerUp: IntentRule | null;
  /** Matches for the best rule minus matches for the runner-up: 0 means the words do not decide between them. */
  margin: number;
  /** No keyword matched anywhere: the catalog has no opinion, and "chat" is only the default. */
  novel: boolean;
} {
  const value = String(text || "");
  const scored = intentRules
    .filter((rule) => rule.keywords.length > 0)
    .map((rule) => ({ rule, matched: rule.keywords.filter((k) => keywordRegExp(k).test(value)) }))
    .filter((row) => row.matched.length > 0)
    .sort((a, b) => b.matched.length - a.matched.length);
  const fallback = intentRules[intentRules.length - 1]!;
  const top = scored[0];
  const next = scored[1];
  const best = top?.rule ?? fallback;
  const bestMatches = top?.matched ?? [];
  const score = Math.min(0.98, 0.55 + bestMatches.length * 0.12);
  return {
    rule: best,
    score: Number(score.toFixed(2)),
    matched: bestMatches,
    runnerUp: next?.rule ?? null,
    margin: bestMatches.length - (next?.matched.length ?? 0),
    novel: bestMatches.length === 0,
  };
}

/* ------------------------------------------------------------ memory model */

export type MemoryLayer = "conversation" | "long-term" | "project" | "knowledge";

export const memoryLayers: { id: MemoryLayer; label: string; note: string }[] = [
  {
    id: "conversation",
    label: "Conversation memory",
    note: "The current session, trimmed to the active context window",
  },
  {
    id: "long-term",
    label: "Long-term memory",
    note: "Preferences, habits, lessons FRIDAY wrote after a failure",
  },
  {
    id: "project",
    label: "Project memory",
    note: "Per-repository facts, conventions and open threads",
  },
  {
    id: "knowledge",
    label: "Knowledge base",
    note: "Approved documents and notes, embedded for recall",
  },
];

/* --------------------------------------------------------------- pipeline */

export type StageId =
  | "intent"
  | "agents"
  | "models"
  | "memory"
  | "execute"
  | "collect"
  | "reason"
  | "respond"
  | "persist";

export const pipelineStages: { id: StageId; label: string; note: string }[] = [
  { id: "intent", label: "Intent analysis", note: "Classify the request and its risk" },
  { id: "agents", label: "Select agents", note: "Activate the specialists this request needs" },
  { id: "models", label: "Select models", note: "Route each task to its best model" },
  {
    id: "memory",
    label: "Load memory",
    note: "Recall conversation, project and knowledge context",
  },
  { id: "execute", label: "Execute tools", note: "Run tools and workflows, gated by permission" },
  { id: "collect", label: "Collect results", note: "Merge every agent's output" },
  { id: "reason", label: "Reason & validate", note: "Check the merged answer for contradictions" },
  { id: "respond", label: "Generate response", note: "Compose FRIDAY's own voice" },
  { id: "persist", label: "Save memory", note: "Write what is worth keeping" },
];

/* -------------------------------------------------------------- workspace */

export const workspaceTree = [
  { name: "Core", note: "Kernel, bridge, identity" },
  { name: "Memory", note: "SQLite + vector store" },
  { name: "Knowledge", note: "Approved documents" },
  { name: "Projects", note: "Per-repo project memory" },
  { name: "Plugins", note: "Installed plugins" },
  { name: "Modules", note: "Manifest modules" },
  { name: "Agents", note: "Agent definitions and logs" },
  { name: "Workflows", note: "Saved automations" },
  { name: "Logs", note: "Rotating run logs" },
  { name: "Cache", note: "Transient artefacts" },
  { name: "Backups", note: "Snapshots before risky changes" },
  { name: "Settings", note: "kernel.yaml, models.yaml" },
  { name: "Temp", note: "Scratch space" },
  { name: "Testing", note: "Test harnesses" },
  { name: "Experimental", note: "Unstable features" },
  { name: "Assets", note: "Images, audio, voices" },
  { name: "Downloads", note: "Model and runtime downloads" },
] as const;

/* ----------------------------------------------------------- update flow */

export type UpdateTarget = {
  id: string;
  label: string;
  channel: string;
};

export const updateTargets: UpdateTarget[] = [
  { id: "app", label: "FRIDAY application", channel: "github releases" },
  { id: "plugins", label: "Plugins", channel: "plugin registry" },
  { id: "modules", label: "Modules", channel: "manifest index" },
  { id: "agents", label: "Agents", channel: "bundled definitions" },
  { id: "providers", label: "AI providers", channel: "official provider APIs" },
  { id: "tools", label: "Developer tools", channel: "winget / vendor" },
  { id: "workflows", label: "Workflows", channel: "workspace" },
];

/* ------------------------------------------------------- self improvement */

export type SuggestionKind =
  | "prompt"
  | "workflow"
  | "plugin"
  | "module"
  | "automation"
  | "model"
  | "routing"
  | "performance"
  | "memory"
  | "docs";

export const suggestionSeeds: {
  kind: SuggestionKind;
  title: string;
  rationale: string;
  impact: "low" | "medium" | "high";
}[] = [
  {
    kind: "routing",
    title: "Send short replies to the fast model",
    rationale:
      "The last runs used the 32B brain for one-line answers — the fast model returns them ~6× quicker at the same quality.",
    impact: "medium",
  },
  {
    kind: "prompt",
    title: "Add the user's code style to the coding system prompt",
    rationale:
      "Three recent code answers needed a style correction; folding the rule into the prompt removes the round-trip.",
    impact: "high",
  },
  {
    kind: "workflow",
    title: "Nightly project memory compaction",
    rationale: "Project memory grew past the recall budget; compacting keeps recall precise.",
    impact: "medium",
  },
  {
    kind: "performance",
    title: "Keep the embedding model resident",
    rationale:
      "It was loaded and unloaded 11 times today; keeping it resident costs 1.2 GB VRAM and saves the reload each time.",
    impact: "medium",
  },
  {
    kind: "memory",
    title: "Drop stale cache entries older than 30 days",
    rationale: "Cache holds entries no run has touched in a month.",
    impact: "low",
  },
  {
    kind: "automation",
    title: "Auto-benchmark models after install",
    rationale: "Routing decisions are better when every installed model has a fresh benchmark.",
    impact: "medium",
  },
  {
    kind: "docs",
    title: "Document the approval policy in the workspace",
    rationale: "New modules keep requesting exec without explaining why.",
    impact: "low",
  },
];
