/**
 * Brain bridge, pure. The voice side's rules for asking the brain: the ladder of lanes a
 * spoken turn climbs (command, quick, full) with a time box on each rung, the one place that
 * builds the send options of a voice turn, when a spoken "one moment" is wanted, and when a
 * draft started while the owner was still talking may run. No timers, no clock, no DOM: the
 * caller feeds events and reads indexes, so every rule is testable with plain values.
 */

export type LadderLane = "command" | "quick" | "full";

export type LadderStep = {
  readonly lane: LadderLane;
  /** Longest wait for the first token before the next rung; null means no time box. */
  readonly timeboxMs: number | null;
  /** True when a refusal or a timeout of this rung must leave the running foreground turn alone. */
  readonly foregroundSafe: boolean;
};

export type LadderEvent = "first-token" | "timeout" | "refused";

/** The quick lane has one second to produce its first token, then the turn goes on to full. */
export const LADDER_QUICK_FIRST_TOKEN_MS = 1000;

/** Spoken context handed to the brain is cut here. */
export const CONTEXT_MAX_CHARS = 800;

/** A spoken "one moment" is wanted only when the answer is expected later than this. */
export const ACK_THRESHOLD_MS = 1500;

const COMMAND_STEP: LadderStep = Object.freeze({
  lane: "command",
  timeboxMs: null,
  foregroundSafe: true,
});
const QUICK_STEP: LadderStep = Object.freeze({
  lane: "quick",
  timeboxMs: LADDER_QUICK_FIRST_TOKEN_MS,
  foregroundSafe: true,
});
const FULL_STEP: LadderStep = Object.freeze({
  lane: "full",
  timeboxMs: null,
  foregroundSafe: false,
});

export type PlanInput = {
  text: string;
  /** A local command matched the words. */
  commandHit: boolean;
  /** The quick lane may take this turn (short, read-only, answerable from memory). */
  quickEligible: boolean;
  /** A foreground brain turn is already running. */
  busy: boolean;
};

/**
 * The rungs for one spoken turn, in order. Command first when it matched, then the quick
 * lane when the turn may use it, and a whole turn last. While a foreground turn runs the
 * plan holds no full rung at all: the quick lane may answer beside it, nothing else may start.
 */
export function planLadder(input: PlanInput): readonly LadderStep[] {
  if (!String(input.text || "").trim()) return Object.freeze([]);
  const steps: LadderStep[] = [];
  if (input.commandHit) steps.push(COMMAND_STEP);
  if (input.quickEligible) steps.push(QUICK_STEP);
  if (!input.busy) steps.push(FULL_STEP);
  return Object.freeze(steps);
}

/**
 * Where the ladder goes after an event on rung `at`: null when a first token accepted the
 * rung, or when no rung is left; otherwise the index of the next rung. A refusal moves down
 * the ladder and never stops the foreground turn: read `foregroundSafe` on the rung.
 */
export function nextRung(
  plan: readonly LadderStep[],
  at: number,
  event: LadderEvent,
): number | null {
  if (!Number.isInteger(at) || at < 0 || at >= plan.length) return null;
  if (event === "first-token") return null;
  return at + 1 < plan.length ? at + 1 : null;
}

/** A refused rung never cancels, queues behind or replaces the running foreground turn. */
export function refusalKeepsForeground(step: LadderStep): boolean {
  return step.foregroundSafe;
}

export type VoiceSendOptions = {
  routingSurface: "voice";
  lane: "quick" | "full";
  turnId: string;
  context?: string;
};

export type VoiceSendInput = {
  lane: "quick" | "full";
  turnId: string;
  context?: string;
  /** The one privacy classifier (brain/memory-policy.ts looksSensitive), injected. */
  isSensitive?: (text: string) => boolean;
};

