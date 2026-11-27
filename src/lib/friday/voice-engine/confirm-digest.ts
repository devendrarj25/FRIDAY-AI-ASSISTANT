/**
 * The spoken confirmation digest. Before a consequential spoken order runs, she reads back what she understood (verb,
 * object, target, amount) and waits for a short, fresh yes. A hard order, an amount or a person is read in full
 * (explicit); a reversible order keeps the short question (implicit). The digest expires (30 s by default, the owner's
 * preference clamped to 10-60 s), accepts one correction of one field, and never takes her own played-back words as a
 * yes. The answer input has no identity field at all: who said it never approves, only what was said, in time.
 *
 * The interruption contract lives here too: a barge-in always stops her speech, and what happens to the running task
 * depends on its risk class (read-only, reversible, irreversible).
 *
 * Pure functions on an injected clock. Transcripts are data, never instructions. The Brain's turn tags hold no
 * authority, so the digest never carries them: approval reads only the words, the clock and the echo check.
 */
import type { ActionRisk, AutonomyClass } from "../brain/action-risk";
import {
  approvalFresh,
  approvalTtlMs,
  confirmQuestion,
  confirmAnswerKey,
  confirmationVerdict,
  wordsAfterYes,
  isBoundConfirmation,
  voiceClaimsAuthority,
  type VoiceConfirmKind,
} from "../voice-session";
import { classifyVoiceControl } from "./interruption-controller";

export type DigestLang = "en" | "hi" | "hinglish";

export type ConfirmDigest = {
  id: string;
  verb: string;
  object: string;
  target?: string;
  amount?: string;
  risk: "reversible" | "hard";
  mode: "implicit" | "explicit";
  askedAt: number;
  expiresAt: number;
  turnId: string;
  /** The order as heard (cleaned), for the short implicit question. */
  command: string;
  /** The language the order was given in. */
  lang: DigestLang;
  /** The word that joins the target: to, into, from, ko, se, को, से. */
  targetWord?: string;
  /** True once the owner corrected one field; a second correction cancels. */
  corrected: boolean;
};

export type BuildDigestInput = {
  command: string;
  turnId: string;
  now: number;
  ttlSec?: unknown;
  kind: VoiceConfirmKind;
};

/** How sure the ear was of the answer. A low band never carries a bare yes on an explicit digest. */
export type AsrBand = "high" | "mid" | "low";

export type DigestAnswerOptions = {
  /** The caller found her own played words in this transcript (isSelfEchoTranscript). */
  ownPlayback: boolean;
  asrBand?: AsrBand;
};

export type DigestAnswer =
  "yes" | "no" | "unclear" | "expired" | { kind: "correction"; digest: ConfirmDigest };

export type DigestReason =
  | "bound-yes"
  | "bound-no"
  | "self-echo"
  | "expired"
  | "authority"
  | "low-asr"
  | "correction"
  | "second-correction"
  | "too-long"
  | "not-an-answer"
  | "mismatch";

export type CorrectionResult =
  { kind: "correction"; digest: ConfirmDigest } | { kind: "cancel"; reason: "second-correction" };

