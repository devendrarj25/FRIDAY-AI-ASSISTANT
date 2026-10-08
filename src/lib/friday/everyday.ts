import { resetCorrections } from "./asr-bias";
import { recallArc, forgetArc } from "./conversation-arc";
import { resetStyleCorrection } from "./response-policy";
import { phoneticHit } from "./speech-parse";
import { understandSpoken } from "./speech-understand";
import { addOpenLoop } from "./brain/open-loops";

export type EverydayPlan = {
  kind:
    | "timer"
    | "note"
    | "draft"
    | "digest"
    | "convert"
    | "open"
    | "calendar"
    | "calc"
    | "recall"
    | "forget";
  text: string;
  needsApproval: boolean;
  undo: boolean;
};

export function everydayPlan(text: string): EverydayPlan | null {
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
  if (/\byaad hai\b/i.test(value)) {
    const hit = recallArc(0);
    return {
      kind: "recall",
      text: hit
        ? `Saved earlier (${hit.age}, ${hit.source}): ${hit.text}`
        : "I do not have that saved.",
      needsApproval: false,
      undo: false,
    };
  }
  if (/\b(bhool jao sab|forget everything|forget all)\b/i.test(value)) {
    const removed = forgetArc("all");
    resetCorrections();
    resetStyleCorrection();
    return {
      kind: "forget",
      text: removed ? "Forgot the saved notes." : "There was nothing to forget.",
      needsApproval: false,
      undo: true,
    };
  }
  if (/\b(bhool jao|forget that)\b/i.test(value)) {
    const removed = forgetArc("last");
    return {
      kind: "forget",
      text: removed ? "Forgot the last note." : "There was nothing to forget.",
      needsApproval: false,
      undo: true,
    };
  }
  if (/\b(open|kholo)\b/i.test(value) && /\b(chrome|notepad|file|site|folder)\b/i.test(value)) {
    const named = phoneticHit(value, ["Chrome", "Notepad"]);
    return {
      kind: "open",
      text: named
        ? `Opening ${named}. Undo closes it if it was ours.`
        : "Opening that. Undo closes it if it was ours.",
      needsApproval: false,
      undo: true,
    };
  }
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
