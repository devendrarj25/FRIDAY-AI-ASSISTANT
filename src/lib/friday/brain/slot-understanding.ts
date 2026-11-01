/**
 * FRIDAY · slot understanding
 *
 * What the owner asked for is an action (send, remind, call, open, delete, schedule) with the things it needs: who,
 * what, when, which file. Most requests arrive with a piece missing ("email bhej do"), cut short ("aur YouTube bhi",
 * "Rahul ko"), or corrected in passing ("nahi nahi, sirf PDF nahi, excel bhi"). This module finds the action and its
 * pieces, and does four things with them:
 *
 *  1. asks ONE short question for the missing piece, only when the action cannot be done without it;
 *  2. takes the owner's next short answer as that piece and rebuilds the full request from it;
 *  3. expands a cut-short follow-up by reusing the last action with the new object;
 *  4. links "no, not that, this too" to the request it corrects.
 *
 * It rewrites and asks. It never acts, and it never invents a recipient, a time or a file: a piece that is missing
 * stays missing until the owner says it. Method (a clarifying question only when the answer changes what happens,
 * the question aimed at the missing piece, and follow-ups rewritten into a self-contained request) follows the
 * clarification and conversational-rewrite lines of work recorded in docs/FRIDAY_FEATURES.md.
 */

import { parseWhen } from "../speech-parse";
import { registerOf, type Register } from "../response-policy";

export type ActionId =
  "send" | "remind" | "call" | "open" | "delete" | "schedule" | "play" | "search" | "note";
export type SlotName = "recipient" | "item" | "when" | "what" | "target";

type ActionSpec = {
  id: ActionId;
  verbs: RegExp;
  required: SlotName[];
  /** What the question says for each missing piece, per language. */
  ask: Record<SlotName, Record<Register, string>>;
};

const Q = (en: string, hi: string, hinglish: string): Record<Register, string> => ({
  en,
  hi,
  hinglish,
});

/** The question for each missing piece; a piece an action never asks about gets a plain "which one". */
const asks = (given: Partial<Record<SlotName, Record<Register, string>>>): ActionSpec["ask"] => {
  const which = Q("Which one?", "कौन सा?", "Kaun sa?");
  return {
    recipient: given.recipient ?? which,
    item: given.item ?? which,
    when: given.when ?? Q("When?", "कब?", "Kab?"),
    what: given.what ?? which,
    target: given.target ?? which,
  };
};

