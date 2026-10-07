/**
 * FRIDAY · runtime project / legal identity (locked)
 *
 * Packaging, installer, and docs still read `scripts/identity.cjs` — that
 * file is the string authority for builds. This module is the renderer/kernel
 * lock so Settings and conversation cannot change owner, creator, publisher,
 * or copyright. `identity-consistency.test.ts` proves the two stay equal.
 *
 * Disclose these strings only when asked who owns / made FRIDAY, or about
 * copyright. Never use them as a conversational nickname.
 */

export const PROJECT_IDENTITY = {
  product: "FRIDAY",
  owner: "Devendra Singh Meena",
  github: "devendrarj25",
  publisher: "Devendra Singh Meena (devendrarj25)",
  repository: "https://github.com/devendrarj25/FRIDAY-AI-ASSISTANT",
  copyright: "Copyright © 2026 Devendra Singh Meena (devendrarj25)",
} as const;

export type LockedIdentityFields = {
  name: typeof PROJECT_IDENTITY.product;
  pronoun: "she";
  owner: typeof PROJECT_IDENTITY.publisher;
};

/** Product name, pronoun, and publisher — never writable from UI or chat. */
export function lockedIdentityFields(): LockedIdentityFields {
  return {
    name: PROJECT_IDENTITY.product,
    pronoun: "she",
    owner: PROJECT_IDENTITY.publisher,
  };
}

export function stripLockedIdentityPatch<T extends Record<string, unknown>>(
  patch: T,
): Omit<T, "name" | "owner" | "pronoun"> {
  const next: Record<string, unknown> = { ...patch };
  delete next["name"];
  delete next["owner"];
  delete next["pronoun"];
  return next as Omit<T, "name" | "owner" | "pronoun">;
}
