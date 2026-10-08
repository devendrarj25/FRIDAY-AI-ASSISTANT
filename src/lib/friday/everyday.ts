import { addOpenLoop } from "./brain/open-loops";

export type EverydayPlan = {
  kind: "timer" | "note" | "draft" | "digest" | "convert";
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
