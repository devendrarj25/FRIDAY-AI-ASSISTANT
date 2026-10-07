/**
 * FRIDAY · conversational user profile
 *
 * Who she is talking to — name, about-you, work, place, languages, standing
 * notes, how to address — kept apart from project/legal identity
 * (`scripts/identity.cjs`, `brain/project-identity.ts`) and from FRIDAY's
 * own persona (`brain/identity.ts`). Empty on first run. Filled from
 * Settings → AI or when the user tells her. Never reads the publisher string
 * as a nickname.
 */

import { readLocalState, restoreFromDisk, writeState } from "../persist";

export type AddressAs = "sir" | "boss" | "none" | "custom";

export type UserProfile = {
  preferredName: string;
  about: string;
  occupation: string;
  location: string;
  /** Languages the user speaks, as they wrote them. */
  languages: string;
  /** Standing facts ("remember that …"). Cap applied on write. */
  notes: string;
  addressAs: AddressAs;
  customHonorific: string;
  useNameInAddress: boolean;
};

export type UserProfileDigest = {
  preferredName: string;
  about: string;
  occupation: string;
  location: string;
  languages: string;
  notes: string;
  addressAs: AddressAs;
  honorific: string;
  useNameInAddress: boolean;
};

const STORAGE_KEY = "friday.brain.user-profile.v1";

export const ABOUT_CAP = 2000;
export const NOTES_CAP = 2000;
const LINE_CAP = 200;

const EMPTY: UserProfile = {
  preferredName: "",
  about: "",
  occupation: "",
  location: "",
  languages: "",
  notes: "",
  addressAs: "sir",
  customHonorific: "",
  useNameInAddress: false,
};

const ADDRESS: AddressAs[] = ["sir", "boss", "none", "custom"];

function asAddress(value: unknown): AddressAs {
  return ADDRESS.includes(value as AddressAs) ? (value as AddressAs) : "sir";
}

