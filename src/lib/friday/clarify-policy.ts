/** One question, and only when guessing would cost more than asking. */

export function clarificationChoice(input: {
  confidence: number;
  costWrong: number;
  costAsk: number;
}): { ask: boolean; assumption: string | null; question: string | null } {
  const ask = input.costWrong > input.costAsk && input.confidence < 0.6;
  if (ask) {
    return {
      ask: true,
      assumption: null,
      question: "Which one should I use?",
    };
  }
  return {
    ask: false,
    assumption:
      input.confidence >= 0.6
        ? "I'll proceed with the last named thing."
        : "I'll use the safer local choice.",
    question: null,
  };
}
