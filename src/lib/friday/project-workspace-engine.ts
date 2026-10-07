/**
 * FRIDAY · project workspace engine
 *
 * One owner-facing Projects & Workspaces store. Desktop persists via
 * `electron/project-workspaces.cjs`. Tests and the browser preview keep an
 * in-memory copy of the same manifest — never a second OS, chat, brain,
 * Install Manager, or sandbox lab. Folders stays the FRIDAY_ROOT scan.
 */

import { library } from "./library-engine";
import { memory } from "./self/memory-engine";
import { actionMode } from "./brain/action-risk";
import {
  blankProject,
  defaultRuntimesFor,
  formatProjectWorkspaceExtra,
  isProjectKind,
  looksLikeProjectAsk,
  skipAutoAgentPlan,
  skipAutoMutation,
  sourceFromKnowledge,
  type AutoHandsOffDecision,
  type ProjectKind,
  type ProjectKnowledge,
  type ProjectSource,
  type ProjectWorkspace,
} from "./project-workspace-logic";

export type {
  ProjectKind,
  ProjectKnowledge,
  ProjectSource,
  ProjectWorkspace,
} from "./project-workspace-logic";
export {
  PROJECT_KINDS,
  PROJECT_RUNTIME_IDS,
  PROJECT_TABS,
  PROJECT_ISOLATION_IDS,
  defaultRuntimesFor,
  fingerprintFromFiles,
  formatProjectWorkspaceExtra,
  filterMemoriesForProject,
  isProjectTextPreview,
  looksLikeProjectAsk,
  skipAutoMutation,
  skipAutoAgentPlan,
  unsignedBinaryHonesty,
} from "./project-workspace-logic";

type ProjectBridge = {
  projectList?: () => Promise<{
    ok: boolean;
    items: ProjectWorkspace[];
    activeId?: string | null;
    dir?: string;
    error?: string;
  }>;
  projectSave?: (payload: Record<string, unknown>) => Promise<{
    ok: boolean;
    item?: ProjectWorkspace;
    activeId?: string | null;
    error?: string;
  }>;
  projectGet?: (id: string) => Promise<{ ok: boolean; item?: ProjectWorkspace; error?: string }>;
  projectSetActive?: (id: string | null) => Promise<{
    ok: boolean;
    activeId?: string | null;
    items?: ProjectWorkspace[];
    error?: string;
  }>;
  projectDuplicate?: (
    id: string,
  ) => Promise<{ ok: boolean; item?: ProjectWorkspace; error?: string }>;
  projectArchive?: (payload: {
    id: string;
    archived: boolean;
  }) => Promise<{ ok: boolean; item?: ProjectWorkspace; error?: string }>;
  projectDelete?: (id: string) => Promise<{ ok: boolean; error?: string }>;
  projectReveal?: (id: string) => Promise<boolean>;
  projectWriteFile?: (payload: {
    id: string;
    name: string;
    text: string;
    actor?: "owner" | "auto";
  }) => Promise<{ ok: boolean; item?: ProjectWorkspace; file?: string; error?: string }>;
  projectListFiles?: (id: string) => Promise<{ ok: boolean; files?: string[]; error?: string }>;
  projectReadFile?: (payload: {
    id: string;
    name: string;
  }) => Promise<{ ok: boolean; content?: string; size?: number; error?: string; name?: string }>;
  projectPickFolder?: () => Promise<string | null>;
};

function bridge(): ProjectBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return window.friday as unknown as ProjectBridge | undefined;
}

let seq = 0;
const nextId = () => `proj-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;
const nextChildId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(seq += 1).toString(36)}`;

