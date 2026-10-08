/** Spoken text into a form a voice can say. No network and no clock. */

const HINGLISH: Array<[RegExp, string]> = [
  [/\bdhai\b/gi, "two and a half"],
  [/\bpaune\s+chaar\b/gi, "a quarter to four"],
  [/\bpaune\s+(\w+)\b/gi, "a quarter to $1"],
  [/\bsawa\s+(\w+)\b/gi, "$1 and a quarter"],
  [/\bsadhe\s+(\w+)\b/gi, "half past $1"],
  [/\bagle\s+somvar\b/gi, "next Monday"],
  [/\bagle\s+(\w+)\b/gi, "next $1"],
  [/\bghante\b/gi, "hours"],
  [/\bminute\b/gi, "minutes"],
  [/\bhaan\b/gi, "yes"],
  [/\bnahi\b/gi, "no"],
];

const FILLERS = /\b(um+|uh+|matlab|you know|like)\b/gi;

export function stripFillers(text: string): string {
  return text.replace(FILLERS, " ").replace(/\s+/g, " ").trim();
}

export function applySelfCorrection(text: string): string {
  const match = text.match(/^(.*?)\b(?:nahi|not)\b.+\bbut\b\s+(.+)$/i);
  if (!match) return text;
  return (match[2] ?? text).trim();
}

export function normalizeSpoken(text: string): string {
  let line = stripFillers(applySelfCorrection(text));
  line = line.replace(/https?:\/\/\S+/gi, "a link");
  line = line.replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
  line = line.replace(/₹\s*(\d+)/g, "$1 rupees");
  line = line.replace(/\$\s*(\d+)/g, "$1 dollars");
  line = line.replace(/\b(\d+)\s*%/g, "$1 percent");
  for (const [pattern, replacement] of HINGLISH) line = line.replace(pattern, replacement);
  return line.replace(/\s+/g, " ").trim();
}

export function sentenceChunks(text: string): string[] {
  const parts = normalizeSpoken(text)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : text.trim() ? [text.trim()] : [];
}

export function voiceForLanguage(language: string): string {
  const lang = language.toLowerCase();
  if (lang.startsWith("hi") || lang.includes("hinglish") || lang === "en-in") return "hi-IN";
  return "en-IN";
}