const DEVANAGARI_DIGITS = /[०-९]/g;
const DEVANAGARI = /[ऀ-ॿ]/;
const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`;
const UNIT = String.raw`rupees?|rupaye|rupaiye|rupay|rs\.?|inr|रुपये|रुपए|रुपया|dollars?|usd|%|percent|pratishat|प्रतिशत|gb|mb|kb|tb`;
const NUMBER_THEN_UNIT = new RegExp(
  `(?<![\\p{L}\\p{N}])(${NUMBER})\\s*(${UNIT})(?![\\p{L}])`,
  "iu",
);
const UNIT_THEN_NUMBER = new RegExp(`(?<![\\p{L}])(₹|rs\\.?|inr|\\$|usd)\\s*(${NUMBER})`, "iu");
const BARE_AMOUNT = new RegExp(
  `^(${NUMBER})\\s*(${UNIT})?(?:\\s+(?:kar do|kardo|karo|kar de|कर दो|करो))?$`,
  "iu",
);

const HINGLISH_MARK =
  /(?<![\p{L}])(?:ko|se|karo|kardo|bhejo|bhej|hatao|mitao|chalao|kholo|rupaye|rupaiye|nahi|dena|dijiye|kar do|bhej do|de do)(?![\p{L}])/iu;
/** Helper verbs that close a Hindi or Hinglish order: the content verb before them belongs to the verb. */
const AUX = new Set([
  "do",
  "de",
  "dena",
  "karo",
  "kar",
  "kardo",
  "dijiye",
  "dijie",
  "na",
  "दो",
  "दे",
  "करो",
  "कर",
  "दीजिए",
]);
const POSTPOSITION = new Set(["ko", "se", "को", "से"]);
const TRANSFER_VERB = /bhej|transfer|pay|send|forward|share|call|message|de do|dedo|भेज|दे दो/iu;
const ENGLISH_TARGET_WORD = new Set(["to", "into", "onto", "from"]);
const THING_WORD =
  /(?<![\p{L}])(?:folder|folders|file|files|drive|disk|directory|desktop|documents|downloads|trash|bin|usb|cloud|backup|archive|फ़ोल्डर|फोल्डर|फाइल|ड्राइव)(?![\p{L}])/iu;
const DETERMINER =
  /^(?:the|my|a|an|this|that|your|our|his|her|their|mere|meri|mera|ye|yeh|is|us|wo|woh|मेरे|मेरी|मेरा|ये|इस|उस)$/iu;
const LEAD =
  /^(?:please|hey friday|friday|can you|could you|would you|will you|kya aap|kya tum)[\s,]+/iu;
/** The tail of her own prompt: a transcript that repeats it is her own voice coming back. */
const OWN_PROMPT_TAIL = /say yes to confirm|pakka\?? haan boliye|हाँ बोलिए/iu;

let sequence = 0;

function newId(now: number): string {
  sequence += 1;
  return `cd-${Math.max(0, Math.floor(now)).toString(36)}-${sequence}`;
}

function normalise(text: string): string {
  return String(text ?? "")
    .normalize("NFC")
    .replace(DEVANAGARI_DIGITS, (d) => String(d.charCodeAt(0) - 0x0966))
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCommand(text: string): string {
  let value = normalise(text);
  for (let i = 0; i < 3 && LEAD.test(value); i++) value = value.replace(LEAD, "");
  return value.replace(/[?.!।]+$/u, "").trim();
}

function canonicalUnit(raw: string): string {
  const unit = raw.toLowerCase().replace(/\.$/, "");
  if (/^(?:rupees?|rupaye|rupaiye|rupay|rs|inr|₹|रुपये|रुपए|रुपया)$/u.test(unit)) return "rupees";
  if (/^(?:dollars?|usd|\$)$/u.test(unit)) return "dollars";
  if (/^(?:%|percent|pratishat|प्रतिशत)$/u.test(unit)) return "percent";
  return unit.toUpperCase();
}

function digits(raw: string): string {
  return raw.replace(/,/g, "");
}

/** Pull the amount out of the order: the canonical "5000 rupees" and the order without it. */
function takeAmount(text: string): { amount?: string; rest: string } {
  const unitLast = NUMBER_THEN_UNIT.exec(text);
  if (unitLast?.[1] && unitLast[2]) {
    return {
      amount: `${digits(unitLast[1])} ${canonicalUnit(unitLast[2])}`,
      rest: text.replace(unitLast[0], " ").replace(/\s+/g, " ").trim(),
    };
  }
  const unitFirst = UNIT_THEN_NUMBER.exec(text);
  if (unitFirst?.[1] && unitFirst[2]) {
    return {
      amount: `${digits(unitFirst[2])} ${canonicalUnit(unitFirst[1])}`,
      rest: text.replace(unitFirst[0], " ").replace(/\s+/g, " ").trim(),
    };
  }
  return { rest: text };
}

function languageOf(text: string): DigestLang {
  if (DEVANAGARI.test(text)) return "hi";
  return HINGLISH_MARK.test(text) ? "hinglish" : "en";
}

function stripEdge(value: string): string {
  return value.replace(/^[\s,;:]+|[\s,;:.?!।]+$/gu, "").trim();
}

type Parts = { verb: string; object: string; target?: string; targetWord?: string };

function parseEnglish(text: string): Parts {
  const words = text.split(" ").filter(Boolean);
  const verb = (words[0] ?? "").toLowerCase();
  let at = -1;
  for (let i = words.length - 1; i >= 1; i--) {
    if (ENGLISH_TARGET_WORD.has((words[i] ?? "").toLowerCase())) {
      at = i;
      break;
    }
  }
  if (at < 0) return { verb, object: stripEdge(words.slice(1).join(" ")) };
  const object = stripEdge(words.slice(1, at).join(" "));
  const target = stripEdge(words.slice(at + 1).join(" "));
  if (!target) return { verb, object };
  return { verb, object, target, targetWord: (words[at] ?? "").toLowerCase() };
}

function parseIndic(text: string): Parts {
  const words = text.split(" ").filter(Boolean);
  let start = words.length - 1;
  while (start > 0 && AUX.has((words[start] ?? "").toLowerCase())) start -= 1;
  const verb = words.slice(Math.max(0, start)).join(" ");
  const before = words.slice(0, Math.max(0, start));
  const at = before.findIndex((w, i) => i > 0 && POSTPOSITION.has(w.toLowerCase()));
  if (at > 0) {
    const word = (before[at] ?? "").toLowerCase();
    const isSource = word === "se" || word === "से";
    if (isSource || TRANSFER_VERB.test(verb)) {
      const target = stripEdge(before[at - 1] ?? "");
      const object = stripEdge([...before.slice(0, at - 1), ...before.slice(at + 1)].join(" "));
      if (target) return { verb, object, target, targetWord: word };
    }
  }
  return { verb, object: stripEdge(before.join(" ")) };
}

function isPersonTarget(target: string | undefined, targetWord: string | undefined): boolean {
  if (!target || !targetWord) return false;
  if (!["to", "ko", "को"].includes(targetWord)) return false;
  if (THING_WORD.test(target) || /\d/.test(target)) return false;
  const first = target.split(" ")[0] ?? "";
  return !DETERMINER.test(first);
}

function modeOf(hard: boolean, amount: string | undefined, target?: string, targetWord?: string) {
  return hard || Boolean(amount) || isPersonTarget(target, targetWord) ? "explicit" : "implicit";
}

/** Build the digest of one spoken order. The caller passes the kind (voiceConfirmKind) and the expiry preference. */
export function buildConfirmDigest(input: BuildDigestInput): ConfirmDigest {
  const command = cleanCommand(input.command);
  const lang = languageOf(command);
  const { amount, rest } = takeAmount(command);
  const parts = lang === "en" ? parseEnglish(rest) : parseIndic(rest);
  const hard = input.kind === "irreversible";
  return {
    id: newId(input.now),
    verb: parts.verb,
    object: parts.object,
    ...(parts.target ? { target: parts.target } : {}),
    ...(parts.targetWord && parts.target ? { targetWord: parts.targetWord } : {}),
    ...(amount ? { amount } : {}),
    risk: hard ? "hard" : "reversible",
    mode: modeOf(hard, amount, parts.target, parts.targetWord),
    askedAt: input.now,
    expiresAt: input.now + approvalTtlMs(input.ttlSec),
    turnId: input.turnId,
    command,
    lang,
    corrected: false,
  };
}

/** Indian grouping, fixed and locale-free: 5000 -> 5,000; 500000 -> 5,00,000. */
function grouped(value: string): string {
  const [whole = "", fraction] = value.split(".");
  const tail = whole.slice(-3);
  const head = whole.slice(0, -3).replace(/\B(?=(\d{2})+$)/g, ",");
  const joined = head ? `${head},${tail}` : tail;
  return fraction ? `${joined}.${fraction}` : joined;
}

const UNIT_WORDS: Record<DigestLang, Record<string, string>> = {
  en: { rupees: "rupees", dollars: "dollars", percent: "percent" },
  hinglish: { rupees: "rupaye", dollars: "dollar", percent: "percent" },
  hi: { rupees: "रुपये", dollars: "डॉलर", percent: "प्रतिशत" },
};

function spokenAmount(amount: string | undefined, lang: DigestLang): string {
  if (!amount) return "";
  const [value = "", unit = ""] = amount.split(" ");
  return `${grouped(value)} ${UNIT_WORDS[lang][unit] ?? unit}`.trim();
}

function spokenTargetWord(word: string | undefined, lang: DigestLang): string {
  const w = (word ?? "to").toLowerCase();
  const source = w === "from" || w === "se" || w === "से";
  if (lang === "en") {
    if (source) return "from";
    return w === "into" || w === "onto" ? w : "to";
  }
  if (lang === "hinglish") return source ? "se" : "ko";
  return source ? "से" : "को";
}

function capital(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

/**
 * The line she speaks. Implicit: the short question. Explicit: the whole digest (verb, amount, object, target) and the
 * ask, in the owner's language.
 */
export function digestLine(d: ConfirmDigest, lang: DigestLang = d.lang): string {
  if (d.mode === "implicit") return confirmQuestion(d.command);
  const amount = spokenAmount(d.amount, lang);
  const join = spokenTargetWord(d.targetWord, lang);
  if (lang === "en") {
    const target = d.target ? `${join} ${d.target}` : "";
    const said = [capital(d.verb), amount, d.object, target].filter(Boolean).join(" ");
    return `${said}. Say yes to confirm.`;
  }
  const target = d.target ? `${d.target} ${join}` : "";
  const said = [target, amount, d.object, d.verb].filter(Boolean).join(" ");
  return lang === "hi" ? `${said}. पक्का? हाँ बोलिए।` : `${said}. Pakka? Haan boliye.`;
}

const CORRECTION_LEAD =
  /^(?:no|nope|nah|not|nahi|nahin|nhi|नहीं|नही|yes|yeah|haan|ha|actually|wait|sorry|instead|balki|बल्कि)(?![\p{L}])[\s,.:;!-]*/iu;
const MAKE_IT = /^(?:make it|make that|change it to|change that to|change to|instead)\s+(.+)$/iu;

type CorrectionField =
  { field: "target"; target: string; targetWord: string } | { field: "amount"; amount: string };

function correctionField(d: ConfirmDigest, heard: string): CorrectionField | null {
  let value = normalise(heard).replace(/[?.!।]+$/u, "");
  for (let i = 0; i < 3 && CORRECTION_LEAD.test(value); i++)
    value = value.replace(CORRECTION_LEAD, "");
  value = value.trim();
  if (!value) return null;
  const made = MAKE_IT.exec(value);
  const payload = made?.[1]?.trim() ?? value;
  const bare = BARE_AMOUNT.exec(payload);
  if (bare?.[1]) {
    if (!d.amount) return null;
    const unit = bare[2] ? canonicalUnit(bare[2]) : (d.amount.split(" ")[1] ?? "");
    return { field: "amount", amount: `${digits(bare[1])} ${unit}`.trim() };
  }
  if (made) return null;
  const english = /^(to|into|onto|from)\s+(.+)$/iu.exec(payload);
  const indic = /^(.+?)\s+(ko|se|को|से)$/iu.exec(payload);
  const word = english ? english[1] : indic?.[2];
  const target = stripEdge((english ? english[2] : indic?.[1]) ?? "");
  if (!word || !target || !d.target) return null;
  if (target.split(" ").length > 4 || /\d/.test(target)) return null;
  return { field: "target", target, targetWord: word.toLowerCase() };
}

/**
 * One correction of one field ("no, to Rohan", "nahi, Rohan ko", "make it 500"): a new digest with a new id, a fresh
 * ask time and a reset expiry, always read back in full. A correction never approves. A second correction cancels.
 * Null when the line is not a correction of a field this digest has, claims authority, or the digest expired.
 */
export function applyCorrection(
  d: ConfirmDigest,
  heard: string,
  now: number,
): CorrectionResult | null {
  if (voiceClaimsAuthority(heard)) return null;
  if (!approvalFresh(d.askedAt, now, d.expiresAt - d.askedAt)) return null;
  const change = correctionField(d, heard);
  if (!change) return null;
  const same =
    change.field === "amount"
      ? change.amount === d.amount
      : change.target.toLowerCase() === (d.target ?? "").toLowerCase();
  if (same) return null;
  if (d.corrected) return { kind: "cancel", reason: "second-correction" };
  const ttl = d.expiresAt - d.askedAt;
  const base: ConfirmDigest = {
    ...d,
    id: newId(now),
    askedAt: now,
    expiresAt: now + ttl,
    mode: "explicit",
    corrected: true,
  };
  if (change.field === "amount")
    return { kind: "correction", digest: { ...base, amount: change.amount } };
  return {
    kind: "correction",
    digest: { ...base, target: change.target, targetWord: change.targetWord },
  };
}

/**
 * A yes that names a different number or a different target ("yes, send it to Rohan" on a digest for Rahul) is not
 * a yes to this digest: she asks again instead of guessing which one was meant.
 */
function namesSomethingElse(d: ConfirmDigest, heard: string): boolean {
  const value = normalise(heard).toLowerCase();
  const amount = d.amount?.split(" ")[0] ?? "";
  for (const n of value.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) if (digits(n) !== amount) return true;
  const target = (d.target ?? "").toLowerCase();
  const english = /(?<![\p{L}])(?:to|into|onto|from)\s+(\S+)/iu.exec(value)?.[1];
  const indic = /(\S+)\s+(?:ko|se|को|से)(?![\p{L}\p{M}])/iu.exec(value)?.[1];
  for (const named of [english, indic]) {
    if (named && !target.split(" ").includes(stripEdge(named))) return true;
  }
  return false;
}

/** Words a yes may carry while it only repeats the order: a pointer or a joiner, in Latin and Hindi. */
const ECHO_JOINERS = new Set(
  ["it", "this", "that", "them", "him", "her", "to", "the", "now", "ko", "abhi", "को", "अभी"].map(
    confirmAnswerKey,
  ),
);

/**
 * A yes to this digest: the allowlisted yes on its own, or a leading yes whose other words name only this digest's
 * own verb, object, target and amount ("yes send it to Rahul", "yes 5000"). A different name or number is caught by
 * `namesSomethingElse`; any other word, and any no word, keeps it from being a yes.
 */
function yesToThisDigest(d: ConfirmDigest, heard: string): boolean {
  if (confirmationVerdict(heard) === "yes") return true;
  const rest = wordsAfterYes(heard);
  if (!rest?.length) return false;
  const own = new Set(
    confirmAnswerKey([d.verb, d.object, d.target ?? "", d.amount ?? ""].join(" "))
      .split(" ")
      .filter(Boolean),
  );
  return rest.every((w) => own.has(w) || ECHO_JOINERS.has(w) || /^\d+$/.test(w));
}

/** The answer to a digest, with the reason. Only a short, fresh, bound yes that is not her own voice approves. */
export function explainDigestAnswer(
  d: ConfirmDigest,
  heard: string,
  now: number,
  options: DigestAnswerOptions,
): { answer: DigestAnswer; reason: DigestReason } {
  const text = String(heard ?? "");
  if (options.ownPlayback || OWN_PROMPT_TAIL.test(normalise(text))) {
    return { answer: "unclear", reason: "self-echo" };
  }
  if (!approvalFresh(d.askedAt, now, d.expiresAt - d.askedAt))
    return { answer: "expired", reason: "expired" };
  if (voiceClaimsAuthority(text)) return { answer: "unclear", reason: "authority" };
  const correction = applyCorrection(d, text, now);
  if (correction?.kind === "cancel") return { answer: "no", reason: "second-correction" };
  if (correction) return { answer: correction, reason: "correction" };
  // A yes that goes on to name another person or number asks again; a yes with any other extra word is no answer.
  const leadsWithYes = isBoundConfirmation(text, (value) => wordsAfterYes(value) !== null);
  if (leadsWithYes && namesSomethingElse(d, text)) return { answer: "unclear", reason: "mismatch" };
  if (leadsWithYes && yesToThisDigest(d, text)) {
    if (d.mode === "explicit" && options.asrBand === "low")
      return { answer: "unclear", reason: "low-asr" };
    return { answer: "yes", reason: "bound-yes" };
  }
  if (isBoundConfirmation(text, (value) => confirmationVerdict(value) === "no")) {
    return { answer: "no", reason: "bound-no" };
  }
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return { answer: "unclear", reason: words > 6 ? "too-long" : "not-an-answer" };
}

export function digestAnswer(
  d: ConfirmDigest,
  heard: string,
  now: number,
  options: DigestAnswerOptions,
): DigestAnswer {
  return explainDigestAnswer(d, heard, now, options).answer;
}

/* ---- Interruption contract ---- */

export type TaskRiskClass = "read-only" | "reversible" | "irreversible";

const RISK_RANK: Record<TaskRiskClass, number> = { "read-only": 0, reversible: 1, irreversible: 2 };

/** Every risk vocabulary in FRIDAY folded to three classes. Anything unknown is irreversible. */
export function riskClassOf(x: AutonomyClass | ActionRisk | VoiceConfirmKind): TaskRiskClass {
  switch (x) {
    case "read":
    case "background":
    case "safe":
    case "none":
      return "read-only";
    case "reversible":
    case "write":
    case "broad":
    case "caution":
      return "reversible";
    default:
      return "irreversible";
  }
}

/** The strictest class wins; no task at all is read-only. */
export function strictest(classes: readonly TaskRiskClass[]): TaskRiskClass {
  let worst: TaskRiskClass = "read-only";
  for (const c of classes) {
    const known = c in RISK_RANK ? c : "irreversible";
    if (RISK_RANK[known] > RISK_RANK[worst]) worst = known;
  }
  return worst;
}

/** The owner said to cancel the task itself ("cancel the task", "kaam band karo"), not only to stop talking. */
export function ownerSaidCancelTask(heard: string): boolean {
  return classifyVoiceControl(heard).kind === "cancel-task";
}

export type BargeInPlan = {
  stopSpeech: true;
  cancelTask: boolean;
  runToCheckpoint: boolean;
  undoJournal: boolean;
};

/**
 * A barge-in always stops her speech. A read-only or reversible task is cancelled (reversible work is journalled so
 * it can be undone). An irreversible task is cancelled only on an explicit cancel, and in every case runs to its next
 * checkpoint instead of stopping halfway, with its undo journal kept.
 */
export function onBargeIn(risk: TaskRiskClass, ownerSaidCancel: boolean): BargeInPlan {
  const hard = risk !== "read-only" && risk !== "reversible";
  return {
    stopSpeech: true,
    cancelTask: !hard || ownerSaidCancel,
    runToCheckpoint: hard,
    undoJournal: risk !== "read-only",
  };
}
