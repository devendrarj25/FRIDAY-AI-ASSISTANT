/**
 * FRIDAY · utterance router: what one thing the owner just said is for.
 *
 * Pure and deterministic. One function, `routeUtterance`, reads the text, the clock and a snapshot of the task
 * desk and names ONE route. The conductor acts on it; nothing here speaks, cancels or starts anything. Order of
 * the rules (the first that fits wins):
 *   a. a short, bound yes or no for the prompt she last spoke        -> approval-answer
 *   b. a pure stop word (speech and the foreground reply only)       -> stop-speech
 *   c. a task word (cancel, pause, resume, status, more detail,
 *      repeat, cancel all) with a spoken name, an ordinal or "the
 *      last one"; more than one candidate returns `ambiguous`        -> task-control / status
 *   d. a short harmless question, at ANY task age                    -> side-question
 *   e. an irreversible or cautious order (voiceNeedsConfirmation)    -> new-task, needsConfirm
 *   f. any other order                                               -> new-task
 *   g. change-of-mind words ("actually", "instead", "rukko") in front
 *      of an order replace the newest task started in the last 20 s  -> new-task with `supersedes`
 * Greetings, thanks and following-along sounds are `chitchat`; everything else is the ordinary `foreground-turn`.
 * A yes never approves anything here: the route only says the owner answered, and the approval path decides.
 * English, Hindi (Devanagari) and Hinglish (Roman) phrases are all read; nothing is transliterated.
 */
import { quickLaneEligible } from "../brain/quick-lane";
import {
  approvalFresh,
  confirmationVerdict,
  isBoundConfirmation,
  isFollowingAlong,
  isHoldSound,
  voiceNeedsConfirmation,
} from "../voice-session";
import type { ApprovalLevel } from "../self/autonomy";
import { parseBackgroundRequest } from "./background-request";
import {
  SAFETY_COMMANDS,
  matchCommand,
  type CommandContext,
  type CommandHit,
} from "./command-lane";
import { classifyVoiceControl, isBackchannel } from "./interruption-controller";
import { TERMINAL, type TaskState } from "./task-orchestrator";

/** A change of mind replaces a task only if it began this recently (inclusive). */
export const SUPERSEDE_WINDOW_MS = 20_000;
/** A control sentence is short; longer text is never read for task words. */
const CONTROL_MAX_TOKENS = 14;

export type RouteKind =
  | "approval-answer"
  | "stop-speech"
  | "task-control"
  | "status"
  | "side-question"
  | "new-task"
  | "foreground-turn"
  | "chitchat";

export type TaskAction =
  "cancel" | "pause" | "resume" | "status" | "detail" | "repeat" | "cancel-all";

export type TaskRef = { taskId: string } | { all: true };

export type Route = {
  kind: RouteKind;
  action?: TaskAction;
  ref?: TaskRef;
  /** More than one task fits: the conductor asks one short question and offers `candidates`. */
  ambiguous?: true;
  candidates?: string[];
  /** The owner's answer to the open prompt. */
  verdict?: "yes" | "no";
  /** A consequential order: ask before doing it. */
  needsConfirm?: true;
  /** The owner said it in the background words ("in the background"). */
  background?: true;
  /** The newest recent task this order replaces. */
  supersedes?: string;
  /** "stop listening": the stop also ends the listening session. */
  stopListening?: true;
  /** Why, for tests, the audit trail and the conductor's small decisions. */
  reason: string;
};

export type RouterTask = { id: string; label: string; state: TaskState; createdAt: number };

export type RouterInput = {
  text: string;
  now: number;
  /** The tasks the Tasks panel shows: live ones and the recently finished. */
  tasks: readonly RouterTask[];
  /** The approval prompt she spoke last and nothing since; null or absent when none is open. */
  pendingApproval?: { askedAt: number; taskId?: string | undefined } | null | undefined;
  /** The task she just spoke about, for "that one" and a bare "more detail". */
  focusTaskId?: string | undefined;
  /** A task or a foreground reply is running. */
  busy: boolean;
  hasExtra?: boolean | undefined;
  /** How often she asks first (the autonomy dial, adjusted by the owner's confirm level). Balanced when absent. */
  approvalLevel?: ApprovalLevel | undefined;
};

