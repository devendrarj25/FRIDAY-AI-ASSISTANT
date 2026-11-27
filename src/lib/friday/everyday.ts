import { resetCorrections } from "./asr-bias";
import { arcSnapshot, forgetArc, recallArc } from "./conversation-arc";
import { resetStyleCorrection } from "./response-policy";
import { understandSpoken } from "./speech-understand";
import { addOpenLoop } from "./brain/open-loops";
import { forgetEverywhere } from "./brain/memory-fabric";
import { retrievalTerms } from "./brain/retrieval";
import { memory } from "./self/memory-engine";

export type EverydayPlan = {
  kind:
    "timer" | "note" | "draft" | "digest" | "convert" | "calendar" | "calc" | "recall" | "forget";
  text: string;
  needsApproval: boolean;
  undo: boolean;
};

/** How long a recalled memory stays "that" for a spoken "forget that". */
const FORGET_TARGET_MS = 10 * 60_000;
// "don't forget that" is the opposite of a command, so the cue must not follow a negation. JS \b is ASCII-only,
// so the Devanagari cues carry no \b.
const FORGET_ALL =
  /(?<!\b(?:don'?t|do not|never|mat|kabhi na)\s+)(?:\b(?:bhool jao sab|forget everything|forget all)\b|सब भूल जाओ)/i;
const FORGET_LAST =
  /(?<!\b(?:don'?t|do not|never|mat|kabhi na)\s+)(?:\b(?:bhool jao|forget that)\b|भूल जाओ)/i;
const RECALL_CUE = /\byaad hai\b|याद है/i;
const NOTE_WITH_FACT = /\b(?:yaad rakh(?:na|o)?|याद रख(?:ना|ो)?)(?:\s+(?:ki|कि))?\s+\S/i;

function recallFromArc(value: string): EverydayPlan | null {
  const notes = arcSnapshot();
  const rest = retrievalTerms(value.replace(RECALL_CUE, " "));
  const hit = rest.length
    ? [...notes].reverse().find((note) => {
        const topic = new Set(retrievalTerms(note.topic));
        return rest.some((word) => topic.has(word));
      })
    : notes[notes.length - 1];
  if (!hit) return null;
  const last = recallArc(0);
  const age = last && last.text === hit.topic ? last.age : "age unknown";
  return {
    kind: "recall",
    text: `Saved earlier (${age}, ${hit.source}): ${hit.topic}`,
    needsApproval: false,
    undo: false,
  };
}

function forgetThat(now: number): EverydayPlan {
  const recent = memory.lastRetrieval();
  const id = recent.ids[0];
  const target =
    id && now - recent.at <= FORGET_TARGET_MS
      ? memory.getSnapshot().items.find((item) => item.id === id)
      : undefined;
  if (target) {
    forgetEverywhere(target.id);
    return {
      kind: "forget",
      text: `Forgot "${target.title}" everywhere: memory, knowledge and the vector copy.`,
      needsApproval: false,
      undo: false,
    };
  }
  const note = forgetArc("last");
  return {
    kind: "forget",
    text: note
      ? "Dropped the last session note. It was not a saved memory."
      : "Nothing matched, so nothing was forgotten.",
    needsApproval: false,
    undo: false,
  };
}

export function everydayPlan(text: string, now: number = Date.now()): EverydayPlan | null {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/\b(timer|alarm)\b/i.test(value) && /\b(\d+|ek|do|paanch|das)\b/i.test(value)) {
    addOpenLoop("task", value.slice(0, 200));
    return {
      kind: "timer",
      text: "Noted as an open loop. I did not start a second clock.",
      needsApproval: false,
      undo: true,
    };
  }
  // A question about a remembered fact is the brain's job (memory.retrieve). Only a note from this session
  // answers here, and only when one matches; otherwise nothing is claimed and the turn goes on.
  if (RECALL_CUE.test(value)) return recallFromArc(value);
  if (FORGET_ALL.test(value)) {
    const removed = forgetArc("all");
    resetCorrections();
    resetStyleCorrection();
    return {
      kind: "forget",
      text: removed
        ? "Cleared the session notes and corrections. Your saved memories stay; forget them one at a time."
        : "Cleared the corrections. Your saved memories stay; forget them one at a time.",
      needsApproval: false,
      undo: false,
    };
  }
  if (FORGET_LAST.test(value)) return forgetThat(now);
  // "chrome kholo" and "open notepad" are not answered here: nothing is opened by this file, so it says nothing
  // and the real tool path (approval, undo journal) handles the request.
  if (/\b(calendar|kalender)\b/i.test(value) && /\b(add|daal|daalo|meeting)\b/i.test(value)) {
    return {
      kind: "calendar",
      text: "Calendar draft only. Adding it waits for your approval.",
      needsApproval: true,
      undo: true,
    };
  }
  const product = /\b(\d+)\s*(?:times|x|into)\s*(\d+)\b/i.exec(value);
  if (product) {
    const left = Number(product[1]);
    const right = Number(product[2]);
    return {
      kind: "calc",
      text: `${left * right}.`,
      needsApproval: false,
      undo: false,
    };
  }
  const spoken = understandSpoken(value);
  if (spoken.quantity != null && spoken.unit && value.split(/\s+/).length <= 4) {
    return {
      kind: "note",
      text: `Noted ${spoken.quantity} ${spoken.unit}.`,
      needsApproval: false,
      undo: true,
    };
  }
  // "yaad rakhna <fact>" is a request to remember that fact: the settings path stages it and asks to confirm.
  if (NOTE_WITH_FACT.test(value)) return null;
  if (/\b(note this|yaad rakhna|likh lo)\b/i.test(value)) {
    addOpenLoop("task", value.slice(0, 200));
    return {
      kind: "note",
      text: "Saved on the open-loop list. Nothing was deleted.",
      needsApproval: false,
      undo: true,
    };
  }
  if (
    /\b(draft (?:a |the |this )?(?:message|email|text)|message likho|email likho)\b/i.test(value)
  ) {
    return {
      kind: "draft",
      text: "Draft only. Sending waits for your approval.",
      needsApproval: true,
      undo: true,
    };
  }
  if (/\bwhat did you do today|aaj kya kiya\b/i.test(value)) {
    return {
      kind: "digest",
      text: "Today's record is the Tasks digest: done, waiting, undone, and tomorrow.",
      needsApproval: false,
      undo: false,
    };
  }
  return null;
}