class ProjectWorkspaceEngine {
  private items: ProjectWorkspace[] = [];
  private selectedId: string | null = null;
  private loaded = false;
  private dir = "";
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
  }

  resetForTests(): void {
    this.loaded = true;
    this.items = [];
    this.selectedId = null;
    this.dir = "";
    this.emit();
  }

  list(includeArchived = false): ProjectWorkspace[] {
    this.load();
    const rows = includeArchived ? [...this.items] : this.items.filter((item) => !item.archived);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  all(): ProjectWorkspace[] {
    this.load();
    return [...this.items];
  }

  get(id: string): ProjectWorkspace | undefined {
    this.load();
    return this.items.find((item) => item.id === id);
  }

  activeId(): string | null {
    this.load();
    return this.selectedId;
  }

  active(): ProjectWorkspace | undefined {
    this.load();
    return this.items.find((item) => item.id === this.selectedId && !item.archived);
  }

  dirPath(): string {
    return this.dir;
  }

  private upsert(record: ProjectWorkspace) {
    this.load();
    const idx = this.items.findIndex((item) => item.id === record.id);
    if (idx >= 0) this.items[idx] = record;
    else this.items.unshift(record);
    if (!this.selectedId) this.selectedId = record.id;
    this.emit();
  }

  async refreshFromDesktop(): Promise<ProjectWorkspace[]> {
    const api = bridge();
    if (!api?.projectList) return this.list(true);
    const listed = await api.projectList();
    if (listed?.ok && Array.isArray(listed.items)) {
      this.items = listed.items;
      this.selectedId = listed.activeId ?? this.selectedId;
      if (listed.dir) this.dir = listed.dir;
      this.loaded = true;
      this.emit();
    }
    return this.list(true);
  }

  create(input: { name: string; kind?: ProjectKind; rootPath?: string }): ProjectWorkspace {
    this.load();
    const kind = input.kind && isProjectKind(input.kind) ? input.kind : "mixed";
    const record = blankProject({
      id: nextId(),
      name: input.name,
      kind,
      ...(input.rootPath ? { rootPath: input.rootPath } : {}),
    });
    this.upsert(record);
    this.selectedId = record.id;
    const api = bridge();
    if (api?.projectSave)
      void api.projectSave(record).then((remote) => {
        if (remote?.ok && remote.item) this.upsert(remote.item);
      });
    return record;
  }

  save(
    patch: Partial<ProjectWorkspace> & { id: string; clearIsolation?: boolean },
  ): ProjectWorkspace | null {
    const current = this.get(patch.id);
    if (!current) return null;
    const clearIsolation = Boolean(patch.clearIsolation);
    const nextKind = patch.kind && isProjectKind(patch.kind) ? patch.kind : current.kind;
    const next: ProjectWorkspace = {
      ...current,
      ...patch,
      id: current.id,
      kind: nextKind,
      preferences: patch.preferences
        ? { ...current.preferences, ...patch.preferences }
        : current.preferences,
      knowledge: patch.knowledge ?? current.knowledge,
      sources: patch.sources ?? current.sources,
      runtime:
        patch.runtime ??
        (patch.kind && patch.kind !== current.kind
          ? defaultRuntimesFor(nextKind)
          : current.runtime),
      activity: patch.activity ? { ...current.activity, ...patch.activity } : current.activity,
      updatedAt: Date.now(),
    };
    delete (next as { clearIsolation?: boolean }).clearIsolation;
    if (clearIsolation) {
      delete next.isolation;
    }
    if (patch.handsOffAuto != null) {
      next.handsOffAuto = patch.handsOffAuto;
      next.preferences = { ...next.preferences, handsOffAuto: patch.handsOffAuto };
    }
    if (next.preferences.handsOffAuto) next.handsOffAuto = true;
    this.upsert(next);
    const api = bridge();
    if (api?.projectSave) {
      void api.projectSave({ ...next, isolation: next.isolation ?? null }).then((remote) => {
        if (remote?.ok && remote.item) this.upsert(remote.item);
      });
    }
    return next;
  }

  setActive(id: string | null): ProjectWorkspace | undefined {
    this.load();
    if (id && !this.get(id)) return undefined;
    this.selectedId = id;
    this.emit();
    const api = bridge();
    if (api?.projectSetActive) void api.projectSetActive(id);
    return id ? this.get(id) : undefined;
  }

  duplicate(id: string): ProjectWorkspace | null {
    const source = this.get(id);
    if (!source) return null;
    const copy = blankProject({
      id: nextId(),
      name: `${source.name} copy`,
      kind: source.kind,
    });
    copy.instructions = source.instructions;
    copy.preferences = { ...source.preferences };
    copy.knowledge = source.knowledge.map((row) => ({ ...row, id: nextChildId("know") }));
    copy.sources = source.sources.map((row) => ({ ...row, id: nextChildId("src") }));
    copy.runtime = [...source.runtime];
    if (source.isolation) copy.isolation = source.isolation;
    copy.handsOffAuto = source.handsOffAuto;
    this.upsert(copy);
    this.selectedId = copy.id;
    const api = bridge();
    if (api?.projectSave) void api.projectSave(copy);
    return copy;
  }

  archive(id: string, archived = true): ProjectWorkspace | null {
    const item = this.save({ id, archived });
    if (archived && this.selectedId === id) {
      const next = this.list().find((row) => row.id !== id);
      this.selectedId = next?.id ?? null;
      this.emit();
    }
    const api = bridge();
    if (api?.projectArchive) void api.projectArchive({ id, archived });
    return item;
  }

  remove(id: string): boolean {
    this.load();
    const item = this.get(id);
    if (!item) return false;
    this.items = this.items.filter((row) => row.id !== id);
    if (this.selectedId === id)
      this.selectedId = this.items.find((row) => !row.archived)?.id ?? null;
    this.emit();
    const api = bridge();
    if (api?.projectDelete) void api.projectDelete(id);
    return true;
  }

  addKnowledge(
    id: string,
    input: { title: string; text: string; useInChat?: boolean; pinned?: boolean },
  ): ProjectKnowledge | null {
    const item = this.get(id);
    if (!item) return null;
    const row: ProjectKnowledge = {
      id: nextChildId("know"),
      title: input.title.trim() || "Note",
      text: input.text,
      useInChat: input.useInChat !== false,
    };
    if (input.pinned) row.pinned = true;
    item.knowledge = [...item.knowledge, row];
    item.updatedAt = Date.now();
    this.upsert(item);
    if (row.useInChat && row.text.trim()) {
      memory.remember({
        tier: "semantic",
        kind: "project",
        title: `${item.name} · ${row.title}`,
        text: row.text,
        tags: ["project", "workspace", item.id],
        source: sourceFromKnowledge(item.id, row.id),
        confidence: 0.88,
        context: `project:${item.id}`,
        verified: true,
        scope: "project",
        projectId: item.id,
      });
    }
    this.save(item);
    return row;
  }

  addSource(
    id: string,
    input: {
      label: string;
      libraryId?: string;
      path?: string;
      url?: string;
      selected?: boolean;
      excerpt?: string;
    },
  ): ProjectSource | null {
    const item = this.get(id);
    if (!item) return null;
    let excerpt = input.excerpt;
    if (!excerpt && input.libraryId) {
      const lib = library.get(input.libraryId);
      if (lib?.text) excerpt = lib.text.slice(0, 1200);
    }
    const row: ProjectSource = {
      id: nextChildId("src"),
      label: input.label.trim() || input.path || input.url || input.libraryId || "Source",
      selected: input.selected !== false,
    };
    if (input.libraryId) row.libraryId = input.libraryId;
    if (input.path) row.path = input.path;
    if (input.url) row.url = input.url;
    if (excerpt) row.excerpt = excerpt;
    item.sources = [...item.sources, row];
    item.updatedAt = Date.now();
    this.upsert(item);
    this.save(item);
    return row;
  }

  refreshLibrarySources(id: string): ProjectWorkspace | null {
    const item = this.get(id);
    if (!item) return null;
    let changed = false;
    const sources = item.sources.map((row) => {
      if (!row.libraryId) return row;
      const lib = library.get(row.libraryId);
      if (!lib?.text) return row;
      const excerpt = lib.text.slice(0, 1200);
      if (excerpt === row.excerpt) return row;
      changed = true;
      return { ...row, excerpt };
    });
    if (!changed) return item;
    return this.save({ id, sources });
  }

  toggleSource(id: string, sourceId: string, selected: boolean): ProjectWorkspace | null {
    const item = this.get(id);
    if (!item) return null;
    item.sources = item.sources.map((row) => (row.id === sourceId ? { ...row, selected } : row));
    return this.save(item);
  }

  setHandsOff(id: string, handsOffAuto: boolean): ProjectWorkspace | null {
    return this.save({
      id,
      handsOffAuto,
      preferences: {
        ...(this.get(id)?.preferences ?? { language: "", stack: "", format: "", handsOffAuto }),
        handsOffAuto,
      },
    });
  }

  skipAutoWrite(input: {
    prompt?: string;
    paths?: string[];
    projectId?: string;
    risk?: "safe" | "write" | "exec";
    mode?: "manual" | "auto";
  }): AutoHandsOffDecision {
    return skipAutoMutation({
      mode: input.mode ?? actionMode(),
      items: this.all(),
      activeId: this.selectedId,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.paths ? { paths: input.paths } : {}),
      ...(input.risk ? { risk: input.risk } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
  }

  skipAutoPlan(plan: {
    folder?: string;
    candidates?: { path?: string; name?: string }[];
  }): AutoHandsOffDecision {
    return skipAutoAgentPlan({
      ...(plan.folder ? { folder: plan.folder } : {}),
      ...(plan.candidates ? { candidates: plan.candidates } : {}),
      items: this.all(),
    });
  }

  extraFor(id?: string | null, maxChars?: number): string {
    const project = (id && this.get(id)) || this.active();
    return formatProjectWorkspaceExtra(project, maxChars);
  }

  async writeFile(
    id: string,
    name: string,
    text: string,
    options: { actor?: "owner" | "auto" } = {},
  ): Promise<{ ok: boolean; file?: string; error?: string; item?: ProjectWorkspace }> {
    const mode = options.actor === "owner" ? "manual" : actionMode();
    const skip = this.skipAutoWrite({
      prompt: `write file ${name}`,
      paths: this.get(id)?.rootPath ? [this.get(id)!.rootPath] : [],
      projectId: id,
      risk: "write",
      mode,
    });
    if (skip.block) return { ok: false, error: skip.note };
    const item = this.get(id);
    if (!item) return { ok: false, error: "Project not found." };
    const file = name.replace(/[\\/]+/g, "_");
    item.activity = {
      ...item.activity,
      lastFiles: [file, ...item.activity.lastFiles].slice(0, 24),
      lastGenerate: file,
      updatedAt: Date.now(),
    };
    this.upsert(item);
    const api = bridge();
    if (api?.projectWriteFile) {
      const remote = await api.projectWriteFile({
        id,
        name,
        text,
        actor: options.actor === "owner" ? "owner" : "auto",
      });
      if (remote?.ok && remote.item) this.upsert(remote.item);
      if (!remote?.ok)
        return { ok: false, error: remote?.error || "Could not write that file.", item };
      return { ok: true, file: remote.file || file, item: remote.item ?? item };
    }
    return { ok: true, file, item };
  }

  async readFile(
    id: string,
    name: string,
  ): Promise<{ ok: boolean; content?: string; size?: number; error?: string; name?: string }> {
    const api = bridge();
    if (api?.projectReadFile) return api.projectReadFile({ id, name });
    return { ok: false, error: "File preview is desktop-only — same honesty as Sandbox." };
  }

  async listFiles(id: string): Promise<string[]> {
    const api = bridge();
    if (api?.projectListFiles) {
      const remote = await api.projectListFiles(id);
      return remote.files ?? [];
    }
    return this.get(id)?.activity.lastFiles ?? [];
  }
}

export const projectWorkspaces = new ProjectWorkspaceEngine();

const CREATE_FILE =
  /(?:^|:\s*)(?:please\s+)?(?:create|write|banao|bana do|generate)\s+(?:a |an |ek )?(?:file )?(?:named |called |naam )?(?:[`"'“”]?)([^`"'“”\s]+\.(?:md|txt|csv|json|html))(?:[`"'“”]?)\s*(?:with|containing|jisme|:)\s+([\s\S]+)/i;

export function handleProjectWorkspaceChat(prompt: string): { text: string } | null {
  const text = String(prompt || "").trim();
  if (!text) return null;
  const active = projectWorkspaces.active();
  if (!active) return null;
  const bound =
    looksLikeProjectAsk(text, projectWorkspaces.list()) ||
    /\bPROJECT WORKSPACE SESSION\b/.test(text);
  if (!bound) return null;
  const create = text.match(CREATE_FILE);
  if (create?.[1] && create[2]) {
    const fileName = create[1].trim();
    const body = create[2].trim();
    const skip = projectWorkspaces.skipAutoWrite({
      prompt: text,
      paths: active.rootPath ? [active.rootPath] : [],
      projectId: active.id,
      risk: "write",
      mode: "manual",
    });
    if (skip.block) return { text: skip.note };
    void projectWorkspaces.writeFile(active.id, fileName, body, { actor: "owner" });
    return {
      text: `Wrote ${fileName} inside project "${active.name}". Open the Files tab here — I did not send it to an external IDE.`,
    };
  }
  return null;
}
