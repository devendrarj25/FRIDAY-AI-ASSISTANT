/**
 * FRIDAY · spoken updates for background work.
 *
 * Background tasks keep running while the owner talks; this decides what is worth saying and when. A task's
 * own state lives in the task ledger and `background-tasks.ts`; the voice state is separate and is only an input
 * here. Rules: say start, a real milestone, a need for input or approval, a failure, and the finish; never speak
 * over the owner or over FRIDAY's own answer; hold updates while busy and release them in order; merge progress
 * lines of the same task so only the newest is spoken; the held list is bounded.
 *
 * Below the announcer sit the delivery classes (`classifyDelivery`), the versioned `VoiceTaskEvent`, its phrasing in
 * English, Hindi and Hinglish (`speechRequestFor`) and `TaskSpeechRouter`, which settles cancelled tasks. All of it
 * is pure: no clock of its own, no timer, no audio. Nothing here opens the microphone.
 */

import type { SpeechRequest } from "./speech-arbiter";
import { stripDeliveryTags } from "./delivery-tags";

export type TaskUpdate = {
  taskId: string;
  kind:
    | "started"
    | "progress"
    | "needs-input"
    | "needs-approval"
    | "completed"
    | "failed"
    | "cancelled";
  text: string;
  /** Whole percent, when the task really reports one. */
  percent?: number;
};

export type VoiceBusy = "listening-to-owner" | "speaking" | "idle";

const URGENT = new Set<TaskUpdate["kind"]>(["needs-input", "needs-approval", "failed"]);

export class TaskAnnouncer {
  private held: TaskUpdate[] = [];
  private lastProgress = new Map<string, { percent: number; at: number }>();

