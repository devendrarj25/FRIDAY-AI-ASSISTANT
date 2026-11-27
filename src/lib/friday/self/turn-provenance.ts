/**
 * FRIDAY · turn provenance
 *
 * Who wrote the prompt of a turn and what untrusted content entered its context, noted while the turn runs and
 * handed to the task ledger when it finishes. The ledger row is the only thing fine-tuning may read, so the rule
 * is strict: "owner" only for text the owner typed in the chat box or spoke into his own microphone this turn, and
 * every kind of outside content (web, screen, MCP, file, tool, app-supplied extra) is recorded the moment it enters.
 * A turn that nobody tagged stays "unknown" and is never trained on.
 */

import { experiences, type ExperienceModel, type PromptAuthor } from "./task-ledger";

/** Where the prompt text came from. Only these two count as the owner's own words. */
export type PromptOrigin = "typed" | "owner-voice";

/**
 * What may sit in a model context besides the owner's prompt. "extra" is app-supplied text of unknown source;
 * "memory" is a recalled record the owner did not write and whose source names no better kind.
 */
export type ContextKind = "web" | "screen" | "mcp" | "file" | "tool" | "extra" | "memory";

/** Which side of the PC answered. Only "local" may train by default; "unknown" is never guessed. */
export type ModelKind = ExperienceModel["kind"];

/** One row of the router's live model list, as far as the kind of an answer needs it. */
export type RoutedModel = {
  id: string;
  registryId?: string;
  providerModelId?: string;
  /** The router's own kind for the row ("local" or "cloud"). Anything else is unknown. */
  kind?: string;
  endpoint?: string;
};

const MAX_TURNS = 200;

/** "owner" only for a known owner origin; anything else (missing, misspelt, a tool name) is "unknown". */
export function promptAuthorOf(origin: unknown): PromptAuthor {
  return origin === "typed" || origin === "owner-voice" ? "owner" : "unknown";
}

/**
 * The send option of a spoken turn. The owner's microphone path alone qualifies: a speaker the ear tagged "owner".
 * Another voice, an unknown voice, a TV and a missing tag all return nothing, so the turn stays "unknown".
 */
export function ownerVoiceOrigin(speaker: unknown): { promptOrigin?: "owner-voice" } {
  return speaker === "owner" ? { promptOrigin: "owner-voice" } : {};
}

/**
 * A task FRIDAY started on her own (repair, upgrade, growth, maintenance): its title and detail come from diagnostics
 * and tool output, never from the owner's words. Written to the ledger as a tool turn, so it can never train.
 */
export function systemTurnProvenance(): { promptAuthor: "tool"; contextKinds: string[] } {
  return { promptAuthor: "tool", contextKinds: ["tool"] };
}

/** The kind of content a chat tool brings into the context, read from its name. Unknown names are plain tools. */
export function kindOfTool(name: unknown): ContextKind {
  const raw = typeof name === "string" ? name.toLowerCase() : "";
  if (/mcp|connector/.test(raw)) return "mcp";
  if (/web|search|browse|fetch|http|url|news|weather/.test(raw)) return "web";
  if (/screen|ocr|capture|screenshot|window|desktop|click/.test(raw)) return "screen";
  if (/file|folder|document|attachment|library|read_|read\./.test(raw)) return "file";
  return "tool";
}

/** The kinds a finished cognition brought in: every tool it ran and any web source it cited. */
export function kindsOfCognition(cognition: {
  tools?: readonly { tool: string }[];
  sources?: readonly unknown[];
}): ContextKind[] {
  const kinds = new Set<ContextKind>();
  for (const use of cognition.tools ?? []) {
    kinds.add(use.tool === "web-search" ? "web" : use.tool === "connector" ? "mcp" : "tool");
  }
  if (cognition.sources?.length) kinds.add("web");
  return [...kinds];
}

/**
 * Loopback host test, the renderer's half of the one locality rule (electron/model-access.cjs `isLocalEndpoint`).
 * The owner-set LAN host of that rule lives in the main process environment, which this side cannot read, so a LAN
 * host is simply not loopback here and its answer stays unknown.
 */
