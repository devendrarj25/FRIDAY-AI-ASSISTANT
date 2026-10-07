/**
 * FRIDAY · privacy / data-egress firewall (main process, last line of defence)
 *
 * The billing firewall decides whether a request may cost money. This one
 * decides whether the DATA in that request may leave this PC at all, and it
 * sits at the same chokepoint, below the router:
 *
 *   Agent / Task → Model Router → BILLING FIREWALL → PRIVACY FIREWALL → API
 *
 * TWO TIERS — this is the whole model, and it is deliberate:
 *
 *   1. SENSITIVE (credential/key material, a named password or secret, a
 *      financial or identity number) — a hard stop, every single time, in
 *      manual AND auto mode. No remembered answer, no standing grant, no
 *      bypass, connected provider or not. This is the genuinely dangerous
 *      case and it is never weakened.
 *
 *   2. EVERYTHING ELSE (private, internal, public — an email address, a phone
 *      number, a file path, FRIDAY's own file names, ordinary prose) — sent
 *      automatically to a provider the owner has ALREADY connected, with no
 *      prompt and no click. Exchanging chat messages with a connected model is
 *      FRIDAY's core function: manual mode is the owner's own explicit action,
 *      and auto mode cannot work at all if a human has to click each turn.
 *
 * A destination that is NOT an already-connected provider still asks, at every
 * level, because nothing may be sent somewhere unverified without a yes.
 * Local inference never leaves the machine, so it is never gated.
 *
 * Pure logic — no Electron, no disk, no HTTP — so the app and the unit tests
 * exercise exactly the same decision.
 */

const billingFirewall = require("./billing-firewall.cjs");

/** Classification tiers, most to least sensitive. */
const LEVELS = ["sensitive", "private", "internal", "public"];

/**
 * Signals, checked in order. Each entry: what it detects, and the plain words
 * shown to the owner in the confirmation prompt.
 */