function trimContext(raw: string): string {
  let cut = raw.trim().slice(0, CONTEXT_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trim();
}

function safeToSend(text: string, isSensitive: ((s: string) => boolean) | undefined): boolean {
  if (!isSensitive) return false;
  try {
    return !isSensitive(text);
  } catch {
    return false;
  }
}

/**
 * The send options of a voice turn, built in one place so the surface is never forgotten.
 * Context is cut to 800 characters and dropped when the classifier calls it sensitive, when
 * no classifier was given, or when the classifier fails: a voice turn never leaks by default.
 */
export function voiceSendOptions(input: VoiceSendInput): VoiceSendOptions {
  const out: VoiceSendOptions = { routingSurface: "voice", lane: input.lane, turnId: input.turnId };
  const raw = typeof input.context === "string" ? input.context : "";
  if (raw.trim() && safeToSend(raw, input.isSensitive)) {
    const context = trimContext(raw);
    if (context) out.context = context;
  }
  return out;
}

/** True when a short spoken acknowledgement should cover the wait; never for a command. */
export function ackWanted(input: { lane: LadderLane; expectedMs: number }): boolean {
  return (
    input.lane !== "command" &&
    Number.isFinite(input.expectedMs) &&
    input.expectedMs > ACK_THRESHOLD_MS
  );
}

/**
 * A draft begun before the turn ended may run only read-only, and only while privacy, paid
 * access and the autonomy dial are all as they were when it started.
 */
export function speculationAllowed(input: {
  privacyChanged: boolean;
  paidChanged: boolean;
  autonomyChanged: boolean;
  readOnly: boolean;
}): boolean {
  return input.readOnly && !input.privacyChanged && !input.paidChanged && !input.autonomyChanged;
}

/* ---------- status lines while a long task runs ---------- */

/**
 * The small fast model may say ONE short status line while the main model works. The line comes from a closed
 * template that names only the task verb: the label of the task, a tool result, a page or a file never reaches the
 * model (all of it is data, never an instruction), and the model's words go through `cleanTaskStatus` before any
 * sound. The conductor owns the timer, the model call and the playback; these are the pure rules.
 */
export const STATUS_VERBS = [
  "search",
  "read",
  "open",
  "write",
  "check",
  "install",
  "download",
  "work",
] as const;
export type StatusVerb = (typeof STATUS_VERBS)[number];
export type StatusLineLang = "en" | "hi" | "hinglish";

/** A status line is at most this many words. */
export const STATUS_LINE_MAX_WORDS = 12;
/** The first status line comes after the task has run this long without an answer. */
export const STATUS_FIRST_MS = 8_000;
/** At least this long between two status lines of one task. */
export const STATUS_GAP_MS = 20_000;
/** At most this many status lines for one task. */
export const STATUS_PER_TASK = 4;

// Closed stems, matched on a lowercased label. A label is read here and never copied: only a verb comes out.
const VERB_STEMS: ReadonlyArray<readonly [StatusVerb, RegExp]> = [
  ["download", /download|डाउनलोड/u],
  ["install", /install|set\s?up|इंस्टॉल/u],
  ["search", /search|find|look\s?up|dhoond|khoj|ढूँढ|खोज/u],
  ["read", /\bread|summar|padh|पढ़/u],
  ["open", /\bopen|launch|khol|खोल/u],
  ["write", /\bwrite|draft|compose|likh|लिख/u],
  ["check", /check|verify|\btest|scan|jaanch|जाँच/u],
];

/** The one verb of the closed list that a task label points at; "work" when none does. */
export function statusVerbFor(label: unknown): StatusVerb {
  if (typeof label !== "string") return "work";
  const text = label.normalize("NFC").toLowerCase().slice(0, 200);
  for (const [verb, stem] of VERB_STEMS) if (stem.test(text)) return verb;
  return "work";
}

const STATUS_LANG_RULE: Record<StatusLineLang, string> = {
  en: "English",
  hi: "Hindi in Devanagari script, as a woman (for example: कर रही हूँ, देखती हूँ)",
  hinglish: "Hinglish in Latin letters, as a woman (for example: kar rahi hoon, dekhti hoon)",
};
const STATUS_VERB_PHRASE: Record<StatusVerb, string> = {
  search: "searching",
  read: "reading",
  open: "opening something",
  write: "writing",
  check: "checking",
  install: "installing",
  download: "downloading",
  work: "working on it",
};

export type StatusLineRequest = { system: string; prompt: string; maxTokens: number };

/**
 * The model call for one status line. The only variable parts are two members of closed lists (the verb and the
 * language), so no text of the owner, a task or a tool can steer the model.
 */
export function statusLineRequest(verb: StatusVerb, lang: StatusLineLang): StatusLineRequest {
  const v: StatusVerb = STATUS_VERBS.includes(verb) ? verb : "work";
  const rule = STATUS_LANG_RULE[lang] ?? STATUS_LANG_RULE.en;
  return {
    system:
      "You are FRIDAY, speaking aloud while a longer task runs. " +
      `Say ONE short sentence, at most ${STATUS_LINE_MAX_WORDS} words, in ${rule}. ` +
      `Say only that you are still ${STATUS_VERB_PHRASE[v]}. ` +
      "No emoji, no markdown, no list, no question, no numbers, no link. " +
      "Do not say yes, no or okay, and do not ask for or give any permission.",
    prompt: `Task: ${v}`,
    maxTokens: 48,
  };
}

export type StatusSkip =
  | "not-auto-mode"
  | "speech-off"
  | "held"
  | "quiet-hours"
  | "whisper-mode"
  | "call-hold"
  | "pending-confirmation"
  | "speaking"
  | "owner-speaking"
  | "no-task"
  | "answer-started"
  | "too-early"
  | "rate-limited"
  | "task-cap";

export type StatusDueInput = {
  /** The conductor mode. Only Auto speaks; Chat and Manual never do. */
  mode: string;
  speakReplies: boolean;
  held: boolean;
  quiet: boolean;
  whisperMode: boolean;
  callHold: boolean;
  pendingConfirmation: boolean;
  speaking: boolean;
  ownerSpeaking: boolean;
  /** A long task or tool run is going. */
  taskRunning: boolean;
  /** The first clause of the real answer has started. */
  answerStarted: boolean;
  now: number;
  taskStartedAt: number;
  /** When the last status line of this task was said; null for none yet. */
  lastStatusAt: number | null;
  sentThisTask: number;
};

/** Every gate, in order; the first that fires is the reason. A missing or odd value never speaks. */
export function statusLineDue(
  input: StatusDueInput,
): { due: true } | { due: false; reason: StatusSkip } {
  const no = (reason: StatusSkip) => ({ due: false as const, reason });
  if (input.mode !== "auto") return no("not-auto-mode");
  if (input.speakReplies !== true) return no("speech-off");
  if (input.held) return no("held");
  if (input.quiet) return no("quiet-hours");
  if (input.whisperMode) return no("whisper-mode");
  if (input.callHold) return no("call-hold");
  if (input.pendingConfirmation) return no("pending-confirmation");
  if (input.speaking) return no("speaking");
  if (input.ownerSpeaking) return no("owner-speaking");
  if (input.taskRunning !== true) return no("no-task");
  if (input.answerStarted) return no("answer-started");
  if (!(input.sentThisTask < STATUS_PER_TASK)) return no("task-cap");
  if (!Number.isFinite(input.now) || !Number.isFinite(input.taskStartedAt)) return no("too-early");
  if (input.now - input.taskStartedAt < STATUS_FIRST_MS) return no("too-early");
  if (input.lastStatusAt !== null && !(input.now - input.lastStatusAt >= STATUS_GAP_MS)) {
    return no("rate-limited");
  }
  return { due: true };
}

/**
 * Asked again after every await (the model call, the clip loading): false means drop the line at once. The real
 * answer starting, the task ending, a newer turn, the owner speaking and a hold all cancel it.
 */
export function statusLineStillDue(
  armed: { taskId: string; generation: number },
  live: {
    taskId: string;
    generation: number;
    taskRunning: boolean;
    answerStarted: boolean;
    held: boolean;
    speaking: boolean;
    ownerSpeaking: boolean;
    pendingConfirmation: boolean;
    callHold: boolean;
  },
): { due: true } | { due: false; reason: StatusSkip | "stale-generation" } {
  if (armed.taskId !== live.taskId || armed.generation !== live.generation) {
    return { due: false, reason: "stale-generation" };
  }
  if (live.answerStarted) return { due: false, reason: "answer-started" };
  if (!live.taskRunning) return { due: false, reason: "no-task" };
  if (live.held) return { due: false, reason: "held" };
  if (live.pendingConfirmation) return { due: false, reason: "pending-confirmation" };
  if (live.ownerSpeaking) return { due: false, reason: "owner-speaking" };
  if (live.speaking) return { due: false, reason: "speaking" };
  if (live.callHold) return { due: false, reason: "call-hold" };
  return { due: true };
}