const ACTIONS: ActionSpec[] = [
  {
    id: "send",
    verbs:
      /\b(?:bhej\s*do|bhejo|bhej\s*dena|bhej\s*de|send|forward|share\s*kar(?:o|\s*do)?|mail\s*kar(?:o|\s*do)?|email\s*kar(?:o|\s*do)?|msg\s*kar(?:o|\s*do)?|message\s*kar(?:o|\s*do)?|text\s*kar(?:o|\s*do)?|whatsapp(?:\s*kar(?:o|\s*do)?)?)\b/i,
    required: ["recipient"],
    ask: {
      recipient: Q("Who should I send it to?", "किसे भेजना है?", "Kisko bhejna hai?"),
      item: Q("What should I send?", "क्या भेजना है?", "Kya bhejna hai?"),
      when: Q("When?", "कब?", "Kab?"),
      what: Q("What should it say?", "उसमें क्या लिखूँ?", "Usme kya likhun?"),
      target: Q("Which one?", "कौन सा?", "Kaun sa?"),
    },
  },
  {
    id: "remind",
    verbs: /\b(?:remind(?:er)?|yaad\s*dila(?:na|o|do)?|alarm)\b/i,
    required: ["when", "what"],
    ask: {
      recipient: Q("For whom?", "किसके लिए?", "Kiske liye?"),
      item: Q("What?", "क्या?", "Kya?"),
      when: Q("When should I remind you?", "कब याद दिलाऊँ?", "Kab yaad dilaun?"),
      what: Q(
        "What should I remind you about?",
        "किस बारे में याद दिलाऊँ?",
        "Kis baare me yaad dilaun?",
      ),
      target: Q("Which one?", "कौन सा?", "Kaun sa?"),
    },
  },
  {
    id: "call",
    verbs:
      /\b(?:call\s+(?:kar(?:o|\s*do)?|laga(?:o|\s*do)?)|call\s+(?!the\b|a\b|an\b|api\b|function\b|method\b|me\b|it\b)\S+|phone\s+kar(?:o|\s*do)?|dial)\b/i,
    required: ["recipient"],
    ask: {
      recipient: Q("Who should I call?", "किसे कॉल करूँ?", "Kisko call karun?"),
      item: Q("What?", "क्या?", "Kya?"),
      when: Q("When?", "कब?", "Kab?"),
      what: Q("What for?", "किसलिए?", "Kisliye?"),
      target: Q("Which one?", "कौन सा?", "Kaun sa?"),
    },
  },
  {
    id: "play",
    verbs:
      /\b(?:play|bajao|baja\s*do|(?:gaana|gana|song|music|video)\s*(?:chalao|chala\s*do|laga\s*do|lagao))\b/i,
    required: ["target"],
    ask: asks({ target: Q("What should I play?", "क्या बजाऊँ?", "Kya bajaun?") }),
  },
  {
    id: "open",
    verbs: /\b(?:open|launch|khol(?:o|\s*do|\s*dena)|chalao|chala\s*do)\b/i,
    required: ["target"],
    ask: {
      recipient: Q("Who?", "कौन?", "Kaun?"),
      item: Q("What?", "क्या?", "Kya?"),
      when: Q("When?", "कब?", "Kab?"),
      what: Q("What?", "क्या?", "Kya?"),
      target: Q("What should I open?", "क्या खोलूँ?", "Kya kholun?"),
    },
  },
  {
    id: "delete",
    verbs: /\b(?:delete|remove|erase|hata\s*do|hatao|mita\s*do|mitao|saaf\s*kar(?:o|\s*do)?)\b/i,
    required: ["target"],
    ask: {
      recipient: Q("Who?", "कौन?", "Kaun?"),
      item: Q("What?", "क्या?", "Kya?"),
      when: Q("When?", "कब?", "Kab?"),
      what: Q("What?", "क्या?", "Kya?"),
      target: Q("What should I delete?", "क्या हटाऊँ?", "Kya hataun?"),
    },
  },
  {
    id: "schedule",
    verbs: /\b(?:schedule|calendar\s*(?:me|mein)|meeting\s*(?:set|fix|rakh)\w*)\b/i,
    required: ["when", "what"],
    ask: {
      recipient: Q("With whom?", "किसके साथ?", "Kiske saath?"),
      item: Q("What?", "क्या?", "Kya?"),
      when: Q("When?", "कब?", "Kab?"),
      what: Q("What is it for?", "किस बारे में?", "Kis baare me?"),
      target: Q("Which one?", "कौन सा?", "Kaun sa?"),
    },
  },
  {
    id: "search",
    verbs: /\b(?:search|google|look\s*up|dhundo|dhoondo|dhoondh|khojo|dhund\s*do|find)\b/i,
    required: ["target"],
    ask: asks({ target: Q("What should I look for?", "क्या ढूँढूँ?", "Kya dhundun?") }),
  },
  {
    id: "note",
    verbs:
      /\b(?:note\s*(?:kar(?:o|\s*do|\s*lo)?|down)|yaad\s*rakh(?:o|na)?|likh\s*lo|save\s*this|remember\s*this)\b/i,
    required: ["what"],
    ask: asks({ what: Q("What should I note down?", "क्या नोट करूँ?", "Kya note karun?") }),
  },
];

/** A time in the words, found without the speech parser, which only knows some shapes ("tomorrow at 5pm" is not one). */
const TIME_WORDS =
  /\b(?:tomorrow|today|tonight|kal|aaj|parso|subah|shaam|raat|dopahar|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm|baje))|at\s+\d{1,2}(?::\d{2})?|in\s+\d+\s*(?:min|mins|minutes?|hours?|ghante|din|days?)|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|every\s+\w+|roz|har\s+\w+)\b/gi;

const POINTER =
  /\b(?:usko|isko|unko|usse|isse|uska|iska|uski|iski|uske|iske|usme|isme|usmein|ismein|wahi|yahi|ye\s*wala|wo\s*wala|woh\s*wala|that|it|this|them)\b/i;
const PRONOUN = new Set([
  "usko",
  "isko",
  "unko",
  "mujhe",
  "mereko",
  "sabko",
  "kisko",
  "tumhe",
  "mujhko",
  "hamein",
  "humein",
  "me",
  "us",
  "him",
  "her",
  "them",
]);
const FILE =
  /(?:[a-z]:\\[^\s"']+|[\w.-]+\.(?:pdf|docx?|xlsx?|csv|txt|png|jpe?g|pptx?|zip|json|md))/i;
const GENERIC = new Set(
  "email mail message msg file document doc text it thing cheez kuch".split(" "),
);
const STOP = new Set(
  "laga lagao set dalo daalo daal rakh rakho likh likho dikhao batao chalao bana banao please plz ek ka ki ke ko se me mein par pe aur and the a an to for of ya hai ho hu hun kar karo do dena de jao bhi too also abhi ab phir fir zara thoda mujhe mereko meri mera mere hamara apna apni".split(
    " ",
  ),
);

export type Slots = Partial<Record<SlotName, string>>;
export type SlotRead = {
  action: ActionId | null;
  verb: string;
  slots: Slots;
  missing: SlotName[];
  /** The request points back at something already talked about ("usko", "wahi file"). */
  referent: boolean;
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}._@-]+/u)
    .filter(Boolean);

