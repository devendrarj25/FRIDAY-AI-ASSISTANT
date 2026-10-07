/**
 * FRIDAY · anti-repetition
 *
 * Same brain for chat and voice. Picks a natural variant and refuses to
 * repeat the last few lines in a bucket. Does not randomly rewrite every
 * sentence — only greetings, acknowledgements, thanks and closings.
 *
 * Vocatives come from the conversational user profile, never from the
 * project publisher string.
 */

import { vocative } from "./user-profile";

export type RepeatBucket = "greeting" | "ack" | "thanks" | "done" | "listening";

const LAST: Record<RepeatBucket, string[]> = {
  greeting: [],
  ack: [],
  thanks: [],
  done: [],
  listening: [],
};

const KEEP = 4;

function greetingPool(address: string): string[] {
  const named = address
    ? [`Haan ${address}?`, `${address} — boliye.`, `Yes ${address}?`, `Ji, ${address}.`]
    : [];
  return [
    ...named,
    "I'm here.",
    "Batao.",
    "Ready.",
    "Boliye.",
    "Haan, boliye.",
    "मैं सुन रही हूँ।",
    "What do you need?",
    "Listening.",
  ];
}

function pool(bucket: RepeatBucket, address: string): string[] {
  switch (bucket) {
    case "greeting":
      return greetingPool(address);
    case "ack":
      return [
        "Got it.",
        "ठीक है।",
        "On it.",
        "Understood.",
        "हाँ।",
        "Right.",
        "Okay — doing that.",
      ];
    case "thanks":
      return ["Anytime.", "Done.", "खुशी हुई।", "Glad it helped.", "What's next?", "Happy to."];
    case "done":
      return ["Done.", "That's in.", "हो गया।", "Finished.", "Ready for the next thing."];
    case "listening":
      return ["मैं देखती हूँ।", "I'm looking.", "One moment.", "Checking."];
    default:
      return ["Okay."];
  }
}

/** Pick a line that is not among the last few used in this bucket. */
export function vary(bucket: RepeatBucket): string {
  const address = bucket === "greeting" ? vocative() : "";
  const choices = pool(bucket, address);
  const recent = LAST[bucket];
  const fresh = choices.filter((line) => !recent.includes(line));
  const options = fresh.length ? fresh : choices;
  const salt = new Date().getHours() + new Date().getDate();
  const pick = options[(salt + recent.length) % options.length] ?? choices[0] ?? "Okay.";
  recent.push(pick);
  if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
  return pick;
}

export function lastSaid(bucket: RepeatBucket): string[] {
  return [...LAST[bucket]];
}

/** Test hook — never called from UI. */
export function resetAntiRepeat(): void {
  (Object.keys(LAST) as RepeatBucket[]).forEach((key) => {
    LAST[key] = [];
  });
}
