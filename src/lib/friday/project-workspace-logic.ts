/**
 * FRIDAY · project workspace logic (pure)
 *
 * One owner-facing project/workspace schema. Disk and IPC live in
 * `electron/project-workspaces.cjs` / `project-workspace-engine.ts`. Chat and
 * Auto Mode read the same extra. This is not a second OS, chat, brain,
 * Install Manager, sandbox lab, or Folders page.
 */

export const PROJECT_PROMPT_CHARS = 8_000;
export const PROJECT_SOURCE_EXCERPT = 1_200;
export const PROJECT_KNOWLEDGE_EXCERPT = 800;

export const PROJECT_KINDS = [
  "website",
  "node",
  "python",
  "windows-exe",
  "android-apk",
  "documents",
  "mixed",
  "other",
] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_TABS = [
  "overview",
  "instructions",
  "knowledge",
  "preferences",
  "sources",
  "files",
  "chat",
  "preview",
  "runs",
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

/** Isolation ids from electron/sandbox-engines.cjs — stored, not a second sandbox. */
export const PROJECT_ISOLATION_IDS = [
  "process",
  "venv",
  "deno",
  "docker",
  "podman",
  "wsl",
  "sandboxie",
  "windows-sandbox",
  "firejail",
  "bwrap",
  "qemu",
] as const;

export type ProjectIsolationId = (typeof PROJECT_ISOLATION_IDS)[number];

/** Install Manager / toolchain.cjs ids this section may request. */
export const PROJECT_RUNTIME_IDS = [
  "Git",
  "Node.js LTS",
  "npm",
  "Python",
  "OpenJDK (Temurin)",
  "Gradle",
  "Android Platform Tools (adb)",
  "Android SDK cmdline-tools",
  "FFmpeg",
  "SQLite",
] as const;

export type ProjectSource = {
  id: string;
  label: string;
  selected: boolean;
  libraryId?: string;
  path?: string;
  url?: string;
  excerpt?: string;
};

export type ProjectKnowledge = {
  id: string;
  title: string;
  text: string;
  useInChat: boolean;
  pinned?: boolean;
};

export type ProjectPreferences = {
  language: string;
  stack: string;
  format: string;
  handsOffAuto: boolean;
  modelHint?: string;
};

export type ProjectActivity = {
  lastFiles: string[];
  lastPreviewUrl?: string;
  lastRunLog?: string;
  lastGenerate?: string;
  updatedAt: number;
};

export type ProjectWorkspace = {
  id: string;
  name: string;
  kind: ProjectKind;
  rootPath: string;
  instructions: string;
  preferences: ProjectPreferences;
  knowledge: ProjectKnowledge[];
  sources: ProjectSource[];
  runtime: string[];
  isolation?: ProjectIsolationId;
  handsOffAuto: boolean;
  archived: boolean;
  activity: ProjectActivity;
  createdAt: number;
  updatedAt: number;
};

export type ProjectIndex = {
  version: 1;
  activeId: string | null;
  items: ProjectWorkspace[];
};

export function isProjectKind(value: string): value is ProjectKind {
  return (PROJECT_KINDS as readonly string[]).includes(value);
}

export function defaultRuntimesFor(kind: ProjectKind): string[] {
  switch (kind) {
    case "website":
      return ["Node.js LTS", "Git"];
    case "node":
      return ["Node.js LTS", "npm", "Git"];
    case "python":
      return ["Python", "Git"];
    case "windows-exe":
      return ["Node.js LTS", "Git"];
    case "android-apk":
      return [
        "OpenJDK (Temurin)",
        "Gradle",
        "Android Platform Tools (adb)",
        "Android SDK cmdline-tools",
      ];
    case "documents":
      return ["Git"];
    case "mixed":
      return ["Git", "Node.js LTS", "Python"];
    default:
      return ["Git"];
  }
}

export function defaultPreferences(handsOffAuto = false): ProjectPreferences {
  return {
    language: "",
    stack: "",
    format: "",
    handsOffAuto,
  };
}

export function emptyActivity(at = Date.now()): ProjectActivity {
  return { lastFiles: [], updatedAt: at };
}

export function normalizePath(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function pathUnder(root: string, candidate: string): boolean {
  const base = normalizePath(root);
  const target = normalizePath(candidate);
  if (!base || !target) return false;
  return target === base || target.startsWith(`${base}/`);
}

export function isProtectedRoot(rootPath: string, fridayRoot: string): boolean {
  const root = normalizePath(fridayRoot);
  const target = normalizePath(rootPath);
  if (!root || !target) return false;
  if (target === root) return true;
  const protectedNames = [
    "config",
    "security",
    "memory",
    "conversations",
    "brain-data",
    "database",
    "models",
    "voices",
    "runtime",
    "agents",
    "skills",
    "plugins",
    "modules",
    "workflows",
    "library",
  ];
  return protectedNames.some(
    (name) => target === `${root}/${name}` || target.startsWith(`${root}/${name}/`),
  );
}

export function handsOffProjects(items: ProjectWorkspace[]): ProjectWorkspace[] {
  return items.filter(
    (item) => !item.archived && (item.handsOffAuto || item.preferences.handsOffAuto),
  );
}

export function handsOffHit(
  items: ProjectWorkspace[],
  paths: string[],
): ProjectWorkspace | undefined {
  const locked = handsOffProjects(items);
  for (const candidate of paths) {
    const hit = locked.find(
      (item) => pathUnder(item.rootPath, candidate) || pathUnder(candidate, item.rootPath),
    );
    if (hit) return hit;
  }
  return undefined;
}

const WRITE_LOOK =
  /\b(delete|remove|erase|wipe|overwrite|rename|move|copy|write|save file|create file|edit file|generate|build|rebuild|deploy|install|run|execute|launch|forge|import into|npm install|pip install|gradle|apk|exe)\b/i;

export function looksLikeProjectMutation(prompt: string): boolean {
  return WRITE_LOOK.test(String(prompt || ""));
}

export function looksLikeProjectAsk(prompt: string, items: ProjectWorkspace[] = []): boolean {
  const text = String(prompt || "").trim();
  if (!text) return false;
  if (
    /\b(projects? & workspaces|project workspace|use project|@project|this project|active project|hands-?off auto|labour app|PROJECT WORKSPACE SESSION)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\bproject\s+\S+/i.test(text)) return true;
  return items.some((item) => {
    const name = item.name.trim();
    if (name.length < 4) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      new RegExp(`(?:^|[\\s:])${escaped}(?:\\b|[\\s:])`, "i").test(text) &&
      /\bproject\b/i.test(text)
    );
  });
}

export type AutoHandsOffDecision = {
  block: boolean;
  note: string;
  projectId?: string;
};

export function skipAutoMutation(input: {
  mode: "manual" | "auto";
  prompt?: string;
  paths?: string[];
  projectId?: string;
  items: ProjectWorkspace[];
  activeId?: string | null;
  risk?: "safe" | "write" | "exec";
}): AutoHandsOffDecision {
  if (input.mode !== "auto") return { block: false, note: "" };
  const prompt = String(input.prompt || "");
  const paths = [...(input.paths ?? [])];
  for (const item of input.items) {
    if (item.name && prompt.toLowerCase().includes(item.name.toLowerCase()) && item.rootPath) {
      paths.push(item.rootPath);
    }
  }
  let hit = handsOffHit(input.items, paths);
  if (!hit && input.projectId) {
    hit = handsOffProjects(input.items).find((item) => item.id === input.projectId);
  }
  if (!hit) return { block: false, note: "" };
  const mutating =
    input.risk === "write" ||
    input.risk === "exec" ||
    looksLikeProjectMutation(prompt) ||
    (input.paths ?? []).length > 0;
  if (!mutating) return { block: false, note: "" };
  return {
    block: true,
    projectId: hit.id,
    note: `Auto Mode hands-off: I will not write, exec, forge, or import into project "${hit.name}" (${hit.rootPath}) until you turn hands-off off or instruct me in Manual Chat.`,
  };
}

export function skipAutoAgentPlan(input: {
  folder?: string;
  candidates?: { path?: string; name?: string }[];
  items: ProjectWorkspace[];
}): AutoHandsOffDecision {
  const paths: string[] = [];
  if (input.folder) paths.push(input.folder);
  for (const row of input.candidates ?? []) {
    if (row.path) paths.push(row.path);
  }
  const hit = handsOffHit(input.items, paths);
  if (!hit) return { block: false, note: "" };
  return {
    block: true,
    projectId: hit.id,
    note: `Skipped Auto/background agent against hands-off project "${hit.name}".`,
  };
}

export function selectedSources(project: ProjectWorkspace): ProjectSource[] {
  return project.sources.filter((row) => row.selected);
}

export function chatKnowledge(project: ProjectWorkspace): ProjectKnowledge[] {
  return project.knowledge.filter((row) => row.useInChat);
}

export function formatProjectWorkspaceExtra(
  project: ProjectWorkspace | null | undefined,
  maxChars = PROJECT_PROMPT_CHARS,
): string {
  if (!project || project.archived) return "";
  const knowledge = chatKnowledge(project)
    .map((row) => `- ${row.title}: ${row.text.slice(0, PROJECT_KNOWLEDGE_EXCERPT)}`)
    .join("\n");
  const sources = selectedSources(project)
    .map((row) => {
      const where = row.libraryId
        ? `library:${row.libraryId}`
        : row.path
          ? row.path
          : row.url
            ? row.url
            : "";
      const excerpt = row.excerpt ? `\n  ${row.excerpt.slice(0, PROJECT_SOURCE_EXCERPT)}` : "";
      return `- ${row.label} ${where}${excerpt}`;
    })
    .join("\n");
  const body = [
    "PROJECT WORKSPACE SESSION (owner work under this project's folder — not Folders scan, not Sandbox lab, not Import & Build)",
    `id: ${project.id}`,
    `name: ${project.name}`,
    `kind: ${project.kind}`,
    `root: ${project.rootPath || "(unset)"}`,
    `handsOffAuto: ${project.handsOffAuto || project.preferences.handsOffAuto ? "true — Auto/background must not write/exec/forge/import here; Manual Chat in this section still works" : "false"}`,
    `language: ${project.preferences.language || "unset"}`,
    `stack: ${project.preferences.stack || "unset"}`,
    `format: ${project.preferences.format || "unset"}`,
    project.preferences.modelHint ? `modelHint: ${project.preferences.modelHint}` : "",
    `runtime: ${project.runtime.join(", ") || "none listed"}`,
    project.isolation
      ? `isolation: ${project.isolation} (existing sandbox engine id)`
      : "isolation: none",
    "instructions:",
    project.instructions.trim() || "(none saved)",
    "knowledge (use in chat):",
    knowledge || "(none)",
    "sources (selected):",
    sources || "(none selected)",
    "Write/edit files only inside this root when the owner asks. Do not leak other projects' knowledge. Do not pretend APK/EXE/emulators that the toolchain cannot run.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n…[truncated; full instructions/knowledge stay on the project]`;
}

export function extraLeaksOtherProject(extra: string, other: ProjectWorkspace): boolean {
  const text = String(extra || "");
  if (!text) return false;
  if (other.id && text.includes(`id: ${other.id}`)) return true;
  for (const row of other.knowledge) {
    if (row.text.trim() && text.includes(row.text.trim())) return true;
  }
  return false;
}

export function filterMemoriesForProject<T extends { projectId?: string }>(
  hits: T[],
  activeProjectId: string | null | undefined,
): T[] {
  if (!activeProjectId) {
    return hits.filter((hit) => !hit.projectId);
  }
  return hits.filter((hit) => !hit.projectId || hit.projectId === activeProjectId);
}

export function sourceFromKnowledge(projectId: string, knowledgeId: string): string {
  return `project:${projectId}:knowledge:${knowledgeId}`;
}

/** Same fingerprints the kernel runner uses — listing-only, not a second scanner. */
export const PROJECT_FINGERPRINTS = [
  { file: "package.json", language: "JavaScript/TypeScript", runtimeHint: "Node.js LTS" },
  { file: "requirements.txt", language: "Python", runtimeHint: "Python" },
  { file: "pyproject.toml", language: "Python", runtimeHint: "Python" },
  { file: "pom.xml", language: "Java", runtimeHint: "OpenJDK (Temurin)" },
  { file: "build.gradle", language: "Java", runtimeHint: "Gradle" },
  { file: "go.mod", language: "Go", runtimeHint: "Git" },
  { file: "Cargo.toml", language: "Rust", runtimeHint: "Git" },
  { file: "composer.json", language: "PHP", runtimeHint: "Git" },
  { file: "Gemfile", language: "Ruby", runtimeHint: "Git" },
  { file: "Makefile", language: "C/C++", runtimeHint: "Git" },
] as const;

export function fingerprintFromFiles(
  files: string[],
): { file: string; language: string; runtimeHint: string } | null {
  const lower = files.map((row) => row.replace(/\\/g, "/").toLowerCase());
  for (const row of PROJECT_FINGERPRINTS) {
    const target = row.file.toLowerCase();
    if (lower.some((name) => name === target || name.endsWith(`/${target}`))) return { ...row };
  }
  return null;
}

export function isProjectTextPreview(name: string): boolean {
  return /\.(md|txt|json|jsonc|html?|xml|csv|tsv|css|js|mjs|cjs|ts|tsx|py|yml|yaml|toml|ini|log)$/i.test(
    String(name || ""),
  );
}

export function unsignedBinaryHonesty(kind: ProjectKind): string {
  if (kind === "android-apk") {
    return "No APK emulator. Missing SDK → Install Manager. I will not pretend an emulator exists.";
  }
  if (kind === "windows-exe") {
    return "I will not auto-exec an unsigned EXE. Build/run stays Terminal after you ask in Manual.";
  }
  return "";
}

export function blankProject(input: {
  id: string;
  name: string;
  kind?: ProjectKind;
  rootPath?: string;
  now?: number;
}): ProjectWorkspace {
  const now = input.now ?? Date.now();
  const kind = input.kind && isProjectKind(input.kind) ? input.kind : "mixed";
  return {
    id: input.id,
    name: input.name.trim() || "Untitled project",
    kind,
    rootPath: input.rootPath || "",
    instructions: "",
    preferences: defaultPreferences(false),
    knowledge: [],
    sources: [],
    runtime: defaultRuntimesFor(kind),
    handsOffAuto: false,
    archived: false,
    activity: emptyActivity(now),
    createdAt: now,
    updatedAt: now,
  };
}