/* ---------- text ---------- */

const B = "(?<![\\p{L}\\p{M}\\p{N}_])";
const E = "(?![\\p{L}\\p{M}\\p{N}_])";
/** A whole-word pattern that also works for Devanagari, where `\b` does not. */
const w = (source: string): RegExp => new RegExp(`${B}(?:${source})${E}`, "iu");
const lead = (source: string): RegExp => new RegExp(`^(?:${source})${E}`, "iu");

const norm = (text: string): string =>
  String(text ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{M}\p{N}'\s]+/gu, " ")
    .replace(/(^|\s)'+|'+(?=\s|$)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (text: string): string[] => (text ? text.split(" ") : []);

/** "hey friday, ..." is addressing, not content. */
const stripAddress = (text: string): string =>
  text.replace(/^(?:(?:hey|hi|ok|okay)\s+)?friday\b\s*/u, "").replace(/\s+friday$/u, "");

/* ---------- (a) answers to the prompt she last spoke ---------- */

const DEV_NO = w("नहीं|नही|मत|रहने दो|रहने दें|छोड़ दो|ना");
const DEV_YES = w("हाँ|हां|हा|जी|ठीक है|बिल्कुल|करो|कर दो|चलाओ|ओके");

function verdictOf(text: string): "yes" | "no" | "unclear" {
  const base = confirmationVerdict(text);
  if (base !== "unclear") return base;
  const value = norm(text);
  if (DEV_NO.test(value)) return "no";
  if (DEV_YES.test(value)) return "yes";
  return "unclear";
}

/** Words that mean "be quiet", not "no": they silence her and leave the prompt open. */
const STOP_TOKENS = new Set(
  (
    "stop it please pls ruk ruko rukiye rukko jao ja zara jara bas karo kar do wait hold on quiet silence chup ho raho shant " +
    "thoda ek a minute second friday ji now रुको रुक रुकिए बस चुप शांत करो जाओ हो रहो ज़रा जरा"
  ).split(" "),
);
const isPureStop = (value: string): boolean => {
  const list = tokens(stripAddress(value));
  return list.length > 0 && list.every((token) => STOP_TOKENS.has(token));
};

/* ---------- (c) task words ---------- */

const TASK_NOUN = w("tasks?|jobs?|kaam|kam|work|background|report|टास्क|काम|रिपोर्ट");
const PRONOUN = w(
  "it|that|this|that one|this one|woh|wo|vo|usko|isko|use|ise|वो|वह|उसे|इसे|उसको|इसको",
);
const ALL = w("all|everything|every|saare|saara|sab|sabhi|सब|सारे|सभी|सारा");
const LAST = w("last|latest|newest|aakhri|aakhiri|akhri|pichla|पिछला|आखिरी|आख़िरी|आखरी");

const CANCEL_STRONG = w(
  "cancel|abort|kill|scrap|terminate|radd|hatao|hata do|hata dena|hata|रद्द|कैंसल|हटाओ|हटा दो",
);
const CANCEL_WEAK = w("stop|ruk|ruko|rukiye|band|drop|बंद|रुको|रुक");
const PAUSE = w("pause|hold(?! on)|rok|roko|rok do|thehro|रोक|रोको|रोक दो|ठहरो");
const RESUME = w(
  "resume|continue|carry on|jaari|jari|dobara|dubara|chalu|restart|shuru|जारी|दोबारा|फिर से|चालू|शुरू",
);
const REPEAT = w(
  "repeat|say (?:that|it) again|once more|(?:dobara|dubara|phir se|fir se) bol[\\p{L}\\p{M}]*|kya kaha|kya bola|what did you say|(?:दोबारा|फिर से) बोल[\\p{L}\\p{M}]*|दोहराओ",
);
const DETAIL = w(
  "more details?|in detail|details?|elaborate|explain|tell me more|aur batao|aur detail|detail me|detail mein|vistar|और बताओ|और विस्तार|विस्तार से|डिटेल",
);
const STATUS_SELF = w(
  "status|progress|what are you doing|what are you working on|are you done|is it done|kya kar rahi ho|kya kar raha hai|kya kar rahe ho|kya ho raha hai|kitna hua|kitna ho gaya|kahan tak|kab tak|स्थिति|क्या हो रहा|क्या कर रही|क्या कर रहे|कितना हुआ|कहाँ तक|कहां तक",
);
const STATUS_NEEDS_REF = w("how is|how'?s|hows|done yet|ho gaya|hua kya|kya hua|क्या हुआ|हो गया");

const NUM_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  paanch: 5,
  panch: 5,
  एक: 1,
  दो: 2,
  तीन: 3,
  चार: 4,
  पांच: 5,
  पाँच: 5,
};
const ORD_WORDS: Record<string, number> = {
  first: 1,
  "1st": 1,
  second: 2,
  "2nd": 2,
  third: 3,
  "3rd": 3,
  fourth: 4,
  "4th": 4,
  fifth: 5,
  "5th": 5,
  pehla: 1,
  pehle: 1,
  pehli: 1,
  pahla: 1,
  pahle: 1,
  pahli: 1,
  doosra: 2,
  dusra: 2,
  doosre: 2,
  dusre: 2,
  doosri: 2,
  dusri: 2,
  teesra: 3,
  tisra: 3,
  teesre: 3,
  teesri: 3,
  chautha: 4,
  chauthe: 4,
  paanchva: 5,
  पहला: 1,
  पहले: 1,
  पहली: 1,
  दूसरा: 2,
  दूसरे: 2,
  दूसरी: 2,
  तीसरा: 3,
  तीसरे: 3,
  तीसरी: 3,
  चौथा: 4,
  पाँचवां: 5,
};
const NOUN_THEN_NUMBER = new RegExp(
  `${B}(?:tasks?|jobs?|kaam|number|no|nambar|टास्क|काम|नंबर)\\s+(\\d+|${Object.keys(NUM_WORDS).join("|")})${E}`,
  "iu",
);
const NUMBER_THEN_NOUN = new RegExp(
  `${B}(\\d+|${Object.keys(NUM_WORDS).join("|")})\\s+(?:number|no|nambar|नंबर)${E}`,
  "iu",
);

function ordinalOf(value: string): number | undefined {
  const count = (raw: string): number => (/^\d+$/.test(raw) ? Number(raw) : (NUM_WORDS[raw] ?? 0));
  const near = NOUN_THEN_NUMBER.exec(value) ?? NUMBER_THEN_NOUN.exec(value);
  if (near?.[1]) return count(near[1]);
  for (const token of tokens(value)) {
    const n = ORD_WORDS[token];
    if (n) return n;
  }
  return undefined;
}

const LABEL_STOP = new Set(
  "the and for with from into this that task tasks please kaam work job jobs background cancel pause resume stop".split(
    " ",
  ),
);
const stem = (token: string): string =>
  token.length > 5 ? token.replace(/(?:ing|ed|es|s)$/u, "") : token;
const labelTokens = (label: string): string[] =>
  tokens(norm(label))
    .filter((t) => t.length >= 3 && !LABEL_STOP.has(t))
    .map(stem);

const FILLER = new Set(
  (
    "the a an please pls it that this one me my of to ko ka ki ke kar karo do de dena zara jara ek ji friday wala wali wale " +
    "task tasks kaam job work background hey ok okay now abhi plz tell more detail details in aur batao bolo say and then " +
    "वाला वाली वाले को का की के कर करो दो टास्क काम"
  ).split(" "),
);

function eligible(action: TaskAction, task: RouterTask): boolean {
  if (action === "cancel" || action === "cancel-all") return !TERMINAL.includes(task.state);
  if (action === "pause") return ["RUNNING", "QUEUED", "CREATED"].includes(task.state);
  if (action === "resume") return task.state === "PAUSED";
  return true;
}

type Detected = {
  action: TaskAction;
  /** The phrase that was matched, taken out before looking for what is left over. */
  verb: RegExp;
  /** The words need a reference (task word, name, ordinal) to count as a control. */
  needsRef: boolean;
};

function detectAction(value: string, count: number): Detected | null {
  if (ALL.test(value) && (CANCEL_STRONG.test(value) || (CANCEL_WEAK.test(value) && count <= 4))) {
    if (TASK_NOUN.test(value) || CANCEL_STRONG.test(value) || count <= 4)
      return {
        action: "cancel-all",
        verb: new RegExp(`${CANCEL_STRONG.source}|${CANCEL_WEAK.source}|${ALL.source}`, "iu"),
        needsRef: false,
      };
  }
  if (REPEAT.test(value) && count <= 6) return { action: "repeat", verb: REPEAT, needsRef: false };
  if (DETAIL.test(value)) return { action: "detail", verb: DETAIL, needsRef: true };
  if (STATUS_SELF.test(value) && count <= 7)
    return { action: "status", verb: STATUS_SELF, needsRef: false };
  if (STATUS_NEEDS_REF.test(value))
    return { action: "status", verb: STATUS_NEEDS_REF, needsRef: true };
  if (RESUME.test(value)) return { action: "resume", verb: RESUME, needsRef: true };
  if (PAUSE.test(value)) return { action: "pause", verb: PAUSE, needsRef: true };
  if (CANCEL_STRONG.test(value)) return { action: "cancel", verb: CANCEL_STRONG, needsRef: true };
  if (CANCEL_WEAK.test(value)) return { action: "cancel", verb: CANCEL_WEAK, needsRef: true };
  return null;
}

type Reference = {
  noun: boolean;
  pronoun: boolean;
  ordinal: number | undefined;
  last: boolean;
  named: RouterTask[];
};

function referenceIn(value: string, tasks: readonly RouterTask[]): Reference {
  const spoken = new Set(tokens(value).map(stem));
  let best = 0;
  let named: RouterTask[] = [];
  for (const task of tasks) {
    const score = labelTokens(task.label).filter((t) => spoken.has(t)).length;
    if (score > best) {
      best = score;
      named = [task];
    } else if (score > 0 && score === best) named.push(task);
  }
  return {
    noun: TASK_NOUN.test(value),
    pronoun: PRONOUN.test(value),
    ordinal: ordinalOf(value),
    last: LAST.test(value),
    named,
  };
}

const byAge = (a: RouterTask, b: RouterTask): number => a.createdAt - b.createdAt;

function taskControl(input: RouterInput, heard: string): Route | null {
  const value = heard;
  const list = tokens(value);
  if (!list.length || list.length > CONTROL_MAX_TOKENS) return null;
  const found = detectAction(value, list.length);
  if (!found) return null;
  const sorted = [...input.tasks].sort(byAge);
  const ref = referenceIn(value, sorted);
  // "how is ..." names a task only when every word of its label was said ("how is the weather in Delhi" is not it).
  if (found.verb === STATUS_NEEDS_REF) {
    const spoken = new Set(tokens(value).map(stem));
    ref.named = ref.named.filter((t) => labelTokens(t.label).every((token) => spoken.has(token)));
  }
  const explicit = ref.ordinal !== undefined || ref.last || ref.named.length > 0;
  const anyRef = explicit || ref.noun;
  const rest = tokens(
    value.replace(new RegExp(found.verb.source, "giu"), " ").replace(/\s+/g, " ").trim(),
  );
  const bare = rest.every((token) => FILLER.has(token));
  const action = found.action;

  if (action === "cancel-all")
    return { kind: "task-control", action, ref: { all: true }, reason: "cancel-all" };
  if (action === "repeat") {
    const target = explicit ? resolveExplicit(action, ref, sorted) : null;
    return target !== null &&
      typeof target === "object" &&
      !Array.isArray(target) &&
      "taskId" in target
      ? { kind: "task-control", action, ref: target, reason: "repeat" }
      : { kind: "task-control", action, reason: "repeat" };
  }
  if (action === "status" && !explicit) {
    return found.needsRef && !ref.noun ? null : { kind: "status", reason: "status" };
  }
  if (found.needsRef && !anyRef && !(bare && (ref.pronoun || list.length <= 3))) return null;
  if (action === "detail" && !anyRef && !bare) return null;
  // A weak word ("stop", "band karo") must name a task: a bare one is a stop of speech, handled before.
  if (found.verb === CANCEL_WEAK && !anyRef) return null;

  const live = sorted.filter((t) => eligible(action, t));
  const usesFocus = ref.pronoun || action === "detail" || action === "status";
  const focus = input.focusTaskId ? sorted.find((t) => t.id === input.focusTaskId) : undefined;

  if (explicit) {
    const target = resolveExplicit(action, ref, sorted, live);
    if (target === "none") return { kind: "task-control", action, reason: "no-such-task" };
    if (Array.isArray(target)) return ambiguous(action, target);
    return { kind: "task-control", action, ref: target, reason: "named" };
  }
  if (usesFocus && focus && eligible(action, focus)) {
    return { kind: "task-control", action, ref: { taskId: focus.id }, reason: "focus" };
  }
  if (live.length === 1 && live[0]) {
    return { kind: "task-control", action, ref: { taskId: live[0].id }, reason: "only-one" };
  }
  if (live.length > 1) return ambiguous(action, live);
  // Nothing to act on. A bare "cancel" or "pause" only quiets her; a task word says there is no task.
  if (!ref.noun && (action === "cancel" || action === "pause")) {
    return { kind: "stop-speech", reason: "bare-control-no-task" };
  }
  if (!ref.noun && !explicit && (action === "resume" || action === "detail")) return null;
  return { kind: "task-control", action, reason: "no-task" };
}

function ambiguous(action: TaskAction, tasks: readonly RouterTask[]): Route {
  return {
    kind: "task-control",
    action,
    ambiguous: true,
    candidates: tasks.map((t) => t.id),
    reason: "ambiguous",
  };
}

/** An ordinal, "the last one" or a spoken name, as one task, "none", or the tasks it could be. */
function resolveExplicit(
  action: TaskAction,
  ref: Reference,
  sorted: readonly RouterTask[],
  live: readonly RouterTask[] = sorted.filter((t) => eligible(action, t)),
): TaskRef | RouterTask[] | "none" {
  if (ref.ordinal !== undefined) {
    const pick = sorted[ref.ordinal - 1];
    return pick ? { taskId: pick.id } : "none";
  }
  if (ref.last) {
    const pick = live[live.length - 1] ?? sorted[sorted.length - 1];
    return pick ? { taskId: pick.id } : "none";
  }
  const fit = ref.named.filter((t) => live.includes(t));
  const pool = fit.length ? fit : ref.named;
  if (pool.length === 1 && pool[0]) return { taskId: pool[0].id };
  return pool.length ? [...pool].sort(byAge) : "none";
}

/* ---------- small talk ---------- */

const SMALL_TALK = new RegExp(
  `^(?:hi|hello|hey|namaste|namaskar|good (?:morning|afternoon|evening|night)|thanks?(?: you)?|thank you|shukriya|dhanyavaad|dhanyavad|bye|alvida|how are you|how'?s it going|kaise ho|kaisi ho|kya haal hai|ok(?:ay)?|cool|nice|great|badhiya|sahi hai|theek hai|thik hai|achha|accha|haan|han|ji|yes|yeah|yep|नमस्ते|नमस्कार|शुक्रिया|धन्यवाद|अलविदा|कैसे हो|कैसी हो|क्या हाल है|ठीक है|अच्छा|हाँ|हां|जी|बढ़िया)${E}$`,
  "iu",
);

function isSmallTalk(value: string): boolean {
  if (!value) return true;
  return (
    SMALL_TALK.test(value) || isFollowingAlong(value) || isBackchannel(value) || isHoldSound(value)
  );
}

/* ---------- orders and a change of mind ---------- */

const ORDER_LEAD_EN = lead(
  "(?:please |kindly )?(?:open|launch|play|search|find|look up|send|write|create|make|build|set|add|remind|schedule|book|call|text|message|email|turn|switch|enable|disable|start|run|check|read|summari[sz]e|translate|draft|compose|generate|download|install|uninstall|take|capture|save|copy|move|rename|delete|remove|erase|wipe|format|list|get|fetch|bring|put|plan|research|analy[sz]e|compare|fix|update|close|mute|unmute|lock|clean|restart|shut ?down|cancel|buy|pay|order|show|dim|increase|decrease|look into|go through|go to)",
);
const ORDER_HI = w(
  "kholo|khol|chalao|chala|bhejo|bhej|likho|likh|banao|bana|dhundo|dhoondo|dhundh|dhoondh|khojo|khoj|dikhao|dikha|lagao|laga|karo|kar do|kar dena|kar de|badlo|badal|yaad dilao|hata|hatao|mita|mitao|uda|nikal|खोलो|खोल|चलाओ|चला|भेजो|भेज|लिखो|लिख|बनाओ|बना|ढूंढो|ढूंढ|खोजो|दिखाओ|दिखा|लगाओ|करो|कर दो|कर देना|बदलो|हटाओ|हटा",
);
const POLITE_EN = /^(?:please |kindly )?(?:can|could|would|will) you (?:please |kindly )?/u;
const POLITE_HI = /^kya (?:tum|aap) /u;
const POLITE_HI_TAIL = /\s(?:sakti|sakte|sakta|paogi|paoge|pa sakti|pa sakte)(?: ho| hai| hain)?$/u;
const INFO_AFTER_POLITE = lead(
  "tell|explain|say|describe|help|know|recommend|suggest|give me|what|how|why|who|where|when|bata|batao|samjha|btao",
);
const QUESTION_START = lead(
  "what|who|when|where|why|how|which|is|are|was|were|does|do|did|kya|kaun|kab|kahan|kyun|kyu|kaise|kitna|kitne|क्या|कौन|कब|कहाँ|कहां|क्यों|कैसे|कितना|कितने",
);
const CHANGE_LEAD = lead(
  "actually|instead|rather|no wait|wait no|wait|hold on|nahi nahi|nahin nahin|nahi ye|nahin ye|nahi yeh|nahi|nahin|no no|scratch that|never ?mind|forget (?:it|that)|on second thought|i mean|mera matlab|matlab|ruk+o+|ruko|arre nahi|are nahi|अरे नहीं|नहीं ये|नहीं यह|नहीं नहीं|असल में|दरअसल|बल्कि|छोड़ो",
);
const CHANGE_TAIL = /\s(?:instead|iske bajay|इसके बजाय)$/u;

/** Change-of-mind words taken off the front (and a trailing "instead"). */
export function stripChange(value: string): { changed: boolean; rest: string } {
  let rest = value;
  let changed = false;
  for (let i = 0; i < 4; i += 1) {
    const hit = CHANGE_LEAD.exec(rest);
    if (!hit) break;
    rest = rest.slice(hit[0].length).replace(/^\s+/, "");
    changed = true;
  }
  if (CHANGE_TAIL.test(rest)) {
    rest = rest.replace(CHANGE_TAIL, "");
    changed = true;
  }
  return { changed, rest: rest.trim() };
}

type OrderRead = { order: boolean; consequential: boolean; background: boolean };

function readOrder(raw: string, value: string, level: ApprovalLevel): OrderRead {
  const background = parseBackgroundRequest(raw) !== null;
  let body = value;
  let polite = false;
  if (POLITE_EN.test(body)) {
    body = body.replace(POLITE_EN, "");
    polite = !INFO_AFTER_POLITE.test(body);
    if (!polite) return { order: false, consequential: false, background };
  } else if (POLITE_HI.test(body)) {
    body = body.replace(POLITE_HI, "").replace(POLITE_HI_TAIL, "");
    polite = true;
  }
  const question = !polite && (raw.trim().endsWith("?") || QUESTION_START.test(value));
  const order =
    background || (!question && (polite || ORDER_LEAD_EN.test(body) || ORDER_HI.test(body)));
  return { order, consequential: order && voiceNeedsConfirmation(raw, level), background };
}

function recentTask(tasks: readonly RouterTask[], now: number): RouterTask | undefined {
  return [...tasks]
    .filter((t) => !TERMINAL.includes(t.state) && now - t.createdAt <= SUPERSEDE_WINDOW_MS)
    .sort(byAge)
    .pop();
}

/* ---------- the router ---------- */

export function routeUtterance(input: RouterInput): Route {
  const raw = String(input.text ?? "");
  const value = stripAddress(norm(raw));
  if (!value) return { kind: "chitchat", reason: "empty" };

  const control = classifyVoiceControl(raw);
  const stopListening =
    control.kind === "stop-listening" ||
    (control.kind === "stop-speaking" && /\b(?:listening|suno)\b|सुनना/u.test(value));
  const names = (): boolean => {
    const list = tokens(value);
    if (list.length > CONTROL_MAX_TOKENS) return false;
    const ref = referenceIn(value, input.tasks);
    return ref.noun || ref.ordinal !== undefined || ref.named.length > 0;
  };

  // (a) the answer to the prompt she last spoke
  const verdict = verdictOf(raw);
  if (
    input.pendingApproval &&
    verdict !== "unclear" &&
    isBoundConfirmation(raw, (v) => verdictOf(v) !== "unclear") &&
    !names() &&
    !(verdict === "no" && isPureStop(value))
  ) {
    if (!approvalFresh(input.pendingApproval.askedAt, input.now)) {
      return { kind: "chitchat", reason: "approval-expired" };
    }
    const id = input.pendingApproval.taskId;
    return {
      kind: "approval-answer",
      verdict,
      ...(id ? { ref: { taskId: id } } : {}),
      reason: "bound-answer",
    };
  }

  // (b) a stop word: her speech and the foreground reply only, never a task
  if (stopListening) return { kind: "stop-speech", stopListening: true, reason: "stop-listening" };
  if (control.kind === "stop-speaking" && isPureStop(value)) {
    return { kind: "stop-speech", reason: "stop-word" };
  }

  // (c) a word about a task
  const act = taskControl(input, value);
  if (act) return act;

  if (isSmallTalk(value)) return { kind: "chitchat", reason: "small-talk" };

  // (g) first: change-of-mind words in front of what follows
  const mind = stripChange(value);
  const heard = mind.changed ? mind.rest : raw;
  const heardValue = mind.changed ? mind.rest : value;
  if (mind.changed && !heardValue) return { kind: "chitchat", reason: "change-of-mind-empty" };

  // (d) a short harmless question, whatever the age of the task
  if (quickLaneEligible({ text: heard, busy: input.busy, hasExtra: Boolean(input.hasExtra) }).ok) {
    return { kind: "side-question", reason: "quick-lane" };
  }

  // (e) and (f) orders, (g) a replacement
  const read = readOrder(heard, heardValue, input.approvalLevel ?? "balanced");
  if (read.order) {
    const old = mind.changed ? recentTask(input.tasks, input.now) : undefined;
    return {
      kind: "new-task",
      ...(read.consequential ? { needsConfirm: true as const } : {}),
      ...(read.background ? { background: true as const } : {}),
      ...(old ? { supersedes: old.id } : {}),
      reason: old ? "supersede" : read.consequential ? "consequential-order" : "order",
    };
  }
  return { kind: "foreground-turn", reason: "turn" };
}

export type CommandRouteInput = {
  text: string;
  /** The transcript is still growing (an interim result), not a final one. */
  partial: boolean;
  ctx: CommandContext;
  /** She is speaking right now. */
  speakingNow: boolean;
  /** Auto mode's hands-free gate is open: a line needs no wake word. */
  handsFree: boolean;
  /** The wake word was heard for this line. */
  wakeHeard: boolean;
};
export type CommandRoute = {
  route: "command" | "brain" | "ignore";
  command?: CommandHit;
  reason: string;
};

/**
 * Where the closed-vocabulary command lane places one line. A line that is not exactly one known command goes to
 * the brain. A command is taken without the wake word only while she is speaking and only for the verbs that make
 * her quieter or stop (stop, stop-all, mute, pause, volume-down, quieter); every other verb needs the wake word
 * or the hands-free gate, so this never grants a bypass of the wake requirement. A partial transcript may route
 * a safety verb only. The route names a command; it never approves, confirms or answers yes for anything.
 */
export function routeCommandLane(input: CommandRouteInput): CommandRoute {
  if (!String(input.text ?? "").trim()) return { route: "ignore", reason: "empty" };
  const match = matchCommand(input.text, input.ctx);
  if (!match.hit) return { route: "brain", reason: "no-command" };
  const safety = SAFETY_COMMANDS.has(match.command);
  if (input.partial && !safety) return { route: "brain", reason: "partial-needs-final" };
  const gated = input.handsFree || input.wakeHeard;
  if (gated || (input.speakingNow && safety)) {
    return { route: "command", command: match, reason: safety ? "safety-command" : "command" };
  }
  return { route: "brain", reason: "wake-required" };
}