function recipientOf(text: string): string | undefined {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (email) return email[0];
  const ko = text.match(
    /\b([\p{L}]{3,14})\s+(?:ko|se)\b(?=.*\b(?:bhej|send|mail|email|call|message|forward|share|text|phone|bol|puch|baat|meeting))/iu,
  );
  if (ko?.[1] && !PRONOUN.has(ko[1].toLowerCase()) && !STOP.has(ko[1].toLowerCase())) return ko[1];
  const to = text.match(/\b(?:to|call|phone|dial|text|message|ring)\s+([A-Z][\p{L}]{2,14})\b/u);
  if (to?.[1]) return to[1];
  return undefined;
}

/** Pull the action and its pieces out of one request. Nothing is guessed: a piece not in the words is not filled. */
export function readSlots(text: string, hasContextReferent = false): SlotRead {
  const value = String(text || "").trim();
  const spec = ACTIONS.find((row) => row.verbs.test(value));
  if (!spec) return { action: null, verb: "", slots: {}, missing: [], referent: false };
  const verb = value.match(spec.verbs)?.[0] ?? "";
  const referent = POINTER.test(value) || hasContextReferent;
  const slots: Slots = {};
  const recipient = recipientOf(value);
  if (recipient) slots.recipient = recipient;
  const when = parseWhen(value);
  const timeWords = value.match(TIME_WORDS);
  if (when) slots.when = when.label;
  else if (timeWords) slots.when = timeWords.join(" ");
  const file = value.match(FILE);
  if (file) slots.item = file[0];
  // What is left once the verb, the filler and the already-found pieces are taken out is the thing itself.
  const taken = new Set(
    [verb, recipient ?? "", when?.label ?? "", timeWords?.join(" ") ?? "", file?.[0] ?? ""].flatMap(
      (part) => words(part),
    ),
  );
  const rest = words(value).filter(
    (word) =>
      !STOP.has(word) &&
      !taken.has(word) &&
      !PRONOUN.has(word) &&
      !/^\d+$/.test(word) &&
      !spec.verbs.test(word),
  );
  const remaining = rest.filter(
    (word) =>
      !/^(baje|subah|shaam|raat|kal|aaj|parso|tomorrow|today|am|pm|minute|min|ghante|din)$/.test(
        word,
      ),
  );
  const meaningful = remaining.filter((word) => !GENERIC.has(word));
  if (meaningful.length) {
    const phrase = meaningful.slice(0, 4).join(" ");
    if (["open", "delete", "play", "search"].includes(spec.id)) slots.target = file?.[0] ?? phrase;
    else if (["remind", "schedule", "note"].includes(spec.id)) slots.what = phrase;
    else if (spec.id === "send" && !slots.item) slots.item = phrase;
  }
  if ((spec.id === "open" || spec.id === "delete") && file && !slots.target) slots.target = file[0];
  const missing = spec.required.filter(
    (name) => !slots[name] && !(referent && name !== "recipient" && name !== "when"),
  );
  return { action: spec.id, verb, slots, missing, referent };
}

export function clarifyingQuestion(
  action: ActionId,
  missing: SlotName[],
  register: Register,
): string {
  const spec = ACTIONS.find((row) => row.id === action);
  const first = missing[0];
  if (!spec || !first) return "";
  if (missing.length >= 2 && action === "remind")
    return register === "en"
      ? "What should I remind you about, and when?"
      : register === "hi"
        ? "किस बारे में और कब याद दिलाऊँ?"
        : "Kis baare me aur kab yaad dilaun?";
  return spec.ask[first][register];
}

/* ------------------------------------------------------- what is pending */

type Pending = {
  action: ActionId;
  text: string;
  missing: SlotName[];
  at: number;
  asked: number;
  register: Register;
  turn: number;
};
type Last = { action: ActionId | null; verb: string; text: string; at: number };

const WINDOW_MS = 10 * 60_000;
let pending: Pending | null = null;
/** Turns understood so far; a question is only answered by one of the next two turns, not by any later short message. */
let turnCounter = 0;
const ANSWER_TURNS = 2;
let last: Last | null = null;

export function resetSlotMemory(): void {
  turnCounter = 0;
  pending = null;
  last = null;
}

