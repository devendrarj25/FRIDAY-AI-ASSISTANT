/**
 * FRIDAY · narration policy: what a running task is allowed to say out loud.
 *
 * Pure rules over one event at a time. `narrate(event, ctx)` returns the single line to speak (or null), what goes
 * to the screen instead, and a notification when the owner could not be spoken to. The memory object in the
 * context holds the little that must carry over between events (when the last line was said, how far each task
 * got); it is the only thing `narrate` changes.
 *
 * What may be said: one batched acknowledgement; a real milestone (a percent step of 25 or more, at least 20 s
 * after the last one, or a named tool step at most once every 15 s) under a global cap of lines per minute; a
 * need for approval or input at once, once more after 20 s, then on screen only; a failure once, with a plain
 * cause and an offer to retry; the finish as the model's own first sentence after links, paths and code are
 * taken out. With three or more tasks running, one rolled-up line per minute and only when the owner has been
 * quiet for 20 s.
 *
 * What is never said: raw tool, page or file output, links, paths, commands, code, stack traces, secret-looking
 * values, a percent the task did not report. Content marked SENSITIVE is replaced by a neutral line that points
 * to the screen. A call hold speaks nothing and keeps a text digest for afterwards; quiet hours speak nothing
 * but notify for an approval; muted or replies off means the screen only. She never claims to be human.
 */
import { stepSubject } from "../voice-session";
import { completionLine } from "./background-request";

export type NarrateEvent =
  | { kind: "ack"; taskId: string; count?: number }
  | { kind: "progress"; taskId: string; label?: string; percent?: number; step?: string }
  | { kind: "needs-approval"; taskId: string; label?: string }
  | { kind: "needs-input"; taskId: string; label?: string }
  | { kind: "failed"; taskId: string; label?: string; cause?: string }
  | { kind: "done"; taskId: string; label?: string; answer?: string }
  | { kind: "rollup" }
  | { kind: "settled"; taskId: string };

export type NarrationLang = "en" | "hi";

export type NarrationMemory = {
  lastAckAt: number;
  progress: Map<string, { percent: number; at: number }>;
  /** When progress-class lines were really spoken, for the per-minute cap. */
  spokenAt: number[];
  lastToolAt: number;
  lastRollupAt: number;
  approvals: Map<string, { count: number; at: number }>;
  failed: Set<string>;
  done: Set<string>;
  /** Lines kept for a text digest (a call hold, quiet hours). Already neutral where sensitive. */
  held: string[];
  recent: string[];
};

export type NarrateContext = {
  now: number;
  lang: NarrationLang;
  speakReplies: boolean;
  muted: boolean;
  callHold: boolean;
  alertsAudible: boolean;
  whisperMode: boolean;
  progressLinesPerMinute: number;
  runningTasks: number;
  ownerIdleMs: number;
  /** The task this event is about handles SENSITIVE content. */
  sensitive: boolean;
  memory: NarrationMemory;
};

export type NarrateResult = {
  say: string | null;
  /** The line to show instead of saying it. */
  screenOnly?: string;
  /** The line to raise as a notification (an approval the owner could not be told aloud). */
  notify?: string;
  /** Say it quietly. Only progress lines carry it. */
  whisper?: true;
  /** The arbiter priority for the line. */
  priority?: "approval" | "direct" | "progress";
  /** A finish line: the arbiter keeps it ten minutes and then turns it into a digest. */
  done?: true;
};

export const APPROVAL_REPEAT_MS = 20_000;
export const ACK_BATCH_MS = 6_000;
export const MILESTONE_STEP = 25;
export const MILESTONE_GAP_MS = 20_000;
export const TOOL_GAP_MS = 15_000;
export const ROLLUP_MIN_TASKS = 3;
export const ROLLUP_GAP_MS = 60_000;
export const ROLLUP_IDLE_MS = 20_000;
export const CAP_WINDOW_MS = 60_000;
export const DEFAULT_PROGRESS_LINES_PER_MINUTE = 3;
const LABEL_MAX = 40;
const DONE_MAX = 160;

