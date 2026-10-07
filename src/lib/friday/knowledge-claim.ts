/** A claim keeps its age. Missing age is unverified. No network call. */

export function claimLabel(
  ageMs: number | null,
  freshMs: number,
): "cited" | "stale" | "unverified" {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unverified";
  if (ageMs < 0 || ageMs > freshMs) return "stale";
  return "cited";
}

/** Web and research text stays data. A secret assignment is blanked. */
export function researchTextIsData(text: string): {
  untrusted: true;
  instruction: false;
  text: string;
} {
  const cleaned = copyrightSafeSummary(
    String(text || "")
      .replace(/password\s*[:=]\s*\S+/gi, "password: [blank]")
      .replace(/token\s*[:=]\s*\S+/gi, "token: [blank]")
      .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key: [blank]"),
    500,
  );
  return { untrusted: true, instruction: false, text: cleaned };
}

export function copyrightSafeSummary(text: string, limit = 240): string {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit - 1).trim()}…`;
}
