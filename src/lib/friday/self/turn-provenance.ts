/**
 * FRIDAY · turn provenance
 *
 * Who wrote the prompt of a turn and what untrusted content entered its context, noted while the turn runs and
 * handed to the task ledger when it finishes. The ledger row is the only thing fine-tuning may read, so the rule
 * is strict: "owner" only for text the owner typed in the chat box or spoke into his own microphone this turn, and
 * every kind of outside content (web, screen, MCP, file, tool, app-supplied extra) is recorded the moment it enters.
 * A turn that nobody tagged stays "unknown" and is never trained on.
 */

import { experiences, type PromptAuthor } from "./task-ledger";

/** Where the prompt text came from. Only these two count as the owner's own words. */
export type PromptOrigin = "typed" | "owner-voice";

/** What may sit in a model context besides the owner's prompt. "extra" is app-supplied text of unknown source. */
export type ContextKind = "web" | "screen" | "mcp" | "file" | "tool" | "extra";

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

type Entry = { origin?: PromptOrigin; kinds: Set<ContextKind> };

/** Collects the provenance of running turns by run id and flushes it to the ledger under the task id. */
export class TurnProvenance {
  private readonly turns = new Map<string, Entry>();

  private entry(runId: string): Entry {
    const found = this.turns.get(runId);
    if (found) return found;
    const fresh: Entry = { kinds: new Set() };
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

  /** The turn finished: write what was noted into the ledger for `taskId`, then forget the run. */
  flush(runId: string, taskId: string, extraKinds: readonly ContextKind[] = []): void {
    const entry = this.turns.get(runId);
    this.turns.delete(runId);
    const kinds = new Set<ContextKind>([...(entry?.kinds ?? []), ...extraKinds]);
    if (!entry && kinds.size === 0) return;
    if (entry?.origin) experiences.noteProvenance(taskId, { promptAuthor: "owner" });
    for (const kind of kinds) experiences.noteProvenance(taskId, { contextKind: kind });
  }

  /** How many turns are waiting to be flushed (tests and diagnostics). */
  size(): number {
    return this.turns.size;
  }
}

export const turnProvenance = new TurnProvenance();
