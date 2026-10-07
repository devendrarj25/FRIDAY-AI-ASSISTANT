/**
 * FRIDAY · conversational settings changes.
 *
 * The owner can say "switch to hands-free", "prefer Groq for chat", "free
 * models only", "call me with the wake word Jarvis", "keep listening for 90
 * seconds" — in typed chat or in Auto Mode — and FRIDAY applies it through the
 * SAME stores the Settings UI writes:
 *
 *   · preferences (wake word, attention window, voice replies)
 *   · model registry (usage policy, route mode, preferred provider)
 *   · assistant mode (hands-free)
 *   · user-profile (who they are — never project owner)
 *   · identity (how FRIDAY behaves — never product/legal identity)
 *
 * Three rules make this safe:
 *   1. nothing is applied until FRIDAY has repeated back what she understood
 *      and the owner said yes — the change is staged, then confirmed;
 *   2. anything that is a security / permission tier (exec approval, workspace
 *      writes, safe tools, encryption, biometrics) is REFUSED here and sent
 *      back to Settings and the existing governance gate. This is a new
 *      interface to existing settings, never a way around permissions.
 *   3. an explicit correction ("no I meant", "that's wrong") applies
 *      user-profile and FRIDAY-behaviour keys immediately onto those same stores.
 *      Wake word, billing, hands-free and similar still wait for yes.
 */

import { preferences } from "../preferences";
import { modelRegistry as usageRegistry, type UsagePolicy } from "../model-registry";
import {
  ATTENTION_FIELD,
  attentionWindowSeconds,
  clampAttentionSeconds,
} from "../attention-window";
import {
  userProfile,
  vocative,
  type AddressAs,
  appendUserNotes,
  dropUserNotes,
  clearUserDetails,
} from "./user-profile";
import { memory } from "../self/memory-engine";
import { identity, type ReplyLanguage, type ReplyTone, type ResponseStyle } from "./identity";
import { looksLikeCorrection } from "./intent-engine";
import { looksLikeLibraryTeach } from "../library-logic";

export type StagedChange = {
  /** Stable key of the setting being changed. */
  key: string;
  /** What FRIDAY repeats back before applying. */
  summary: string;
  from: string;
  to: string;
  apply: () => Promise<void>;
  at: number;
};

export type SettingsIntent =
  | { kind: "staged"; message: string; change: StagedChange }
  | { kind: "applied"; message: string }
  | { kind: "cancelled"; message: string }
  | { kind: "refused"; message: string }
  | null;

/** Settings that must keep going through Settings + governance, never chat. */
const PROTECTED =
  /\b(exec(ution)? approval|workspace writes?|safe tools?|encryption|biometric|secure comm|permission(s| broker| tier)?|privacy( firewall)?|governance|billing( firewall)?|tool[- ]authority|approval (gate|code)|security tier|admin rights?|elevate)\b/i;

