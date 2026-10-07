/** A rare personal line. Quiet hours and a zero budget stay silent. */

export function personalOffer(input: {
  hour: number;
  quiet: boolean;
  budgetLeft: number;
  name: string;
  openLoops: number;
}): string {
  if (input.quiet || input.budgetLeft <= 0) return "";
  if (input.hour < 5 || input.hour > 21) return "";
  const who = input.name ? `${input.name}, ` : "";
  if (input.hour < 11) {
    return input.openLoops
      ? `${who}morning. ${input.openLoops} thing(s) are still open.`
      : `${who}morning. Nothing is waiting.`;
  }
  if (input.hour >= 17) {
    return `${who}evening. I can read today's digest when you want.`;
  }
  return "";
}