export function isLoopbackEndpoint(endpoint: unknown): boolean {
  const text = typeof endpoint === "string" ? endpoint.trim() : "";
  if (!text) return false;
  let host: string;
  try {
    host = new URL(text.includes("://") ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "::" ||
    host === "0.0.0.0" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The kind of the model that really served a turn, looked up in the router's live list by any of its ids.
 * A row of kind "local" counts only on loopback (or with no endpoint); a row of kind "cloud" stays cloud even
 * behind a loopback gateway; a kind nobody defined, an id nobody lists and a missing id are "unknown". The catalog
 * answers only when the list has no row for the id.
 */
export function modelKindOf(
  servedId: unknown,
  routed: readonly RoutedModel[],
  catalogKind?: (id: string) => "local" | "cloud" | undefined,
): ModelKind {
  const id = typeof servedId === "string" ? servedId.trim() : "";
  if (!id) return "unknown";
  const same = (value: unknown) =>
    typeof value === "string" && value.trim().toLowerCase() === id.toLowerCase();
  const row = routed.find(
    (item) => same(item.id) || same(item.registryId) || same(item.providerModelId),
  );
  if (row) {
    if (row.kind === "cloud") return "cloud";
    if (row.kind !== "local") return "unknown";
    return !row.endpoint?.trim() || isLoopbackEndpoint(row.endpoint) ? "local" : "unknown";
  }
  return catalogKind?.(id) ?? "unknown";
}

/** Memory sources the owner wrote himself. Every other source is outside content for training. */
const OWNER_SOURCES = new Set(["user", "owner", "teach", "settings-intent", "first-run"]);

/**
 * The outside-content kind of one recalled record, or null when the owner wrote it. A source that names its kind
 * (a web address, a screen reader, an upload, a library file, an MCP server) gives that kind; any other source
 * (a task episode, a forge note, nothing) is the conservative kind "memory".
 */
export function kindOfRecalled(item: {
  source?: unknown;
  provenance?: unknown;
}): ContextKind | null {
  const source = typeof item.source === "string" ? item.source.trim().toLowerCase() : "";
  if (item.provenance === "user" || OWNER_SOURCES.has(source)) return null;
  if (/^(https?:|web)/.test(source)) return "web";
  if (/^(dom|uia|ocr|vision|screen)/.test(source)) return "screen";
  if (/^(upload|folder|file|library:)/.test(source)) return "file";
  if (/^mcp/.test(source)) return "mcp";
  return "memory";
}

/**
 * The kinds of the records recalled during a turn that began at `sinceMs`: stored before the turn, used since.
 * A record written during the turn was not recalled into it. Retrieval stamps `lastUsedAt`, so this reads the stamp.
 */
export function kindsOfRecalled(
  items: readonly {
    source?: unknown;
    provenance?: unknown;
    createdAt?: number;
    lastUsedAt?: number;
  }[],
  sinceMs: number,
): ContextKind[] {
  const kinds = new Set<ContextKind>();
  for (const item of items) {
    if (!((item.lastUsedAt ?? 0) >= sinceMs && (item.createdAt ?? 0) < sinceMs)) continue;
    const kind = kindOfRecalled(item);
    if (kind) kinds.add(kind);
  }
  return [...kinds];
}

type Entry = { origin?: PromptOrigin; kinds: Set<ContextKind>; served: Set<string> };

/** Collects the provenance of running turns by run id and flushes it to the ledger under the task id. */
export class TurnProvenance {
  private readonly turns = new Map<string, Entry>();

  private entry(runId: string): Entry {
    const found = this.turns.get(runId);
    if (found) return found;
    const fresh: Entry = { kinds: new Set(), served: new Set() };
    this.turns.set(runId, fresh);
    if (this.turns.size > MAX_TURNS) {
      const oldest = this.turns.keys().next().value;
      if (oldest !== undefined) this.turns.delete(oldest);
    }
    return fresh;
  }

  /** A turn starts: its origin and the outside content that came with the send. */
  begin(runId: string, input: { origin?: unknown; extra?: boolean; screen?: boolean }): void {
    const entry = this.entry(runId);
    if (input.origin === "typed" || input.origin === "owner-voice") entry.origin = input.origin;
    if (input.extra) entry.kinds.add("extra");
    if (input.screen) entry.kinds.add("screen");
  }

  /** Outside content entered the context. Kinds only accumulate: nothing later can make the turn clean again. */
  add(runId: string, kind: ContextKind): void {
    this.entry(runId).kinds.add(kind);
  }

  /** An engine streamed part of this turn's reply. Every engine that spoke is kept, so a retry on another counts. */
  noteServed(runId: string, modelId: string): void {
    const id = String(modelId ?? "").trim();
    if (id) this.entry(runId).served.add(id);
  }

  /**
   * The turn finished: write what was noted into the ledger for `taskId`, then forget the run. `resolve` names the
   * kind of each engine that answered; without it every one is "unknown".
   */
  flush(
    runId: string,
    taskId: string,
    extraKinds: readonly ContextKind[] = [],
    resolve?: (modelId: string) => ModelKind,
  ): void {
    const entry = this.turns.get(runId);
    this.turns.delete(runId);
    const kinds = new Set<ContextKind>([...(entry?.kinds ?? []), ...extraKinds]);
    if (!entry && kinds.size === 0) return;
    if (entry?.origin) experiences.noteProvenance(taskId, { promptAuthor: "owner" });
    for (const kind of kinds) experiences.noteProvenance(taskId, { contextKind: kind });
    for (const id of entry?.served ?? []) {
      experiences.noteProvenance(taskId, {
        model: { id, kind: resolve ? resolve(id) : "unknown" },
      });
    }
  }

  /** How many turns are waiting to be flushed (tests and diagnostics). */
  size(): number {
    return this.turns.size;
  }
}

export const turnProvenance = new TurnProvenance();
