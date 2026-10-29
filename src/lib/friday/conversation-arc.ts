export type ArcNote = {
  topic: string;
  feeling: string;
  at: number;
  source: string;
};

const NOTES: ArcNote[] = [];

export function resetArc(): void {
  NOTES.length = 0;
}

export function noteArc(input: {
  topic: string;
  feeling: string;
  at: number;
  source: string;
}): void {
  const topic = String(input.topic || "")
    .trim()
    .slice(0, 160);
  if (!topic || /password|token|api[_-]?key/i.test(topic)) return;
  NOTES.push({
    topic,
    feeling: input.feeling || "neutral",
    at: input.at,
    source: input.source || "turn",
  });
  if (NOTES.length > 40) NOTES.shift();
}

export function recallArc(now: number): { text: string; source: string; age: string } | null {
  const last = NOTES[NOTES.length - 1];
  if (!last) return null;
  const age =
    now > last.at ? `${Math.max(0, Math.round((now - last.at) / 60000))} min` : "age unknown";
  return { text: last.topic, source: last.source, age };
}

export function forgetArc(which: "last" | "all"): number {
  if (which === "all") {
    const count = NOTES.length;
    resetArc();
    return count;
  }
  return NOTES.pop() ? 1 : 0;
}

export function arcSnapshot(): readonly ArcNote[] {
  return NOTES.slice();
}
