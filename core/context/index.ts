/**
 * FRIDAY · core/context
 *
 * The working context assembled for every request: the active session, the
 * short-term turn window and the memory snippets the brain was given. Held in
 * one place so the planner, the router and memory-update all read the same
 * object instead of rebuilding it.
 */
import type { FridayModule, ModuleContext } from "../types";
import { bus } from "../event-bus";

export interface ContextTurn {
  role: "user" | "assistant" | "system";
  text: string;
  at: number;
}

export interface MemorySnippet {
  id: string;
  kind: "working" | "temporary" | "episodic" | "semantic" | "permanent" | "archived";
  title: string;
  snippet: string;
  score?: number;
}

export interface RequestContext {
  sessionId: string;
  turns: ContextTurn[];
  memory: MemorySnippet[];
  facts: Record<string, unknown>;
}

export class ContextStore {
  private sessionId = "session-0";
  private turns: ContextTurn[] = [];
  private memory: MemorySnippet[] = [];
  private facts: Record<string, unknown> = {};
  private windowSize = 24;

  startSession(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.turns = [];
    this.memory = [];
    bus.emit("context:session", sessionId);
  }

  addTurn(turn: ContextTurn): void {
    this.turns.push(turn);
    if (this.turns.length > this.windowSize) this.turns = this.turns.slice(-this.windowSize);
    bus.emit("context:turn", turn);
  }

  setMemory(snippets: MemorySnippet[]): void {
    this.memory = snippets;
    bus.emit("context:memory", snippets.length);
  }

  setFact(key: string, value: unknown): void {
    this.facts[key] = value;
  }

  build(): RequestContext {
    return {
      sessionId: this.sessionId,
      turns: [...this.turns],
      memory: [...this.memory],
      facts: { ...this.facts },
    };
  }

  clear(): void {
    this.turns = [];
    this.memory = [];
    this.facts = {};
  }
}

export const context = new ContextStore();

export type ContextModule = FridayModule;

export const contextModule: ContextModule = {
  id: "core/context",
  init(_ctx: ModuleContext) {
    context.clear();
  },
  dispose() {
    context.clear();
  },
};

export default contextModule;
