export type ProsodyPlan = {
  rate: number;
  pitch: number;
  pauseMs: number;
  backchannel: boolean;
  thinking: boolean;
};

export function planProsody(input: {
  emotion: string;
  warmth: string;
  longTask: boolean;
  ownerSpeaking: boolean;
}): ProsodyPlan {
  const warm = input.warmth === "warm" ? 1.05 : input.warmth === "plain" ? 0.95 : 1;
  const stressed = input.emotion === "stress" || input.emotion === "anger";
  return {
    rate: (stressed ? 0.92 : 1) * warm,
    pitch: input.emotion === "excitement" ? 1.08 : 1,
    pauseMs: stressed ? 220 : 120,
    backchannel: !input.ownerSpeaking && input.emotion !== "distress",
    thinking: input.longTask,
  };
}

export function backchannelLine(language: string): string {
  const lang = language.toLowerCase();
  if (lang.startsWith("hi") || lang.includes("hinglish")) return "haan";
  return "mm-hm";
}