  constructor(
    private readonly options: {
      maxHeld?: number;
      progressStepPercent?: number;
      progressMinGapMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** True when this update is worth saying at all. */
  private worthSaying(update: TaskUpdate): boolean {
    if (update.kind !== "progress") return true;
    const step = this.options.progressStepPercent ?? 25;
    const gap = this.options.progressMinGapMs ?? 20_000;
    if (typeof update.percent !== "number") return false;
    const last = this.lastProgress.get(update.taskId);
    const moved = update.percent - (last?.percent ?? 0) >= step;
    const waited = !last || this.now() - last.at >= gap;
    if (moved && waited) {
      this.lastProgress.set(update.taskId, { percent: update.percent, at: this.now() });
      return true;
    }
    return false;
  }

  /** Returns what to speak now (possibly nothing). Updates that must wait are held. */
  offer(update: TaskUpdate, busy: VoiceBusy): TaskUpdate[] {
    if (!this.worthSaying(update)) return [];
    if (busy !== "idle") {
      this.hold(update);
      return [];
    }
    return [...this.drain(), update];
  }

  /** The owner stopped talking or FRIDAY finished a reply: release what waited, in order. */
  release(busy: VoiceBusy): TaskUpdate[] {
    return busy === "idle" ? this.drain() : [];
  }

  pending(): number {
    return this.held.length;
  }

  private drain(): TaskUpdate[] {
    // Needs-input, approval and failure come first; the rest keep the order they arrived in.
    const out = [
      ...this.held.filter((h) => URGENT.has(h.kind)),
      ...this.held.filter((h) => !URGENT.has(h.kind)),
    ];
    this.held = [];
    return out;
  }

  private hold(update: TaskUpdate): void {
    if (update.kind === "progress") {
      this.held = this.held.filter((h) => !(h.taskId === update.taskId && h.kind === "progress"));
    }
    this.held.push(update);
    const max = this.options.maxHeld ?? 8;
    while (this.held.length > max) {
      const drop = this.held.findIndex((h) => h.kind === "progress" || h.kind === "started");
      this.held.splice(drop >= 0 ? drop : 0, 1);
    }
  }
}

/** How a task update reaches the owner: not at all (a screen row), at the next quiet moment, or right now. */
export type TaskDelivery = "silent" | "when-idle" | "interrupt";
export type TaskRisk = "read-only" | "reversible" | "irreversible";
export type TaskLang = "en" | "hi" | "hinglish";

export type VoiceTaskEvent = {
  v: 1;
  taskId: string;
  seq: number;
  kind: TaskUpdate["kind"];
  delivery: TaskDelivery;
  text: string;
  verified: boolean;
  error?: string;
  risk: TaskRisk;
  at: number;
  turnSeqAtStart: number;
  /** What the owner calls the task; spoken in the "earlier" prefix and in the finish lines. */
  label?: string;
  /** The task touches private content: the arbiter digest counts it and never carries its words. */
  sensitive?: boolean;
};

export type DeliveryContext = {
  /** The owner is waiting on this task right now. */
  foreground: boolean;
  /** A safety event (a guard fired). Raises a failure or a question to an interrupt. */
  safety?: boolean;
  /** The owner asked to hear about this task; defaults to `foreground`. */
  asked?: boolean;
};

export type TaskEventMeta = {
  seq: number;
  now: number;
  turnSeqAtStart: number;
  risk: TaskRisk;
  verified: boolean;
  foreground: boolean;
  safety?: boolean;
  asked?: boolean;
  error?: string;
  label?: string;
  sensitive?: boolean;
};

/**
 * Interrupt is reserved for a needs-approval, a failure of the task the owner waits on, and a safety event that
 * is a failure or a question. Started, progress, completed and cancelled can never interrupt.
 */
export function classifyDelivery(
  item: Pick<TaskUpdate, "kind"> | VoiceTaskEvent,
  ctx: DeliveryContext,
): TaskDelivery {
  const asked = ctx.asked ?? ctx.foreground;
  switch (item.kind) {
    case "needs-approval":
      return "interrupt";
    case "failed":
      return ctx.foreground || ctx.safety === true ? "interrupt" : "when-idle";
    case "needs-input":
      return ctx.safety === true ? "interrupt" : "when-idle";
    case "completed":
      return "when-idle";
    case "started":
    case "progress":
      return asked ? "when-idle" : "silent";
    default:
      return "silent";
  }
}

export function toVoiceTaskEvent(update: TaskUpdate, meta: TaskEventMeta): VoiceTaskEvent {
  return {
    v: 1,
    taskId: update.taskId,
    seq: meta.seq,
    kind: update.kind,
    delivery: classifyDelivery(update, {
      foreground: meta.foreground,
      ...(meta.safety === undefined ? {} : { safety: meta.safety }),
      ...(meta.asked === undefined ? {} : { asked: meta.asked }),
    }),
    text: update.text,
    verified: meta.verified === true,
    ...(meta.error ? { error: meta.error } : {}),
    risk: meta.risk,
    at: meta.now,
    turnSeqAtStart: meta.turnSeqAtStart,
    ...(meta.label ? { label: meta.label } : {}),
    ...(meta.sensitive ? { sensitive: true } : {}),
  };
}

const MAX_ERROR_CHARS = 120;
const DRIVE_PATH = /[A-Za-z]:[\\/][^\s"'<>|]*/g;
/** Any short bracket token: a tag the allow-list does not know must not be read aloud either. */
const BRACKET_TOKEN = /\[[^\]\n]{1,40}\]/g;
const UNC_PATH = /\\\\[^\s"'<>|]+/g;

/** Tool or web text as one clean line: no delivery tag, no drive or network path, no control character. */
function scrub(raw: string | undefined, max: number): string {
  if (!raw) return "";
  const line = stripDeliveryTags(raw)
    .replace(BRACKET_TOKEN, "")
    .replace(UNC_PATH, "")
    .replace(DRIVE_PATH, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? line.slice(0, max).trimEnd() : line;
}

const FALLBACK_LABEL: Record<TaskLang, string> = {
  en: "the task",
  hi: "यह काम",
  hinglish: "yeh kaam",
};
const EARLIER: Record<TaskLang, (label: string) => string> = {
  en: (l) => `About the earlier ${l}: `,
  hi: (l) => `पहले वाले ${l} के बारे में: `,
  hinglish: (l) => `Pehle wale ${l} ke baare mein: `,
};

type Phrases = {
  started: (l: string) => string;
  progress: (l: string) => string;
  input: (l: string) => string;
  approval: (l: string) => string;
  done: (l: string) => string;
  unverified: (l: string) => string;
  failed: (l: string, why: string) => string;
};
const PHRASES: Record<TaskLang, Phrases> = {
  en: {
    started: (l) => `Started ${l}.`,
    progress: (l) => `${l} is still running.`,
    input: (l) => `I need an answer to carry on with ${l}.`,
    approval: (l) => `${l} needs your approval.`,
    done: (l) => `${l} is done.`,
    unverified: (l) => `I finished ${l} but could not check the result.`,
    failed: (l, why) => (why ? `${l} failed: ${why}` : `${l} failed.`),
  },
  hi: {
    started: (l) => `${l} शुरू कर दिया।`,
    progress: (l) => `${l} अभी चल रहा है।`,
    input: (l) => `${l} आगे बढ़ाने के लिए मुझे आपका जवाब चाहिए।`,
    approval: (l) => `${l} के लिए आपकी मंज़ूरी चाहिए।`,
    done: (l) => `${l} पूरा हो गया।`,
    unverified: (l) => `${l} खत्म किया, पर नतीजा जाँच नहीं पाई।`,
    failed: (l, why) => (why ? `${l} नहीं हो पाया: ${why}` : `${l} नहीं हो पाया।`),
  },
  hinglish: {
    started: (l) => `${l} shuru kar diya.`,
    progress: (l) => `${l} abhi chal raha hai.`,
    input: (l) => `${l} aage badhane ke liye mujhe aapka jawab chahiye.`,
    approval: (l) => `${l} ke liye aapki manzoori chahiye.`,
    done: (l) => `${l} ho gaya.`,
    unverified: (l) => `${l} khatam kiya, par result check nahi kar payi.`,
    failed: (l, why) => (why ? `${l} nahi ho paaya: ${why}` : `${l} nahi ho paaya.`),
  },
};

/**
 * The line for the speech arbiter, or null when the event is silent. A completed line says done only when the
 * result was verified; a failure carries the tool's own error and nothing invented; a line about a task from an
 * earlier turn says so. interrupt -> approval (needs-approval) or direct; when-idle -> progress, with a finish
 * line marked `done` so it lives ten minutes and then joins a digest.
 */
export function speechRequestFor(
  event: VoiceTaskEvent,
  turnSeqNow: number,
  lang: TaskLang,
): SpeechRequest | null {
  if (event.delivery === "silent" || event.kind === "cancelled") return null;
  const table = PHRASES[lang] ?? PHRASES.en;
  const label = scrub(event.label, 60) || FALLBACK_LABEL[lang];
  const own = scrub(event.text, 200);
  let line: string;
  switch (event.kind) {
    case "started":
      line = table.started(label);
      break;
    case "progress":
      line = own || table.progress(label);
      break;
    case "needs-input":
      line = own || table.input(label);
      break;
    case "needs-approval":
      line = own || table.approval(label);
      break;
    case "completed":
      line = event.verified === true ? table.done(label) : table.unverified(label);
      break;
    default:
      line = table.failed(label, scrub(event.error, MAX_ERROR_CHARS));
  }
  line = line.charAt(0).toUpperCase() + line.slice(1);
  const later = turnSeqNow - event.turnSeqAtStart >= 1;
  const text = later ? EARLIER[lang](label) + line : line;
  const priority =
    event.delivery === "interrupt"
      ? event.kind === "needs-approval"
        ? "approval"
        : "direct"
      : "progress";
  return {
    text,
    priority,
    taskId: event.taskId,
    ...(event.kind === "progress" ? { coalesceKey: `task:${event.taskId}:progress` } : {}),
    ...(event.kind === "completed" ? { done: true } : {}),
    ...(event.sensitive ? { sensitive: true } : {}),
  };
}

const MAX_SETTLED = 128;

/**
 * Turns task events into speech requests and remembers what is settled. A cancelled task is settled: a late
 * result for it is dropped, never spoken. Silent events are only counted (the screen row is their delivery).
 */
export class TaskSpeechRouter {
  silentCount = 0;
  dropped = 0;
  private readonly settled = new Set<string>();

  isSettled(taskId: string): boolean {
    return this.settled.has(taskId);
  }

  settledCount(): number {
    return this.settled.size;
  }

  route(event: VoiceTaskEvent, turnSeqNow: number, lang: TaskLang): SpeechRequest | null {
    if (this.settled.has(event.taskId)) {
      this.dropped += 1;
      return null;
    }
    if (event.kind === "cancelled") {
      this.settle(event.taskId);
      this.silentCount += 1;
      return null;
    }
    const request = speechRequestFor(event, turnSeqNow, lang);
    if (!request) this.silentCount += 1;
    return request;
  }

  private settle(taskId: string): void {
    this.settled.add(taskId);
    while (this.settled.size > MAX_SETTLED) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}