function cap(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function hydrate(stored: Partial<UserProfile> | null): UserProfile {
  if (!stored) return { ...EMPTY };
  return {
    preferredName: cap(stored.preferredName, LINE_CAP),
    about: cap(stored.about, ABOUT_CAP),
    occupation: cap(stored.occupation, LINE_CAP),
    location: cap(stored.location, LINE_CAP),
    languages: cap(stored.languages, LINE_CAP),
    notes: cap(stored.notes, NOTES_CAP),
    addressAs: asAddress(stored.addressAs),
    customHonorific: cap(stored.customHonorific, 40),
    useNameInAddress: Boolean(stored.useNameInAddress),
  };
}

class UserProfileStore {
  private state: UserProfile = hydrate(readLocalState<UserProfile>(STORAGE_KEY));
  private snapshot: UserProfile = { ...this.state };
  private listeners = new Set<() => void>();

  constructor() {
    restoreFromDisk<UserProfile>(STORAGE_KEY, (value) => {
      this.state = hydrate(value);
      this.commit(false);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UserProfile => this.snapshot;

  update(patch: Partial<UserProfile>): void {
    this.state = hydrate({ ...this.state, ...patch });
    this.commit(true);
  }

  /** Test/reset hook — never called from UI. */
  resetForTests(): void {
    this.state = { ...EMPTY };
    this.snapshot = { ...EMPTY };
    this.listeners.forEach((listener) => listener());
  }

  private commit(persist: boolean): void {
    this.snapshot = { ...this.state };
    if (persist) writeState(STORAGE_KEY, this.state);
    this.listeners.forEach((listener) => listener());
  }
}

export const userProfile = new UserProfileStore();

/** Spoken vocative: configured name only when asked, else honorific, else empty. */
export function vocative(): string {
  const profile = userProfile.getSnapshot();
  const name = profile.preferredName.trim();
  if (profile.useNameInAddress && name) return name;
  if (profile.addressAs === "none") return "";
  if (profile.addressAs === "custom") return profile.customHonorific.trim();
  if (profile.addressAs === "boss") return "Boss";
  return "sir";
}

export function userProfileDigest(): UserProfileDigest {
  const profile = userProfile.getSnapshot();
  return {
    preferredName: profile.preferredName.trim(),
    about: profile.about.trim(),
    occupation: profile.occupation.trim(),
    location: profile.location.trim(),
    languages: profile.languages.trim(),
    notes: profile.notes.trim(),
    addressAs: profile.addressAs,
    honorific: vocative(),
    useNameInAddress: profile.useNameInAddress,
  };
}

export function appendUserNotes(fact: string): void {
  const clean = fact.trim().slice(0, NOTES_CAP);
  if (!clean) return;
  const current = userProfile.getSnapshot().notes.trim();
  const lines = current ? current.split(/\n+/).filter(Boolean) : [];
  if (lines.some((line) => line.toLowerCase() === clean.toLowerCase())) return;
  lines.push(clean);
  userProfile.update({ notes: lines.join("\n").slice(0, NOTES_CAP) });
}

export function dropUserNotes(fact: string): boolean {
  const needle = fact.trim().toLowerCase();
  if (!needle) return false;
  const lines = userProfile.getSnapshot().notes.split(/\n+/).filter(Boolean);
  const kept = lines.filter((line) => !line.toLowerCase().includes(needle));
  if (kept.length === lines.length) return false;
  userProfile.update({ notes: kept.join("\n") });
  return true;
}

export function clearUserDetails(scope: "name" | "about" | "all"): void {
  if (scope === "name") {
    userProfile.update({ preferredName: "", useNameInAddress: false });
    return;
  }
  if (scope === "about") {
    userProfile.update({ about: "", occupation: "", location: "", languages: "", notes: "" });
    return;
  }
  userProfile.update({
    preferredName: "",
    about: "",
    occupation: "",
    location: "",
    languages: "",
    notes: "",
    useNameInAddress: false,
  });
}

/** Spoken / Settings readout. Never includes project publisher. */
export function describeUserProfile(): string {
  const digest = userProfileDigest();
  const customized =
    Boolean(digest.preferredName) ||
    Boolean(digest.occupation) ||
    Boolean(digest.location) ||
    Boolean(digest.languages) ||
    Boolean(digest.about) ||
    Boolean(digest.notes) ||
    digest.useNameInAddress ||
    digest.addressAs !== "sir";
  if (!customized) {
    return 'Nothing saved about you yet. Tell me, or write it in Settings → AI — name, work, where you live, languages, or "remember that …".';
  }
  const bits: string[] = [];
  if (digest.preferredName) bits.push(`Name: ${digest.preferredName}`);
  if (digest.occupation) bits.push(`Work: ${digest.occupation}`);
  if (digest.location) bits.push(`Location: ${digest.location}`);
  if (digest.languages) bits.push(`Languages you speak: ${digest.languages}`);
  if (digest.honorific) bits.push(`Address as: ${digest.honorific}`);
  if (digest.about) bits.push(`About: ${digest.about}`);
  if (digest.notes) bits.push(`Standing notes:\n${digest.notes}`);
  return ["Here's what I have saved about you:", ...bits].join("\n");
}

/**
 * One block for `identity.compile()`. Empty profile still forbids inventing a
 * name or using the project publisher as a nickname.
 */
export function addressDirective(): string {
  const digest = userProfileDigest();
  const bits: string[] = [];
  if (digest.honorific) {
    bits.push(
      `Address the person you are helping as "${digest.honorific}". Never use the project publisher or creator name as a nickname.`,
    );
  } else {
    bits.push(
      "Do not use a personal name or honorific when addressing the person you are helping.",
    );
  }
  bits.push(
    "If the conversational user profile has no name, do not invent one. Never copy the project owner/publisher string into greetings, thanks, or small talk.",
  );
  if (digest.preferredName && !digest.useNameInAddress) {
    bits.push(
      `You may know they go by "${digest.preferredName}", but do not use that name when addressing them unless they turn that on.`,
    );
  }
  if (digest.occupation) bits.push(`Their work: ${digest.occupation}.`);
  if (digest.location) bits.push(`They are based in ${digest.location}.`);
  if (digest.languages) bits.push(`Languages they speak: ${digest.languages}.`);
  if (digest.about) bits.push(`About them: ${digest.about}`);
  if (digest.notes) bits.push(`Standing facts they asked you to remember:\n${digest.notes}`);
  return bits.join(" ");
}