export function pendingQuestion(): { action: ActionId; missing: SlotName[] } | null {
  return pending && Date.now() - pending.at <= WINDOW_MS
    ? { action: pending.action, missing: pending.missing }
    : null;
}

/** A message that is a request or a question of its own is never taken as the answer to a pending question. */
function looksLikeNewRequest(text: string): boolean {
  return (
    ACTIONS.some((row) => row.verbs.test(text)) ||
    DO_VERB.test(text) ||
    /\b(?:banao|bana\s*do|create|make|write|prepare|draft|generate|tell|explain|likho)\b/i.test(
      text,
    ) ||
    /^(?:what|how|why|who|when|where|which|kya|kaise|kyun|kaun|kab|kahan)\b|\?\s*$/i.test(
      text.trim(),
    )
  );
}

const ELLIPSIS_LEAD = /^(?:aur|and|also|plus|phir|fir|ab|then)\s+/i;
const ELLIPSIS_TAIL =
  /\s+(?:bhi|too|as well|also)(?:\s+(?:karo|kar do|chahiye|dikhao|batao))?[\s.!]*$/i;

/** "aur YouTube bhi": the object only, with the lead and the tail taken off. Null when it is not that shape. */
function ellipsisObject(text: string): string | null {
  const t = text.trim();
  const lead = ELLIPSIS_LEAD.test(t);
  const tail = ELLIPSIS_TAIL.test(t);
  if (!lead && !tail) return null;
  const core = t.replace(ELLIPSIS_LEAD, "").replace(ELLIPSIS_TAIL, "").trim();
  const count = core.split(/\s+/).filter(Boolean).length;
  if (!core || count > 4) return null;
  if (ACTIONS.some((row) => row.verbs.test(core))) return null;
  return core;
}

const AMEND = /^(?:nahi|nahin|no|nope)\b[\s,.!]*(?:nahi|no)?[\s,.!]*(.+)$/i;

export type SlotRewrite = {
  /** The request as one self-contained sentence, or null when the words are left as they were. */
  text: string | null;
  how: "filled" | "expanded" | "amended" | null;
};

/**
 * Rewrite this turn using the last one, when it needs it. The order matters: an answer to a pending question is
 * checked first, then a cut-short follow-up, then a correction.
 */
export function rewriteWithHistory(
  literal: string,
  register: Register = registerOf(literal),
): SlotRewrite {
  const text = literal.trim();
  const fresh = Date.now();
  turnCounter += 1;
  if (pending && turnCounter - pending.turn > ANSWER_TURNS) pending = null;
  if (pending && fresh - pending.at <= WINDOW_MS) {
    const short = text.split(/\s+/).length <= 6 && !looksLikeNewRequest(text);
    if (short) {
      const piece = fillPiece(pending, text);
      if (piece) {
        const joined =
          pending.missing.includes("recipient") && pending.register !== "en"
            ? `${piece} ko ${pending.text}`
            : `${pending.text} ${pending.missing.includes("recipient") ? "to " : ""}${piece}`.trim();
        pending = null;
        return { text: joined, how: "filled" };
      }
    }
  }
  if (last && fresh - last.at <= WINDOW_MS) {
    const object = last.verb ? ellipsisObject(text) : null;
    if (object) {
      const verbLast = new RegExp(`${last.verb.replace(/\s+/g, "\\s+")}[\\s.!]*$`, "i").test(
        last.text,
      );
      return {
        text: verbLast ? `${object} ${last.verb}` : `${last.verb} ${object}`,
        how: "expanded",
      };
    }
    const lookup = text.match(/^(?:aur|and)\s+(\S+)\s+ka\s+bhi[\s.!]*$/i);
    const base = last.text.match(/^(\S+)(\s+ka\s+.+)$/i);
    if (lookup?.[1] && base?.[2]) return { text: `${lookup[1]}${base[2]}`, how: "expanded" };
    const amend = text.match(AMEND);
    if (amend?.[1] && /\b(?:bhi|also|instead|ki jagah|sirf|only|nahi|not)\b/i.test(amend[1])) {
      return { text: `${last.text} (correction: ${amend[1].trim()})`, how: "amended" };
    }
  }
  return { text: null, how: null };
}