const AFFIRM = /^(yes|yeah|yep|ya|haan|haa|ok|okay|do it|go ahead|confirm|apply|sure|kar do)\b/i;
/** Whole-utterance cancel only — "no humour" / "no, I meant …" are new requests. */
const DENY_CONFIRM = /^(no|nope|nah|cancel|stop|don'?t|na|nahi|leave it|forget it)[.!?\s]*$/i;

let staged: StagedChange | null = null;
/** Staged changes expire so an old "yes" can never apply a stale change. */
const STAGE_TTL_MS = 120_000;

/**
 * User-profile and FRIDAY-behaviour keys. Wake word, billing, hands-free and
 * similar stay stage-then-yes even after a correction (no silent policy drift).
 */
const LEARNABLE_KEYS = new Set([
  "how to address you",
  "your name",
  "your work",
  "your location",
  "languages you speak",
  "about you",
  "standing note about you",
  "your saved details",
  "answer length",
  "tone",
  "humour",
  "emoji",
  "reply language",
  "show reasoning",
  "answer format",
  "when uncertain",
  "custom instructions",
  "personality notes",
]);

/** When true, `stage()` applies learnable keys immediately (verified correction). */
let learnNow = false;
let forceLearn = false;

export function pendingChange(): StagedChange | null {
  if (staged && Date.now() - staged.at > STAGE_TTL_MS) staged = null;
  return staged;
}

/** Test/teardown helper — drops any staged change. */
export function clearPendingChange(): void {
  staged = null;
}

function stage(change: Omit<StagedChange, "at">): SettingsIntent {
  if (learnNow && LEARNABLE_KEYS.has(change.key)) {
    void change.apply().catch(() => undefined);
    staged = null;
    return {
      kind: "applied",
      message: `Got it — ${change.key} is now ${change.to}. Same setting the Settings page writes, so it holds across restarts.`,
    };
  }
  staged = { ...change, at: Date.now() };
  return {
    kind: "staged",
    change: staged,
    message: `${change.summary} Currently it is ${change.from}. Say yes and I'll apply it.`,
  };
}

/**
 * Promote an explicit correction onto the user profile or FRIDAY behaviour
 * store — not a second memory LLM. Security / billing / wake-word stay staged.
 */
export function applyVerifiedCorrection(text: string): { applied: boolean; key: string | null } {
  const clean = String(text || "").trim();
  if (!clean) return { applied: false, key: null };
  const prior = staged;
  staged = null;
  forceLearn = true;
  try {
    const intent = readSettingsIntent(clean);
    if (intent?.kind === "applied") {
      const match = intent.message.match(/^Got it — (.+?) is now /);
      return { applied: true, key: match?.[1] ?? "applied" };
    }
    if (intent?.kind === "refused") return { applied: false, key: null };
    return { applied: false, key: null };
  } finally {
    forceLearn = false;
    learnNow = false;
    staged = prior;
  }
}

const snapshot = () => {
  try {
    return usageRegistry.getSnapshot();
  } catch {
    return null;
  }
};

function rememberUserFact(title: string, text: string): void {
  memory.remember({
    tier: "semantic",
    kind: "preference",
    title,
    text,
    tags: ["preference", "user-profile"],
    source: "settings-intent",
    confidence: 0.9,
  });
}

function rememberAddressPreference(): void {
  const profile = userProfile.getSnapshot();
  rememberUserFact(
    "How to address the user",
    `Address as ${vocative() || "no honorific"}. Use name in address: ${profile.useNameInAddress ? "yes" : "no"}.`,
  );
}

function rememberFridayBehaviour(summary: string): void {
  memory.remember({
    tier: "semantic",
    kind: "preference",
    title: "FRIDAY behaviour",
    text: summary,
    tags: ["preference", "friday-persona"],
    source: "settings-intent",
    confidence: 0.9,
  });
}

/** Project owner / copyright / product name — Settings and chat cannot change these. */
function looksLikeLockedProjectChange(text: string): boolean {
  if (/\b(wake word|call me with|call you with)\b/i.test(text)) return false;
  if (/\bcall you\b/i.test(text) && /\bwake\b/i.test(text)) return false;
  if (
    /\b(change|set|rename|update|replace|overwrite|edit)\b.{0,48}\b(owner|creator|publisher|copyright|author)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(owner|creator|publisher|copyright|author).{0,48}\b(change|set|rename|update|replace)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (
    /\b(you belong to|your owner is|your creator is|your publisher is|change (the )?copyright)\b/i.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b(rename (yourself|friday)|call yourself|your name is now)\b/i.test(text)) return true;
  return false;
}

const LOCKED_PROJECT_MESSAGE =
  "Project owner, creator, publisher and copyright are fixed. I cannot change them from conversation or Settings.";

const POLICIES: { test: RegExp; policy: UsagePolicy; label: string }[] = [
  {
    test: /\b(paid only|only paid)\b/i,
    policy: "paid-only",
    label: "paid only",
  },
  {
    test: /\b(free only|only free|no paid|never pay|don'?t pay)\b/i,
    policy: "free-only",
    label: "free only",
  },
  {
    test: /\b(prefer free|free first|free preferred|mostly free)\b/i,
    policy: "free-preferred",
    label: "free preferred",
  },
  {
    test: /\b(allow paid|paid allowed|paid is fine|enable paid)\b/i,
    policy: "allow-paid",
    label: "paid allowed",
  },
];

/**
 * Read one conversational settings request. Returns null when the text is not
 * a settings change at all, so the normal brain path continues untouched.
 */
export function readSettingsIntent(prompt: string): SettingsIntent {
  const text = String(prompt || "").trim();
  if (!text) return null;
  if (!forceLearn) learnNow = false;

  // 1. answer to a change FRIDAY already repeated back ----------------------
  const waiting = pendingChange();
  if (waiting) {
    if (AFFIRM.test(text)) {
      const change = waiting;
      staged = null;
      void change.apply().catch(() => undefined);
      return {
        kind: "applied",
        message: `Done — ${change.key} is now ${change.to}. Same setting the Settings page writes, so it holds across restarts.`,
      };
    }
    if (DENY_CONFIRM.test(text)) {
      staged = null;
      return { kind: "cancelled", message: "Left it as it was." };
    }
    // Anything else is a new request; fall through and re-stage.
  }

  learnNow = forceLearn || looksLikeCorrection(text);

  const asksChange = /\b(switch|change|set|make|use|prefer|turn|enable|disable|only|keep)\b/i.test(
    text,
  );

  // 2. protected tiers -------------------------------------------------------
  if (PROTECTED.test(text) && asksChange) {
    return {
      kind: "refused",
      message:
        "That one is a security/permission setting — I don't change those from a conversation. Open Settings (or approve it in the governance queue) and I'll follow whatever you set there.",
    };
  }

  // 2b. project / legal identity — never writable from chat or Settings ----
  if (looksLikeLockedProjectChange(text)) {
    return { kind: "refused", message: LOCKED_PROJECT_MESSAGE };
  }

  // 3. hands-free / wake-word gating ----------------------------------------
  const durationAsked = /\d{1,3}\s*(seconds?|secs?|s\b|minutes?|mins?)/i.test(text);
  if (
    /\bhands[- ]?free\b|\bwithout (the )?wake word\b|\bkeep listening\b/i.test(text) &&
    !/\bhow\b/i.test(text) &&
    !durationAsked
  ) {
    const off = /\b(off|disable|stop|don'?t|no)\b/i.test(text);
    return stage({
      key: "hands-free voice",
      summary: `You want hands-free ${off ? "off, so I only answer after the wake word" : "on, so I take follow-ups without the wake word"}.`,
      from: "read from the live voice session",
      to: off ? "off" : "on",
      apply: async () => {
        const { assistantMode } = await import("../assistant-mode");
        assistantMode.setHandsFree(!off);
      },
    });
  }

  // 3b. conversational address / name (user profile, not project owner) -----
  if (!/\bcall me with\b/i.test(text)) {
    const honorificMatch =
      text.match(/\b(?:call me|address me(?: as)?)\s+(sir|boss)\b/i) ??
      text.match(/\bmujhe\s+(sir|boss)(?:\s+bolo)?\b/i);
    if (honorificMatch?.[1]) {
      const next = honorificMatch[1].toLowerCase() === "boss" ? "boss" : "sir";
      const current = userProfile.getSnapshot().addressAs;
      return stage({
        key: "how to address you",
        summary: `You want me to address you as ${next === "boss" ? "Boss" : "sir"}.`,
        from: current,
        to: next,
        apply: async () => {
          userProfile.update({ addressAs: next as AddressAs, useNameInAddress: false });
          rememberAddressPreference();
        },
      });
    }

    const named =
      text.match(/\b(?:my name is|mera naam)\s+["“']?(.+?)["”']?\s*$/i) ??
      text.match(/\bcall me\s+["“']?([^"'?.!]+?)["”']?\s*$/i);
    const rawName = (named?.[1] ?? "")
      .trim()
      .replace(/\s+hai\.?$/i, "")
      .replace(/\s+/g, " ");
    const lowered = rawName.toLowerCase();
    if (rawName && !/\bwake\b/i.test(rawName) && lowered !== "sir" && lowered !== "boss") {
      const useName = /\bcall me\b/i.test(text);
      return stage({
        key: "your name",
        summary: useName
          ? `You want me to call you ${rawName}.`
          : `You want me to remember your name as ${rawName}, without using it in greetings unless you turn that on.`,
        from: userProfile.getSnapshot().preferredName || "(none)",
        to: rawName,
        apply: async () => {
          userProfile.update({ preferredName: rawName, useNameInAddress: useName });
          rememberAddressPreference();
        },
      });
    }
  }

  // 3c. user details — occupation, place, languages, about, remember/forget -
  const occupation = text.match(
    /\b(?:i work as|my (?:job|occupation|role) is|mera kaam(?: hai)?)\s+(.+)$/i,
  );
  if (occupation?.[1] && !/\b(friday|model|assistant)\b/i.test(occupation[1])) {
    const next = occupation[1].replace(/\s+hai\.?$/i, "").trim();
    if (next) {
      return stage({
        key: "your work",
        summary: `You want me to remember your work as ${next}.`,
        from: userProfile.getSnapshot().occupation || "(none)",
        to: next,
        apply: async () => {
          userProfile.update({ occupation: next });
          rememberUserFact("User work", `Works as ${next}.`);
        },
      });
    }
  }

  const locationEn = text.match(
    /\b(?:i live in|i stay in|i'?m (?:from|based in)|my (?:city|location|town) is)\s+(.+)$/i,
  );
  const locationHi = text.match(
    /\b(?:main\s+(.+?)\s+(?:me|mein) (?:rehta|rahti)|meri (?:city|jagah)(?: hai)?\s+(.+))$/i,
  );
  const nextLocation = (locationEn?.[1] || locationHi?.[1] || locationHi?.[2] || "")
    .replace(/\s+hai\.?$/i, "")
    .replace(/\s+(hoon|hun|hun\.)$/i, "")
    .trim();
  if (nextLocation && nextLocation.length < 80 && nextLocation.split(/\s+/).length <= 6) {
    return stage({
      key: "your location",
      summary: `You want me to remember you live in ${nextLocation}.`,
      from: userProfile.getSnapshot().location || "(none)",
      to: nextLocation,
      apply: async () => {
        userProfile.update({ location: nextLocation });
        rememberUserFact("User location", `Based in ${nextLocation}.`);
      },
    });
  }

  const spoken = text.match(
    /\b(?:i speak|i talk in|my languages? are|meri (?:language|bhasha)(?: hai)?)\s+(.+)$/i,
  );
  if (spoken?.[1]) {
    const next = spoken[1].replace(/\s+hai\.?$/i, "").trim();
    if (next) {
      return stage({
        key: "languages you speak",
        summary: `You want me to remember you speak ${next}.`,
        from: userProfile.getSnapshot().languages || "(none)",
        to: next,
        apply: async () => {
          userProfile.update({ languages: next });
          rememberUserFact("User languages", `Speaks ${next}.`);
        },
      });
    }
  }

  const aboutMe = text.match(
    /\b(?:about me[:-]|here's what to know about me[:-]|mere baare me[:-])\s*(.+)$/i,
  );
  if (aboutMe?.[1]) {
    const next = aboutMe[1].trim();
    if (next) {
      return stage({
        key: "about you",
        summary: `You want me to save this about you: ${next.slice(0, 120)}.`,
        from: userProfile.getSnapshot().about || "(none)",
        to: next.slice(0, 80),
        apply: async () => {
          userProfile.update({ about: next });
          rememberUserFact("About the user", next);
        },
      });
    }
  }

  const rememberThat = text.match(
    /^(?:please\s+)?(?:remember (?:that|this)|yaad rakh(?:na|o)?(?:\s+ki)?)\s+(.+)/i,
  );
  if (
    rememberThat?.[1] &&
    !/\bconversations?\b/i.test(rememberThat[1]) &&
    !looksLikeLibraryTeach(text)
  ) {
    const fact = rememberThat[1].trim();
    if (fact) {
      return stage({
        key: "standing note about you",
        summary: `You want me to remember: ${fact.slice(0, 160)}.`,
        from: userProfile.getSnapshot().notes || "(none)",
        to: fact.slice(0, 80),
        apply: async () => {
          appendUserNotes(fact);
          rememberUserFact("User standing note", fact);
        },
      });
    }
  }

  if (/\bforget everything about me\b|\bmere baare me sab (bhool|bhul)\b/i.test(text)) {
    return stage({
      key: "your saved details",
      summary: "You want me to forget everything saved about you, including your name.",
      from: "saved user profile",
      to: "cleared",
      apply: async () => {
        clearUserDetails("all");
      },
    });
  }

  if (/\bforget about me\b|\bmere baare me (bhool|bhul)\b/i.test(text)) {
    return stage({
      key: "your saved details",
      summary:
        "You want me to forget the saved details about you (name stays unless you also ask).",
      from: "saved user profile",
      to: "cleared details",
      apply: async () => {
        clearUserDetails("about");
      },
    });
  }

  if (/\bforget my name\b|\bmere naam (?:bhool|bhul)\b/i.test(text)) {
    return stage({
      key: "your name",
      summary: "You want me to forget the name saved on your profile.",
      from: userProfile.getSnapshot().preferredName || "(none)",
      to: "(none)",
      apply: async () => {
        clearUserDetails("name");
        rememberAddressPreference();
      },
    });
  }

  const forgetThat = text.match(
    /^(?:please\s+)?(?:forget that|bhool ja(?:o|na)?(?:\s+ki)?)\s+(.+)/i,
  );
  if (forgetThat?.[1] && !/^it\b/i.test(forgetThat[1])) {
    const fact = forgetThat[1].trim();
    if (fact) {
      return stage({
        key: "standing note about you",
        summary: `You want me to drop the note matching: ${fact.slice(0, 120)}.`,
        from: userProfile.getSnapshot().notes || "(none)",
        to: "(removed if present)",
        apply: async () => {
          dropUserNotes(fact);
        },
      });
    }
  }

  // 3d. FRIDAY behaviour (hers — identity store, not user-profile) ---------
  const lengthAsk = text.match(
    /\b(?:be|keep answers?|keep (?:it|them|replies)|answer|make (?:it|them|answers?))\s+(brief|short|concise|detailed|thorough|long|balanced)\b/i,
  );
  if (lengthAsk?.[1]) {
    const token = lengthAsk[1].toLowerCase();
    const next: ResponseStyle =
      token === "detailed" || token === "thorough" || token === "long"
        ? "detailed"
        : token === "balanced"
          ? "balanced"
          : "brief";
    const current = identity.getSnapshot().profile.responseStyle;
    return stage({
      key: "answer length",
      summary: `You want my answers ${next}.`,
      from: current,
      to: next,
      apply: async () => {
        identity.updateProfile({ responseStyle: next });
        rememberFridayBehaviour(`Answer length: ${next}.`);
      },
    });
  }

  const toneAsk = text.match(
    /\b(?:be|talk|sound)\s+(more\s+)?(professional|formal|warm(?:er)?|playful|direct)\b/i,
  );
  if (toneAsk?.[2]) {
    const token = toneAsk[2].toLowerCase();
    const next: ReplyTone =
      token === "professional" || token === "formal"
        ? "professional"
        : token.startsWith("playful")
          ? "playful"
          : token === "direct"
            ? "direct"
            : "warm";
    const current = identity.getSnapshot().profile.tone;
    return stage({
      key: "tone",
      summary: `You want my tone ${next}.`,
      from: current,
      to: next,
      apply: async () => {
        identity.updateProfile({ tone: next });
        rememberFridayBehaviour(`Tone: ${next}.`);
      },
    });
  }

  if (/\b(no humour|no humor|not funny|don't joke)\b/i.test(text)) {
    return stage({
      key: "humour",
      summary: "You want me to skip humour.",
      from: identity.getSnapshot().profile.humour,
      to: "none",
      apply: async () => {
        identity.updateProfile({ humour: "none" });
        rememberFridayBehaviour("Humour: none.");
      },
    });
  }
  if (/\bdry (humour|humor)\b/i.test(text)) {
    return stage({
      key: "humour",
      summary: "You want dry humour.",
      from: identity.getSnapshot().profile.humour,
      to: "dry",
      apply: async () => {
        identity.updateProfile({ humour: "dry" });
        rememberFridayBehaviour("Humour: dry.");
      },
    });
  }
  if (/\b(light humour|light humor|a (bit|little) (of )?humour)\b/i.test(text)) {
    return stage({
      key: "humour",
      summary: "You want light humour.",
      from: identity.getSnapshot().profile.humour,
      to: "light",
      apply: async () => {
        identity.updateProfile({ humour: "light" });
        rememberFridayBehaviour("Humour: light.");
      },
    });
  }

  if (/\b(no emoji|without emoji|disable emoji|don't use emoji)\b/i.test(text)) {
    return stage({
      key: "emoji",
      summary: "You want no emoji in replies.",
      from: identity.getSnapshot().profile.emoji,
      to: "off",
      apply: async () => {
        identity.updateProfile({ emoji: "off" });
        rememberFridayBehaviour("Emoji: off.");
      },
    });
  }
  if (/\bsparse emoji|few emoji\b/i.test(text)) {
    return stage({
      key: "emoji",
      summary: "You want emoji used rarely.",
      from: identity.getSnapshot().profile.emoji,
      to: "sparse",
      apply: async () => {
        identity.updateProfile({ emoji: "sparse" });
        rememberFridayBehaviour("Emoji: sparse.");
      },
    });
  }
  if (/\b(use emoji|enable emoji|with emoji)\b/i.test(text)) {
    return stage({
      key: "emoji",
      summary: "You want emoji allowed when they help.",
      from: identity.getSnapshot().profile.emoji,
      to: "on",
      apply: async () => {
        identity.updateProfile({ emoji: "on" });
        rememberFridayBehaviour("Emoji: on.");
      },
    });
  }

  const langAsk = text.match(/\breply in\s+(english|hindi|hinglish)\b/i);
  if (langAsk?.[1]) {
    const next = langAsk[1].toLowerCase() as ReplyLanguage;
    return stage({
      key: "reply language",
      summary: `You want me to reply in ${next}.`,
      from: identity.getSnapshot().profile.replyLanguage,
      to: next,
      apply: async () => {
        identity.updateProfile({ replyLanguage: next });
        rememberFridayBehaviour(`Reply language: ${next}.`);
      },
    });
  }
  if (/\bfollow (my|the user'?s?) language\b|\bmatch (my|the) language\b/i.test(text)) {
    return stage({
      key: "reply language",
      summary: "You want me to follow the language you write in.",
      from: identity.getSnapshot().profile.replyLanguage,
      to: "follow-user",
      apply: async () => {
        identity.updateProfile({ replyLanguage: "follow-user" });
        rememberFridayBehaviour("Reply language: follow-user.");
      },
    });
  }

  if (/\b(show|include) (your |the )?(reasoning|steps)\b/i.test(text)) {
    return stage({
      key: "show reasoning",
      summary: "You want reasoning steps shown in replies.",
      from: identity.getSnapshot().profile.showReasoning ? "on" : "off",
      to: "on",
      apply: async () => {
        identity.updateProfile({ showReasoning: true });
        rememberFridayBehaviour("Show reasoning: on.");
      },
    });
  }
  if (/\b(hide|hide your|don't show) (your |the )?(reasoning|steps)\b/i.test(text)) {
    return stage({
      key: "show reasoning",
      summary: "You want reasoning kept out of replies.",
      from: identity.getSnapshot().profile.showReasoning ? "on" : "off",
      to: "off",
      apply: async () => {
        identity.updateProfile({ showReasoning: false });
        rememberFridayBehaviour("Show reasoning: off.");
      },
    });
  }

  if (/\b(use|prefer) bullet(s| points)\b|\banswer in bullets\b/i.test(text)) {
    return stage({
      key: "answer format",
      summary: "You want bullet lists when there are several points.",
      from: identity.getSnapshot().profile.answerFormat,
      to: "bullets",
      apply: async () => {
        identity.updateProfile({ answerFormat: "bullets" });
        rememberFridayBehaviour("Format: bullets.");
      },
    });
  }
  if (/\b(write in|use) prose\b|\bno bullets\b/i.test(text)) {
    return stage({
      key: "answer format",
      summary: "You want prose instead of bullets.",
      from: identity.getSnapshot().profile.answerFormat,
      to: "prose",
      apply: async () => {
        identity.updateProfile({ answerFormat: "prose" });
        rememberFridayBehaviour("Format: prose.");
      },
    });
  }

  if (
    /\bwhen (you'?re |you are )?uncertain\b.*\bask\b|\bif you don'?t know\b.*\bask\b/i.test(text)
  ) {
    return stage({
      key: "when uncertain",
      summary: "When I am unsure, you want me to ask rather than guess.",
      from: identity.getSnapshot().profile.whenUncertain,
      to: "ask",
      apply: async () => {
        identity.updateProfile({ whenUncertain: "ask" });
        rememberFridayBehaviour("When uncertain: ask.");
      },
    });
  }
  if (/\b(guess and (flag|say)|say you'?re unsure and (continue|proceed))\b/i.test(text)) {
    return stage({
      key: "when uncertain",
      summary: "When I am unsure, you want a flagged guess.",
      from: identity.getSnapshot().profile.whenUncertain,
      to: "guess-and-flag",
      apply: async () => {
        identity.updateProfile({ whenUncertain: "guess-and-flag" });
        rememberFridayBehaviour("When uncertain: guess-and-flag.");
      },
    });
  }
  if (/\b(don't guess|say you don'?t know|say unknown)\b/i.test(text)) {
    return stage({
      key: "when uncertain",
      summary: "When I am unsure, you want me to say I do not know.",
      from: identity.getSnapshot().profile.whenUncertain,
      to: "say-unknown",
      apply: async () => {
        identity.updateProfile({ whenUncertain: "say-unknown" });
        rememberFridayBehaviour("When uncertain: say-unknown.");
      },
    });
  }

  const standing = text.match(/^(?:from now on(?: always)?|hamesha)[:,]?\s+(.+)$/i);
  if (standing?.[1] && !/\b(call me|wake|hands[- ]?free)\b/i.test(standing[1])) {
    const next = standing[1].trim();
    const current = identity.getSnapshot().profile.customInstructions.trim();
    return stage({
      key: "custom instructions",
      summary: `You want this always to apply: ${next.slice(0, 160)}.`,
      from: current || "(none)",
      to: next.slice(0, 80),
      apply: async () => {
        const merged = [current, next].filter(Boolean).join("\n");
        identity.updateProfile({ customInstructions: merged });
        rememberFridayBehaviour(`Standing instruction: ${next}`);
      },
    });
  }

  const persona = text.match(
    /^(?:your personality(?: should be| is)?|personality notes?)\s*[:-]\s*(.+)$/i,
  );
  if (persona?.[1]) {
    const next = persona[1].trim();
    return stage({
      key: "personality notes",
      summary: `You want personality notes set to: ${next.slice(0, 120)}.`,
      from: preferences.getSnapshot().fields["personality"] || "(none)",
      to: next.slice(0, 80),
      apply: async () => {
        preferences.setField("personality", next);
        await preferences.flush();
        rememberFridayBehaviour(`Personality notes: ${next}`);
      },
    });
  }

  // 4. wake word -------------------------------------------------------------
  const wake = text.match(
    /\b(?:wake word|wake-word|call you|call me with)\s*(?:should be|to|is|as)?\s*["“']?([a-z][a-z0-9 ]{1,20}?)["”']?\s*$/i,
  );
  if (wake?.[1] && asksChange) {
    const word = wake[1].trim().toLowerCase();
    return stage({
      key: "wake word",
      summary: `You want my wake word changed to "${word}".`,
      from: `"${preferences.getSnapshot().voice.wakeWord}"`,
      to: `"${word}"`,
      apply: async () => {
        preferences.setVoice({ wakeWord: word });
        await preferences.flush();
      },
    });
  }

  // 5. attention window ------------------------------------------------------
  const window = text.match(
    /\b(attention window|keep listening|stay awake|listen(?:ing)? window)\b[^0-9]{0,20}(\d{1,3})\s*(second|sec|s|minute|min)?/i,
  );
  if (window?.[2]) {
    const raw = Number.parseInt(window[2], 10);
    const seconds = clampAttentionSeconds(/min/i.test(window[3] ?? "") ? raw * 60 : raw);
    return stage({
      key: "attention window",
      summary: `You want my attention window set to ${seconds} seconds.`,
      from: `${attentionWindowSeconds()} seconds`,
      to: `${seconds} seconds`,
      apply: async () => {
        preferences.setField(ATTENTION_FIELD, String(seconds));
        await preferences.flush();
      },
    });
  }

  // 6. free / paid policy ----------------------------------------------------
  for (const option of POLICIES) {
    if (option.test.test(text)) {
      const current = snapshot()?.policy ?? "free-preferred";
      if (current === option.policy) {
        return { kind: "refused", message: `Already on "${option.label}" — nothing to change.` };
      }
      return stage({
        key: "usage policy",
        summary: `You want my model usage policy set to ${option.label}.`,
        from: current,
        to: option.policy,
        apply: async () => {
          await usageRegistry.setPolicy(option.policy);
        },
      });
    }
  }

  // 7. preferred provider ----------------------------------------------------
  const prefer = text.match(
    /\b(prefer|use|switch to|route (?:everything )?to)\s+([a-z0-9 .-]{2,24})/i,
  );
  if (prefer?.[2]) {
    const wanted = prefer[2]
      .trim()
      .toLowerCase()
      .replace(/\s+(for|on|in)\s+.*$/, "")
      .trim();
    const models = snapshot()?.models ?? [];
    const match = models
      .filter(
        (m) =>
          m.available &&
          (m.providerId.toLowerCase() === wanted ||
            m.provider.toLowerCase() === wanted ||
            m.provider.toLowerCase().includes(wanted)),
      )
      .sort((a, b) => b.priority - a.priority)[0];
    if (!match) {
      if (!/\b(prefer|switch to|route)\b/i.test(text)) return null;
      return {
        kind: "refused",
        message: `I have no reachable model from "${wanted}" right now — connect and verify it in Connectors/Models first, then ask me again.`,
      };
    }
    const current = snapshot()?.selected ?? [];
    return stage({
      key: "preferred model",
      summary: `You want ${match.provider} preferred — I'd pin ${match.label} for new turns.`,
      from: current.length ? current.join(", ") : "automatic (nothing pinned)",
      to: match.label,
      apply: async () => {
        usageRegistry.clearSelection();
        usageRegistry.toggle(match.id);
      },
    });
  }

  // 8. spoken replies --------------------------------------------------------
  if (/\b(speak|voice) (replies|answers|responses)\b|\bstop (speaking|talking)\b/i.test(text)) {
    const off = /\b(off|stop|don'?t|disable|mute|no)\b/i.test(text);
    return stage({
      key: "spoken replies",
      summary: `You want spoken replies ${off ? "off" : "on"}.`,
      from: preferences.getSnapshot().voice.speakReplies ? "on" : "off",
      to: off ? "off" : "on",
      apply: async () => {
        preferences.setVoice({ speakReplies: !off });
        await preferences.flush();
      },
    });
  }

  return null;
}
