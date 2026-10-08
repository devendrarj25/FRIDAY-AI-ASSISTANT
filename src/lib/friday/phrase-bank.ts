import { PHRASE_BANK, type PhraseSlot } from "./data/phrase-bank";

const recent = new Map<string, string[]>();

export function resetPhraseWindow(): void {
  recent.clear();
}

export function phraseWindow(key: string): string[] {
  return [...(recent.get(key) ?? [])];
}

export function pickPhrase(input: {
  lang: PhraseSlot["lang"];
  emotion: string;
  intensity: PhraseSlot["intensity"];
  context: PhraseSlot["context"];
  kind: PhraseSlot["kind"];
}): string {
  const key = `${input.lang}|${input.emotion}|${input.kind}`;
  const pool = PHRASE_BANK.filter(
    (row) =>
      row.lang === input.lang &&
      row.emotion === input.emotion &&
      row.intensity === input.intensity &&
      row.context === input.context &&
      row.kind === input.kind,
  );
  const used = recent.get(key) ?? [];
  const fresh = pool.filter((row) => !used.includes(row.text));
  const choice = (fresh[0] ?? pool[0])?.text ?? "I'm here.";
  const next = [...used, choice].slice(-4);
  recent.set(key, next);
  return choice;
}

export function phraseCoverage(): { count: number; duplicateIds: string[] } {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  for (const row of PHRASE_BANK) {
    if (seen.has(row.id)) duplicateIds.push(row.id);
    seen.add(row.id);
  }
  return { count: PHRASE_BANK.length, duplicateIds };
}

const BANNED = /i am human|i'm human|i feel |i am conscious|i'm conscious|i truly feel/i;

export function phraseClaimsFeeling(): string[] {
  return PHRASE_BANK.filter((row) => BANNED.test(row.text)).map((row) => row.id);
}
