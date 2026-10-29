/**
 * FRIDAY · canvas strings.
 *
 * English is the default. Hindi and Hinglish ride along so a caption can
 * follow the owner's language without a second UI kit.
 */

export type FlowLang = "en" | "hi";

const LINES = {
  stopped: { en: "Stopped.", hi: "Ruk gayi." },
  dryRun: { en: "Dry run. Nothing was executed.", hi: "Dry run. Kuch execute nahi hua." },
  ask: { en: "Balanced asks before this change.", hi: "Balanced pehle poochti hai." },
  applied: { en: "Applied.", hi: "Lag gaya." },
  legend: {
    en: "Shape and words carry the status. Color is extra.",
    hi: "Shape aur words status batate hain. Color extra hai.",
  },
} as const;

export function flowLine(key: keyof typeof LINES, lang: FlowLang = "en"): string {
  return LINES[key][lang];
}