const SIGNALS = [
  {
    level: "sensitive",
    label: "credential or key material",
    re: /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
  },
  {
    level: "sensitive",
    label: "password or secret named in the text",
    // Named secret with := / "is", or a following token that looks like a
    // secret (contains a digit) so "password hunter2" is caught without
    // also treating "password manager" as credential material.
    re: /\b(password|passwd|secret|api[ _-]?key|access[ _-]?token|private key|seed phrase)\b(?:\s*[:=]\s*|\s+is\s+|\s+(?=\S*\d))\S+/i,
  },
  {
    level: "sensitive",
    label: "PIN, passcode or one-time code named in the text",
    re: /\b(?:(?:my|the)\s+)?(pin|passcode|otp|one[ -]?time(?:\s+(?:code|password|passcode))?|cvv|cvc)\b(?:\s*(?:is|:|=)\s*|\s+(?=\d{4,}))\S+/i,
  },
  {
    level: "sensitive",
    label: "financial or identity number",
    re: /\b(?:\d[ -]?){13,19}\b|\b(aadhaar|pan card|passport|ssn|social security)\b/i,
  },
  {
    level: "sensitive",
    label: "business ledger or bank-account figures",
    re: /\bFRIDAY_LEDGER\b|\b(IFSC|IBAN)\b[-\s:]*[A-Z0-9]{6,}|\b(account (number|no\.?)|a\/c)\s*[:#]?\s*\d{8,}/i,
  },
  {
    level: "private",
    label: "a personal contact detail",
    re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b|\b\+?\d{1,3}[ -]?\d{5}[ -]?\d{5}\b/,
  },
  {
    level: "private",
    label: "a path or file from this PC",
    re: /\b[A-Za-z]:\\[^\s"']+|(?:^|\s)\/(?:home|users|mnt|etc)\/[^\s"']+/i,
  },
  {
    level: "internal",
    label: "FRIDAY's own source or configuration",
    re: /\b(electron\/|src\/lib\/friday|kernel\/|package\.json|\.env\b|FRIDAY_ROOT)\b/i,
  },
  {
    level: "internal",
    label: "machine or network detail",
    re: /\b(hostname|localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|process\.env)\b/i,
  },
];

/**
 * Classify one piece of outbound content.
 * @returns {{level: string, reasons: string[], sample: number}}
 */
function classify(content) {
  const text = typeof content === "string" ? content : safeText(content);
  if (!text.trim()) return { level: "public", reasons: [], sample: 0 };
  const reasons = [];
  // The most sensitive signal that matched wins — never the average.
  let rank = LEVELS.indexOf("public");
  for (const signal of SIGNALS) {
    if (!signal.re.test(text)) continue;
    reasons.push(signal.label);
    rank = Math.min(rank, LEVELS.indexOf(signal.level));
  }
  return { level: LEVELS[rank], reasons, sample: text.length };
}

function safeText(value) {
  try {
    return typeof value === "undefined" || value === null ? "" : JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Does this destination live outside the machine? Local inference does not. */
function isExternal(model) {
  return billingFirewall.billingClass(model) !== "free" || !isLocalKind(model);
}

function isLocalKind(model) {
  const kind = String(model?.type || model?.meta?.kind || "").toLowerCase();
  return billingFirewall.LOCAL_KINDS.has(kind);
}

/* --------------------------------------------- the two, and only two, tiers */

/**
 * Tier 2 — automatic, no click, no popup:
 *   the content is NOT sensitive AND the destination is a provider the owner
 *   has already connected. Private and internal content (an email address, a
 *   phone number, a file path, FRIDAY's own file names) rides this path too:
 *   blocking it would stop ordinary chat, which is FRIDAY's core function.
 *
 * Tier 1 — always ask, every single time, with no remembered answer:
 *   anything classified SENSITIVE (credentials, secrets, financial/identity
 *   numbers), and any destination that is not an already-connected provider.
 */
const SENSITIVE = "sensitive";

function autoSendable({ level, connected, external }) {
  return Boolean(external) && level !== SENSITIVE && Boolean(connected);
}

/** The single decision every outbound request must pass. */
function guardEgress({ model = null, content = "", destination = null, connected = false } = {}) {
  const external = !isLocalKind(model) || Boolean(destination);
  const classification = classify(content);
  if (!external) {
    return {
      external: false,
      requiresConfirmation: false,
      autoAllowed: true,
      classification,
      reason: "runs locally on this PC — nothing leaves the machine",
    };
  }
  const auto = autoSendable({ level: classification.level, connected, external });
  const where = destination || model?.label || model?.id || "an external service";
  return {
    external: true,
    requiresConfirmation: !auto,
    autoAllowed: auto,
    classification,
    reason: auto
      ? `${classification.level.toUpperCase()} content to ${where}, a provider you already connected — sent automatically`
      : classification.level === SENSITIVE
        ? `SENSITIVE content (${classification.reasons.join("; ") || "credential-like"}) would be sent to ${where}`
        : `data would be sent to ${where}, which is not a provider you have connected`,
  };
}

/** Exactly what the owner is shown before anything leaves the PC. */
function describeEgress(decision, model, destination) {
  const where = destination || model?.label || model?.id || "an external service";
  const { level, reasons, sample } = decision.classification;
  const lines = [
    `Destination: ${where} (outside this PC).`,
    `Data classification: ${level.toUpperCase()}.`,
    reasons.length
      ? `What triggered this: ${reasons.join("; ")}.`
      : "This destination is not a provider you have connected, so it still leaves this machine unverified.",
    `About ${sample} characters would be sent.`,
    "FRIDAY asks every single time for this — the answer is never remembered.",
  ];
  return lines.join("\n");
}

module.exports = {
  LEVELS,
  SIGNALS,
  classify,
  isExternal,
  isLocalKind,
  guardEgress,
  describeEgress,
  autoSendable,
};