function fillPiece(open: Pending, text: string): string | null {
  const need = open.missing[0];
  if (need === "recipient") {
    const named = text.match(/^([\p{L}][\p{L}.@-]{1,24})(?:\s+(?:ko|se|ke liye))?[\s.!]*$/u);
    const word = named?.[1];
    return word && !STOP.has(word.toLowerCase()) && !PRONOUN.has(word.toLowerCase()) ? word : null;
  }
  if (need === "when")
    return parseWhen(text) || text.match(TIME_WORDS) ? text.replace(/[.!]+$/, "") : null;
  if (need === "target" || need === "item") {
    const file = text.match(FILE);
    if (file) return file[0];
    const clean = words(text).filter((word) => !STOP.has(word));
    return clean.length && clean.length <= 3 ? clean.join(" ") : null;
  }
  return text.split(/\s+/).length <= 5 ? text.replace(/[.!]+$/, "") : null;
}

/** After a turn is read: remember the action, and remember what is still missing so the next answer can fill it. */
export function noteTurn(text: string, read: SlotRead, asked: boolean): void {
  const now = Date.now();
  // Remember the last request that can be reused: an action, or a "<thing> ka <what>" lookup ("kal ka mausam batao").
  if (read.action) last = { action: read.action, verb: read.verb, text: text.trim(), at: now };
  else if (/^\S+\s+ka\s+\S+/i.test(text.trim()))
    last = { action: null, verb: "", text: text.trim(), at: now };
  if (asked && read.action && read.missing.length) {
    const again = pending && pending.action === read.action && pending.text === text.trim();
    // One re-ask at most: an answer that still does not fill the piece is dropped, not asked for a third time.
    pending =
      again && pending && pending.asked >= 2
        ? null
        : {
            action: read.action,
            text: text.trim(),
            missing: read.missing,
            at: now,
            asked: (again && pending ? pending.asked : 0) + 1,
            register: registerOf(text),
            turn: turnCounter,
          };
  } else if (!asked) {
    pending = null;
  }
}

/** Everyday imperatives that are an action on their own, so "chrome kholo aur calendar dikhao" is two steps. */
const DO_VERB =
  /\b(?:dikhao|dikha\s*do|batao|bata\s*do|check\s*kar(?:o|\s*do)?|dekho|dhundo|dhoondo|khojo|show|find|search|play|read|summari[sz]e|check|likho|likh\s*do|padho|chalao)\b/i;

/** True when a request holds more than one action: "report banao aur Rahul ko bhej do aur calendar me daal do". */
export function splitByAction(text: string): string[] | null {
  const parts = text
    .split(/\s+(?:aur|and)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const MAKE = /\b(?:banao|bana\s*do|create|make|likho|write|prepare|draft|generate)\b/i;
  const acts = parts.filter(
    (part) =>
      ACTIONS.some((row) => row.verbs.test(part)) ||
      MAKE.test(part) ||
      /\bdaal\s*do|\bdaalo|\badd\b/i.test(part) ||
      DO_VERB.test(part),
  );
  return acts.length === parts.length && parts.length <= 5 ? parts : null;
}

/* ------------------------------------------------------ implied requests */

const PROBLEM =
  /\b(?:nahi\s+chal\s+(?:raha|rahi|rahe)|nahi\s+khul\s+(?:raha|rahi)|kaam\s+nahi\s+kar\s+(?:raha|rahi)|slow\s+(?:hai|ho\s+gaya|chal)|hang\s+(?:ho|hai)|crash(?:ing)?\s+(?:ho|hai|kar)|error\s+aa\s+(?:raha|rahi)|not\s+working|keeps?\s+(?:crashing|freezing)|is\s+(?:very\s+)?slow|won'?t\s+(?:open|start|load))\b/i;
const DEADLINE =
  /\b(?:(?:kal|parso|aaj|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:\S+\s+){0,2}(?:exam|interview|meeting|deadline|submission|presentation|flight|test)|(?:exam|interview|deadline|submission|presentation|flight)\s+(?:hai|hain|h)\b|due\s+(?:tomorrow|today|on)|deadline\s+(?:is|hai))/i;
const SPACE =
  /\b(?:disk|storage|space|drive)\b.*\b(?:full|bhar|khatam|low|kam)\b|\b(?:full|bhar)\b.*\b(?:disk|storage|drive)\b/i;

/**
 * What the owner did not ask but his words imply. A problem is an offer to look into it; a deadline is an offer to
 * remind him; a full disk is an offer to find what takes the space. It is only ever offered, in one line, and never
 * done unasked.
 */
export function impliedRequest(text: string): { kind: string; offer: string } | null {
  const value = String(text || "");
  if (/\?\s*$/.test(value)) return null;
  if (SPACE.test(value)) return { kind: "free-space", offer: "find what is taking the space" };
  if (PROBLEM.test(value)) return { kind: "troubleshoot", offer: "look into what is wrong" };
  if (DEADLINE.test(value)) return { kind: "remind", offer: "set a reminder before it" };
  return null;
}
