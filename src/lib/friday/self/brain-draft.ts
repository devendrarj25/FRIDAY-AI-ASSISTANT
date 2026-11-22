/**
 * FRIDAY · run ownership and draft mode: the small shared types and pure rules.
 *
 * The Brain keeps one running turn at a time. Two things sit beside that lane and never widen it:
 *  - an OWNER tag on a run, so a long task keeps running when the owner only stops the foreground, and
 *  - a DRAFT, a guess at the answer made while the owner is still finishing the sentence. A draft is text only:
 *    no tools, no approval, no memory write, no history row. It is promoted to a real run only when the final
 *    transcript is exactly the text the draft started from.
 * Nothing here reads the window, a clock or a store, so it can be tested on its own.
 */

/** Who a run belongs to. An absent owner is the foreground turn. */
export type RunOwner = { kind: "task"; taskId: string };

/** What a stop reaches. `all` is the owner's Stop, Clear chat and the kill switch. */
export type StopScope = "all" | "foreground" | { taskId: string };

/** The draft a caller holds. `text` fills in as the answer streams; adoption compares `prompt`. */
export type DraftHandle = {
  draftId: string;
  /** The words the draft was started from. Adoption needs the final transcript to equal them. */
  prompt: string;
  /** The answer so far. */
  text: string;
  firstTokenAt?: number;
};

export type DraftRefusal =
  | "empty"
  | "stopped"
  | "busy"
  | "approval-pending"
  | "draft-live"
  | "sensitive"
  | "not-a-plain-question"
  | "needs-live-data"
  | "no-local-or-free-model"
  | "no-desktop";

export type DraftStart =
  { started: true; draft: DraftHandle } | { started: false; reason: DraftRefusal };

/** A draft that is not adopted or discarded dies after this long. */
export const DRAFT_TTL_MS = 10_000;

/** One plain model call: no tools, no claim of having done anything. */
export const DRAFT_SYSTEM =
  "You are FRIDAY. Answer this one short question in one or two sentences from what you know. Do not start tasks, do not use tools, never say you have done something, and say plainly if you do not know.";

/** The slice of a registry row the draft pool reads. */
export type DraftModelRow = {
  id: string;
  type: "local" | "cloud";
  access: "free" | "paid" | "unknown";
  available: boolean;
  eligible: boolean;
};

/**
 * The models a draft may reach: installed, eligible, and local or proven free. Paid and unknown-cost rows
 * are never in the pool (the billing firewall applies to a draft exactly as to a final turn). When the line
 * must stay on this PC (privacy mode) only local rows count.
 */
export function draftPool(rows: readonly DraftModelRow[], onlyLocal: boolean): DraftModelRow[] {
  return rows.filter(
    (row) =>
      row.available &&
      row.eligible &&
      (row.type === "local" || (!onlyLocal && row.type === "cloud" && row.access === "free")),
  );
}

/** Adoption wants the same words. Only the ends are trimmed: a different case or mark is a different turn. */
export function sameTranscript(a: string, b: string): boolean {
  return String(a ?? "").trim() === String(b ?? "").trim();
}

/** The task a stop with this scope may end: undefined means the foreground (no owner). */
export function stopReaches(scope: StopScope, owner: RunOwner | undefined): boolean {
  if (scope === "all") return true;
  if (scope === "foreground") return owner === undefined;
  return owner?.kind === "task" && owner.taskId === scope.taskId;
}
