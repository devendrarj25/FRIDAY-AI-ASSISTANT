/**
 * FRIDAY · memory policy
 *
 * Never store every chat line as permanent memory. Importance + confidence
 * decide keep vs skip. Conflict = same title, disagreeing body.
 */

import type { MemoryItem, MemoryTier } from "../self/memory-engine";
import { meaningsDisagree, memoryContentTokens, tokenJaccard } from "../self/memory-engine";
import { shouldRememberChats } from "../settings-runtime";

export { meaningsDisagree };

const CHATTER = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|hmm+|lol)\b/i;

/**
 * Same SENSITIVE signals as `electron/privacy-firewall.cjs` / `kernel/privacy.py`.
 * Kept here so the renderer never stores credential-like text as memory even
 * when it cannot load the main-process module. Tests lock the two together.
 */
const SENSITIVE_MARKERS = [
  /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
  /\b(password|passwd|secret|api[ _-]?key|access[ _-]?token|private key|seed phrase)\b(?:\s*[:=]\s*|\s+is\s+|\s+(?=\S*\d))\S+/i,
  /\b(?:(?:my|the)\s+)?(pin|passcode|otp|one[ -]?time(?:\s+(?:code|password|passcode))?|cvv|cvc)\b(?:\s*(?:is|:|=)\s*|\s+(?=\d{4,}))\S+/i,
  /\b(?:\d[ -]?){13,19}\b|\b(aadhaar|pan card|passport|ssn|social security)\b/i,
  /\bFRIDAY_LEDGER\b|\b(IFSC|IBAN)\b[-\s:]*[A-Z0-9]{6,}|\b(account (number|no\.?)|a\/c)\s*[:#]?\s*\d{8,}/i,
];

/** True when the text would be classified SENSITIVE by the privacy firewall. */
export function looksSensitive(text: string): boolean {
  const value = String(text || "");
  return SENSITIVE_MARKERS.some((re) => re.test(value));
}

export type MemoryVerdict = {
  keep: boolean;
  importance: number;
  confidence: number;
  tier: MemoryTier;
  reason: string;
};

export function considerMemory(input: {
  text: string;
  title?: string;
  ok?: boolean;
  kind?: string;
  sourced?: boolean;
}): MemoryVerdict {
  const text = String(input.text || "").trim();
  if (!text || CHATTER.test(text) || text.length < 12) {
    return {
      keep: false,
      importance: 0.05,
      confidence: 0.2,
      tier: "working",
      reason: "chatter or too short — not stored",
    };
  }
  if (looksSensitive(text) || looksSensitive(String(input.title || ""))) {
    return {
      keep: false,
      importance: 0,
      confidence: 1,
      tier: "working",
      reason: "sensitive credential-like text is never stored as memory",
    };
  }
  if (!shouldRememberChats()) {
    return {
      keep: false,
      importance: 0,
      confidence: 1,
      tier: "working",
      reason: "conversation memory is paused in Settings",
    };
  }
  if (input.sourced && input.ok) {
    return {
      keep: true,
      importance: 0.8,
      confidence: 0.8,
      tier: "semantic",
      reason: "sourced research with provenance",
    };
  }
  if (input.ok === false) {
    return {
      keep: true,
      importance: 0.55,
      confidence: 0.5,
      tier: "temporary",
      reason: "failed attempt — keep briefly so the next try can avoid it",
    };
  }
  const important = /\b(prefer|always|never|root|owner|remember)\b/i.test(text);
  return {
    keep: text.length > 40 || important,
    importance: important ? 0.75 : 0.4,
    confidence: 0.6,
    tier: important ? "permanent" : "working",
    reason: important ? "standing preference or fact" : "working context only",
  };
}

/** Named "is this worth remembering" gate — same policy, not a second filter. */
export function isWorthRemembering(input: {
  text: string;
  title?: string;
  ok?: boolean;
  kind?: string;
  sourced?: boolean;
}): boolean {
  return considerMemory(input).keep;
}

export function detectConflict(
  items: MemoryItem[],
  incoming: { title: string; text: string },
): MemoryItem | null {
  const title = incoming.title.trim().toLowerCase();
  const body = incoming.text.trim().toLowerCase();
  if (!title || !body) return null;
  const same = items.find((item) => item.title.toLowerCase() === title && !item.pinned);
  if (same && same.text.trim().toLowerCase() !== body) return same;
  const polar = items.find(
    (item) =>
      item.tier !== "archived" &&
      !item.pinned &&
      meaningsDisagree(`${item.title} ${item.text}`, `${incoming.title} ${incoming.text}`),
  );
  return polar ?? null;
}

export type TurnLine = { role: "user" | "assistant"; text: string };

export type TurnFact = {
  id: string;
  text: string;
  source: string;
  at: number;
  privacy?: "local" | "cloud";
  pinned?: boolean;
};

/**
 * The full transcript stays with the caller. The model packet is the recent
 * turns plus facts that match this ask. Sensitive text and local-only facts
 * stay out of that packet. Each fact keeps its source and age.
 */
export function packTurnContext(input: {
  transcript: TurnLine[];
  facts: TurnFact[];
  ask: string;
  now: number;
  maxTurns?: number;
  maxFacts?: number;
}): {
  localTranscript: TurnLine[];
  forModel: { turns: TurnLine[]; facts: Array<TurnFact & { ageMs: number | null }> };
  withheld: string[];
} {
  const transcript = Array.isArray(input.transcript) ? input.transcript : [];
  const maxTurns = input.maxTurns ?? 8;
  const maxFacts = input.maxFacts ?? 4;
  const askTerms = memoryContentTokens(input.ask);
  const withheld: string[] = [];
  const ranked = (input.facts || [])
    .map((fact) => {
      const text = String(fact.text || "");
      if (!text.trim() || looksSensitive(text) || fact.privacy === "local") {
        if (fact.id) withheld.push(fact.id);
        return null;
      }
      const overlap = tokenJaccard(askTerms, memoryContentTokens(text));
      const ageMs = fact.at > 0 ? Math.max(0, input.now - fact.at) : null;
      return { fact: { ...fact, text, ageMs }, overlap };
    })
    .filter((row): row is { fact: TurnFact & { ageMs: number | null }; overlap: number } =>
      Boolean(row),
    )
    .filter((row) => row.overlap > 0 || row.fact.pinned)
    .sort(
      (a, b) =>
        b.overlap - a.overlap ||
        Number(Boolean(b.fact.pinned)) - Number(Boolean(a.fact.pinned)) ||
        b.fact.at - a.fact.at,
    )
    .slice(0, maxFacts)
    .map((row) => row.fact);
  return {
    localTranscript: transcript,
    forModel: { turns: transcript.slice(-Math.max(1, maxTurns)), facts: ranked },
    withheld,
  };
}

/** Profile fields the owner already saved. Age is unknown until a fact has a time. */
export function profileFacts(profile: {
  preferredName?: string;
  occupation?: string;
  location?: string;
  languages?: string;
  notes?: string;
}): TurnFact[] {
  const rows: Array<[string, string, string]> = [
    ["name", "preferred name", profile.preferredName || ""],
    ["occupation", "occupation", profile.occupation || ""],
    ["location", "location", profile.location || ""],
    ["languages", "languages", profile.languages || ""],
    ["notes", "note", profile.notes || ""],
  ];
  return rows
    .filter(([, , text]) => text.trim().length > 0)
    .map(([id, label, text]) => ({
      id: `profile:${id}`,
      text: id === "notes" ? text.trim() : `${label} is ${text.trim()}`,
      source: "profile",
      at: 0,
    }));
}

/** Backup copy. Credential text is blank. Each row keeps its source and age. */
export function redactForExport<
  T extends {
    title: string;
    text: string;
    source: string;
    createdAt: number;
    freshnessAt?: number;
  },
>(items: T[], now: number): Array<T & { ageMs: number | null }> {
  return items.map((item) => {
    const at = item.freshnessAt ?? item.createdAt;
    const sensitive = looksSensitive(item.text) || looksSensitive(item.title);
    return {
      ...item,
      title: sensitive ? "withheld" : item.title,
      text: sensitive ? "" : item.text,
      source: item.source || "unknown",
      ageMs: at > 0 ? Math.max(0, now - at) : null,
    };
  });
}