export function createNarrationMemory(): NarrationMemory {
  return {
    lastAckAt: Number.NEGATIVE_INFINITY,
    progress: new Map(),
    spokenAt: [],
    lastToolAt: Number.NEGATIVE_INFINITY,
    lastRollupAt: Number.NEGATIVE_INFINITY,
    approvals: new Map(),
    failed: new Set(),
    done: new Set(),
    held: [],
    recent: [],
  };
}

/* ---------- what may never be spoken ---------- */

const CODE_MARK = "";
const SECRET_MARK = "";

const FENCE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL = /\b(?:https?|ftp|file):\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;
const BARE_DOMAIN =
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|ai|co|app|gov|edu)(?:\/[^\s]*)?(?![\w-])/gi;
const WIN_PATH = /(?:[A-Za-z]:[\\/][^\s"'<>|]*|\\\\[\w.$-]+\\[^\s"'<>|]*)/g;
const UNIX_PATH = /(?<![\w/.:-])(?:~|\.{1,2})?\/(?:[\w.@+-]+\/)*[\w.@+-]+\/?/g;

const SECRETS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:password|passwd|pwd|passcode|secret|token|api[ _-]?key|otp|pin|cvv)\b\s*(?:is|:|=)\s*(?=\S*\d|\S{8})\S+/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  /\b(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{40,}\b/g,
];

const STACK =
  /Traceback \(most recent call last\)|\bat\s+[\w.$<>]+\s*\(|\bat\s+\S+:\d+(?::\d+)?\b|\bFile ".*", line \d+|\b\w*(?:Error|Exception):|\b(?:ENOENT|EACCES|EPERM|ECONN\w*|ETIMEDOUT|ENOTFOUND|ENOSPC|EADDRINUSE)\b|\b0x[0-9a-fA-F]{4,}\b|\w+\.(?:js|ts|py|cjs|mjs|java|cs):\d+/;
const COMMAND =
  /(?:^|[\s(])\$\s+\S+|\b(?:npm|npx|pnpm|yarn|pip3?|pipx|git|python3?|node|curl|wget|sudo|rm|del|rmdir|mkdir|chmod|powershell|pwsh|cmd|choco|winget|apt(?:-get)?|brew|docker|kubectl)\s+(?:-{1,2}[\w-]+|install|uninstall|run|add|clone|push|pull|commit|checkout|reset|remove|exec|build|start|test)\b|(?:^|\s)--[a-z][\w-]+/i;
const CODEISH =
  /\b(?:const|let|var|function|def|class|import|export|return|await|async)\s+[\w${}.]+\s*(?:=|\(|=>|\{)|=>|[{};]\s*$|[\w$]+\([^()]*\)\s*[;{]|\{\s*["']?\w+["']?\s*:\s*|<\/?[a-z][\w-]*[^>]*>/i;

export type Scrubbed = { text: string; removed: boolean; unsafe: boolean; secret: boolean };

const letterShare = (value: string): number => {
  const compact = value.replace(/\s+/gu, "");
  if (!compact) return 1;
  const letters = compact.match(/[\p{L}\p{M}]/gu)?.length ?? 0;
  return letters / compact.length;
};

/** The words of a single line that cannot be said aloud: a stack trace, a command, code, a table, symbols. */
function unsafeLine(value: string): boolean {
  if (STACK.test(value) || COMMAND.test(value) || CODEISH.test(value)) return true;
  if ((value.match(/\|/g)?.length ?? 0) >= 2) return true;
  return value.length > 8 && letterShare(value.replace(/[]/g, "")) < 0.5;
}

/** Take links, paths, code and secrets out; marks stay where code and secrets were, for the sentence check. */
function scrub(input: string): Scrubbed {
  const original = String(input ?? "");
  let text = original;
  let removed = false;
  let secret = false;
  const swap = (re: RegExp, to: string, isSecret = false) => {
    text = text.replace(re, () => {
      removed = true;
      if (isSecret) secret = true;
      return to;
    });
  };
  swap(FENCE, ` ${CODE_MARK} `);
  swap(INLINE_CODE, ` ${CODE_MARK} `);
  for (const re of SECRETS) swap(re, ` ${SECRET_MARK} `, true);
  swap(URL, "a link");
  swap(WIN_PATH, "a file");
  swap(UNIX_PATH, "a file");
  swap(BARE_DOMAIN, "a link");
  text = text
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/[*_]{1,3}(\S[^*_\n]*\S|\S)[*_]{1,3}/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
  return {
    text,
    removed,
    unsafe: unsafeLine(text.replace(/\n/g, " ")) || STACK.test(text) || COMMAND.test(text),
    secret,
  };
}

/** Public form: the text with no marks, what was removed, and whether what is left is still not speakable. */
export function sanitizeForSpeech(input: string): Scrubbed {
  const scrubbed = scrub(input);
  return {
    ...scrubbed,
    text: scrubbed.text.replace(/[]/g, " ").replace(/\s+/g, " ").trim(),
  };
}

/** A short, plain name for a task, or "" when the label holds anything that must not be read out. */
function safeLabel(label: string | undefined): string {
  if (!label) return "";
  const scrubbed = scrub(label);
  if (scrubbed.removed || scrubbed.unsafe || scrubbed.secret) return "";
  const text = scrubbed.text.replace(/\s+/g, " ").trim();
  return text.length > LABEL_MAX ? "" : text;
}

/** Last guard on every spoken line. */
function speakable(line: string): boolean {
  return Boolean(line.trim()) && !unsafeLine(line) && !scrub(line).removed;
}

/* ---------- the words ---------- */

type Cause = "offline" | "timeout" | "permission" | "notfound" | "rate" | "disk" | "unknown";

/** Only a class of cause is ever spoken; the raw text of an error is never read out. */
export function classifyCause(raw: string | undefined): Cause {
  const value = String(raw ?? "");
  if (
    /ENOTFOUND|EAI_AGAIN|ECONN\w*|ENETUNREACH|getaddrinfo|fetch failed|offline|network (?:is )?(?:down|unreachable)|no internet/i.test(
      value,
    )
  )
    return "offline";
  if (/ETIMEDOUT|timed? ?out|timeout|deadline exceeded/i.test(value)) return "timeout";
  if (
    /EACCES|EPERM|permission|access (?:is )?denied|forbidden|unauthori[sz]ed|\b40[13]\b/i.test(
      value,
    )
  )
    return "permission";
  if (/ENOENT|no such file|not found|\b404\b/i.test(value)) return "notfound";
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(value)) return "rate";
  if (/ENOSPC|no space left|disk (?:is )?full/i.test(value)) return "disk";
  return "unknown";
}

const CAUSE_TEXT: Record<NarrationLang, Record<Cause, string>> = {
  en: {
    offline: "there's no connection",
    timeout: "it took too long",
    permission: "I wasn't allowed to do it",
    notfound: "I couldn't find it",
    rate: "the service is busy",
    disk: "the disk is full",
    unknown: "something went wrong",
  },
  hi: {
    offline: "connection nahi hai",
    timeout: "bahut der lag gayi",
    permission: "permission nahi mili",
    notfound: "mila nahi",
    rate: "service abhi busy hai",
    disk: "disk full hai",
    unknown: "kuch gadbad ho gayi",
  },
};

const FIXED = {
  en: {
    ack: ["On it.", "Right, on it.", "Working on that.", "Understood, starting now."],
    askNoLabel: ["I need your yes or no to go on."],
    askAgain: ["Still waiting for your yes or no."],
    inputFirst: ["I need one thing from you to go on."],
    inputAgain: ["Still need that one answer from you."],
    doneGeneric: ["That's done."],
    detailsOnScreen: "The details are on screen.",
    sensitiveDone: ["That's done. The details are on screen."],
    sensitiveFailed: ["That didn't work. Want me to try again? The details are on screen."],
    sensitiveAsk: ["I need your yes or no. The details are on screen."],
    toolGeneric: ["Working on that now.", "That step is running."],
  },
  hi: {
    ack: ["Ji, abhi karti hu.", "Theek hai, lag gayi hu.", "Samajh gayi, shuru karti hu."],
    askNoLabel: ["Aage badhne se pehle aapki haan ya na chahiye."],
    askAgain: ["Abhi bhi aapki haan ya na ka intezaar hai."],
    inputFirst: ["Aage badhne ke liye aapse ek cheez chahiye."],
    inputAgain: ["Abhi bhi wo ek jawab chahiye."],
    doneGeneric: ["Ho gaya."],
    detailsOnScreen: "Details screen par hain.",
    sensitiveDone: ["Ho gaya. Details screen par hain."],
    sensitiveFailed: ["Ye nahi ho paya. Dobara try karu? Details screen par hain."],
    sensitiveAsk: ["Aapki haan ya na chahiye. Details screen par hain."],
    toolGeneric: ["Is step par lagi hu.", "Ye kar rahi hu abhi."],
  },
} as const;

/** The fixed lines, for the tests that check no line claims to be human, links to anything or reads code. */
export const LINE_POOLS: Record<string, readonly string[]> = {
  enAck: FIXED.en.ack,
  enAsk: [
    ...FIXED.en.askNoLabel,
    ...FIXED.en.askAgain,
    ...FIXED.en.inputFirst,
    ...FIXED.en.inputAgain,
  ],
  enDone: [
    ...FIXED.en.doneGeneric,
    ...FIXED.en.sensitiveDone,
    ...FIXED.en.sensitiveFailed,
    ...FIXED.en.sensitiveAsk,
  ],
  enTool: FIXED.en.toolGeneric,
  hiAck: FIXED.hi.ack,
  hiAsk: [
    ...FIXED.hi.askNoLabel,
    ...FIXED.hi.askAgain,
    ...FIXED.hi.inputFirst,
    ...FIXED.hi.inputAgain,
  ],
  hiDone: [
    ...FIXED.hi.doneGeneric,
    ...FIXED.hi.sensitiveDone,
    ...FIXED.hi.sensitiveFailed,
    ...FIXED.hi.sensitiveAsk,
  ],
  hiTool: FIXED.hi.toolGeneric,
};

/** The first line not said recently; the last few are remembered so a pool never repeats at once. */
function pick(options: readonly string[], memory: NarrationMemory): string {
  const fresh = options.filter((line) => !memory.recent.includes(line));
  const line = (fresh.length ? fresh : options)[0] ?? "";
  memory.recent.push(line);
  if (memory.recent.length > 6) memory.recent.splice(0, memory.recent.length - 6);
  return line;
}

/* ---------- delivery ---------- */

type Kind = "approval" | "alert" | "progress";

const capFull = (ctx: NarrateContext): boolean => {
  const live = ctx.memory.spokenAt.filter((at) => ctx.now - at < CAP_WINDOW_MS);
  ctx.memory.spokenAt = live;
  return live.length >= Math.max(0, ctx.progressLinesPerMinute);
};

const PRIORITY = { approval: "approval", alert: "direct", progress: "progress" } as const;

/** Apply the gates (call hold, mute, quiet hours) to a line that was chosen on its merits. */
function deliver(
  ctx: NarrateContext,
  kind: Kind,
  line: string,
  extra: { done?: boolean; hold?: boolean } = {},
): NarrateResult {
  const { memory } = ctx;
  const priority = PRIORITY[kind];
  const mark = extra.done ? ({ done: true } as const) : {};
  const keep = (): void => {
    if (extra.hold) memory.held.push(line);
  };
  if (ctx.callHold) {
    keep();
    return {
      say: null,
      ...(kind === "progress" ? {} : { screenOnly: line }),
      ...(kind === "approval" ? { notify: line } : {}),
    };
  }
  if (ctx.muted || !ctx.speakReplies) {
    return { say: null, ...(kind === "progress" ? {} : { screenOnly: line }) };
  }
  if (!ctx.alertsAudible) {
    keep();
    return {
      say: null,
      ...(kind === "progress" ? {} : { screenOnly: line }),
      ...(kind === "approval" ? { notify: line } : {}),
    };
  }
  if (kind === "progress") memory.spokenAt.push(ctx.now);
  return {
    say: line,
    priority,
    ...mark,
    ...(kind === "progress" && ctx.whisperMode ? { whisper: true as const } : {}),
  };
}

const QUIET: NarrateResult = { say: null };

/* ---------- the events ---------- */

function ack(event: Extract<NarrateEvent, { kind: "ack" }>, ctx: NarrateContext): NarrateResult {
  const { memory, lang } = ctx;
  if (ctx.now - memory.lastAckAt < ACK_BATCH_MS) return QUIET;
  memory.lastAckAt = ctx.now;
  const many = event.count && event.count > 1 ? Math.floor(event.count) : 0;
  const line = many
    ? pick(
        lang === "hi" ? [`${many} kaam shuru kar diye.`] : [`Got it, ${many} things started.`],
        memory,
      )
    : pick(FIXED[lang].ack, memory);
  return deliver(ctx, "progress", line);
}

function rollup(ctx: NarrateContext): NarrateResult {
  const { memory } = ctx;
  if (ctx.runningTasks < ROLLUP_MIN_TASKS) return QUIET;
  if (ctx.ownerIdleMs < ROLLUP_IDLE_MS || ctx.now - memory.lastRollupAt < ROLLUP_GAP_MS)
    return QUIET;
  if (capFull(ctx)) return QUIET;
  memory.lastRollupAt = ctx.now;
  const n = Math.floor(ctx.runningTasks);
  return deliver(
    ctx,
    "progress",
    ctx.lang === "hi" ? `${n} kaam chal rahe hain.` : `${n} tasks are running.`,
  );
}

function progress(
  event: Extract<NarrateEvent, { kind: "progress" }>,
  ctx: NarrateContext,
): NarrateResult {
  const { memory, lang } = ctx;
  if (ctx.runningTasks >= ROLLUP_MIN_TASKS) return rollup(ctx);
  const percent = event.percent;
  if (typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100) {
    const last = memory.progress.get(event.taskId) ?? { percent: 0, at: Number.NEGATIVE_INFINITY };
    if (percent - last.percent >= MILESTONE_STEP && ctx.now - last.at >= MILESTONE_GAP_MS) {
      if (capFull(ctx)) return QUIET;
      const p = Math.round(percent);
      memory.progress.set(event.taskId, { percent, at: ctx.now });
      return deliver(
        ctx,
        "progress",
        pick(
          lang === "hi"
            ? [`Lagbhag ${p} percent ho gaya.`, `${p} percent tak pahunch gayi.`]
            : [`About ${p} percent done.`, `${p} percent there.`, `Roughly ${p} percent so far.`],
          memory,
        ),
      );
    }
  }
  if (event.step && !ctx.sensitive && ctx.now - memory.lastToolAt >= TOOL_GAP_MS) {
    const subject = lang === "en" ? stepSubject(event.step) : "";
    const named =
      lang === "en" ? Boolean(subject) && speakable(subject) : scrub(event.step).removed === false;
    if (named && stepSubject(event.step)) {
      if (capFull(ctx)) return QUIET;
      memory.lastToolAt = ctx.now;
      const line =
        lang === "en"
          ? pick([`${subject}.`, `${subject}, one moment.`, `${subject} now.`], memory)
          : pick(FIXED.hi.toolGeneric, memory);
      return deliver(ctx, "progress", line);
    }
  }
  return QUIET;
}

function approval(
  event: Extract<NarrateEvent, { kind: "needs-approval" | "needs-input" }>,
  ctx: NarrateContext,
): NarrateResult {
  const { memory, lang } = ctx;
  const asking = event.kind === "needs-approval";
  const seen = memory.approvals.get(event.taskId);
  if (seen && seen.count === 1 && ctx.now - seen.at < APPROVAL_REPEAT_MS) return QUIET;
  const label = ctx.sensitive ? "" : safeLabel(event.label);
  const first = !seen;
  const again = seen?.count === 1;
  memory.approvals.set(event.taskId, { count: first ? 1 : 2, at: ctx.now });
  let line: string;
  if (ctx.sensitive) line = pick(FIXED[lang].sensitiveAsk, memory);
  else if (first && asking && label) {
    line = pick(
      lang === "hi"
        ? [`${label}: karu? Aapki haan ya na chahiye.`]
        : [`${label}: shall I go ahead? I need a yes or no.`],
      memory,
    );
  } else if (first) line = pick(asking ? FIXED[lang].askNoLabel : FIXED[lang].inputFirst, memory);
  else line = pick(asking ? FIXED[lang].askAgain : FIXED[lang].inputAgain, memory);
  if (!first && !again) {
    // Said twice already: the screen carries it from here.
    return { say: null, screenOnly: line };
  }
  return deliver(ctx, "approval", line, { hold: true });
}

function failed(
  event: Extract<NarrateEvent, { kind: "failed" }>,
  ctx: NarrateContext,
): NarrateResult {
  const { memory, lang } = ctx;
  if (memory.failed.has(event.taskId)) return QUIET;
  memory.failed.add(event.taskId);
  let line: string;
  if (ctx.sensitive) line = pick(FIXED[lang].sensitiveFailed, memory);
  else {
    const cause = CAUSE_TEXT[lang][classifyCause(event.cause)];
    const label = safeLabel(event.label);
    line =
      lang === "hi"
        ? `${label ? `${label} nahi ho paya` : "Ye nahi ho paya"}: ${cause}. Dobara try karu?`
        : `${label ? `I couldn't finish ${label}` : "That didn't work"}: ${cause}. Want me to try again?`;
  }
  return deliver(ctx, "alert", line, { hold: true });
}

function finished(
  event: Extract<NarrateEvent, { kind: "done" }>,
  ctx: NarrateContext,
): NarrateResult {
  const { memory, lang } = ctx;
  if (memory.done.has(event.taskId)) return QUIET;
  memory.done.add(event.taskId);
  const fixed = FIXED[lang];
  const label = safeLabel(event.label);
  const generic = (note: boolean): string => {
    const base = label
      ? lang === "hi"
        ? `${label} ho gaya.`
        : `${label} is done.`
      : (fixed.doneGeneric[0] ?? "");
    return note ? `${base} ${fixed.detailsOnScreen}` : base;
  };
  let line: string;
  if (ctx.sensitive) line = pick(fixed.sensitiveDone, memory);
  else {
    const answer = String(event.answer ?? "");
    const scrubbed = scrub(answer);
    const first = completionLine(scrubbed.text, DONE_MAX).replace(/:$/u, ".");
    if (!first.replace(/[\s]/g, "")) line = generic(scrubbed.removed);
    else if (first.includes(SECRET_MARK)) line = pick(fixed.sensitiveDone, memory);
    else if (first.includes(CODE_MARK) || unsafeLine(first)) line = generic(true);
    else line = first.replace(/\s+/g, " ").trim();
    if (!speakable(line)) line = generic(true);
  }
  return deliver(ctx, "alert", line, { done: true, hold: true });
}

/** One event in, at most one line out. Changes only `ctx.memory`. */
export function narrate(event: NarrateEvent, ctx: NarrateContext): NarrateResult {
  switch (event.kind) {
    case "ack":
      return ack(event, ctx);
    case "progress":
      return progress(event, ctx);
    case "rollup":
      return rollup(ctx);
    case "needs-approval":
    case "needs-input":
      return approval(event, ctx);
    case "failed":
      return failed(event, ctx);
    case "done":
      return finished(event, ctx);
    case "settled":
      ctx.memory.progress.delete(event.taskId);
      ctx.memory.approvals.delete(event.taskId);
      return QUIET;
  }
}

/* ---------- digests (text, never spoken at the time) ---------- */

/** Lines kept while a call or quiet hours held speech, as one text, once. Null when nothing was held. */
export function holdDigest(
  memory: NarrationMemory,
  lang: NarrationLang,
): { count: number; text: string } | null {
  if (!memory.held.length) return null;
  const lines = memory.held.splice(0, memory.held.length);
  const head = lang === "hi" ? "Aapke busy hone par: " : "While you were busy: ";
  return { count: lines.length, text: `${head}${lines.join(" ")}` };
}

/** What to say, once, for finish lines that aged out of the speech queue unsaid. */
export function digestLine(
  info: { count: number; sensitive: number },
  lang: NarrationLang,
): string | null {
  const n = Math.floor(info.count);
  if (!(n > 0)) return null;
  if (lang === "hi") return `Aapke busy hone par ${n} kaam khatam hue. ${FIXED.hi.detailsOnScreen}`;
  return `While you were busy, ${n === 1 ? "one task" : `${n} tasks`} finished. ${FIXED.en.detailsOnScreen.replace("The details are", "Details are")}`;
}
