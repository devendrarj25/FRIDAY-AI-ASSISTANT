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

const WAY_FORWARD = "Remove it from the message, or run this turn on a local model.";

/** Luhn check for a digit string. A card is 13–19 digits that pass. */
function luhnOk(digits) {
  const value = String(digits || "");
  if (!/^\d{13,19}$/.test(value)) return false;
  let sum = 0;
  let alt = false;
  for (let i = value.length - 1; i >= 0; i -= 1) {
    let n = value.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function looksLikePhone(raw) {
  const token = String(raw || "").trim();
  if (token.startsWith("+")) return true;
  if (/^\d{1,3}[ -]\d{5}[ -]\d{5}$/.test(token)) return true;
  if (/^\d{3}[ -]\d{3}[ -]\d{4}$/.test(token)) return true;
  if (/^\(\d{3}\)\s*\d{3}[ -]\d{4}$/.test(token)) return true;
  return false;
}

function looksLikeEpoch(digits) {
  if (digits.length !== 13) return false;
  const n = Number(digits);
  return n >= 1_000_000_000_000 && n <= 4_102_444_800_000;
}

/**
 * A real card, Aadhaar, PAN, or a passport/SSN/Aadhaar/PAN word followed by
 * an identifier. The bare words, timestamps, UUIDs, order ids, and phones
 * do not match. Keep this in step with kernel/privacy.py.
 */
function financialIdentityHit(text) {
  const value = String(text || "");
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/i.test(value)) return true;
  if (/\b\d{4}[ -]\d{4}[ -]\d{4}\b/.test(value)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return true;
  if (/\b(?:aadhaar|aadhar)\b[\s:#-]*(?:number|no\.?)?[\s:#-]*\d(?:[ -]?\d){11}\b/i.test(value))
    return true;
  if (
    /\b(?:ssn|social security)\b[\s:#-]*(?:number|no\.?)?[\s:#-]*\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/i.test(
      value,
    )
  )
    return true;
  const passport = /\bpassport\b[\s:#-]*(?:number|no\.?)?[\s:#-]*([A-Z0-9][A-Z0-9-]{5,14})/i.exec(
    value,
  );
  if (passport && /\d/.test(passport[1])) return true;
  const cleaned = value.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    " ",
  );
  const cards = /(?<![A-Za-z0-9+])\d(?:[ -]?\d){12,18}(?![A-Za-z0-9])/g;
  let match;
  while ((match = cards.exec(cleaned))) {
    const raw = match[0];
    if (looksLikePhone(raw)) continue;
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    if (looksLikeEpoch(digits)) continue;
    if (luhnOk(digits)) return true;
  }
  return false;
}

/**
 * The SENSITIVE text markers (English, Hindi, Hinglish) are ONE table,
 * `config/sensitive-markers.json`, shared with kernel/privacy.py and the
 * renderer's memory policy. This file keeps no copy. If the table cannot be read
 * or a row does not compile, nothing may leave: the loader fails closed.
 */
const MARKERS_FILE = "sensitive-markers.json";
const MARKERS_MISSING_LABEL = "the sensitive-marker table could not be loaded";

/** A table that cannot be read hard-stops every non-empty message. */
const FAIL_CLOSED = [
  { level: "sensitive", label: MARKERS_MISSING_LABEL, test: (text) => String(text).trim() !== "" },
];

function loadMarkerSignals(table) {
  try {
    const rows = table && Array.isArray(table.markers) ? table.markers : [];
    const signals = rows.map((row) => ({
      level: "sensitive",
      label: String(row.label),
      re: new RegExp(String(row.pattern), String(row.flags || "")),
      folded: true,
    }));
    return signals.length ? signals : FAIL_CLOSED;
  } catch {
    return FAIL_CLOSED;
  }
}

/**
 * The `normalise` section of the same table says how speech-to-text spellings ("O T P", a Devanagari
 * digit, "pass word") fold into plain text; kernel/privacy.py and the renderer run the same steps.
 * The character classes live in the table only.
 */
function buildNormaliser(spec) {
  const dropped = new Set(spec.dropChars.map((hex) => Number.parseInt(hex, 16)));
  const digits = spec.digitRanges.map(([lo, hi]) => [
    Number.parseInt(lo, 16),
    Number.parseInt(hi, 16),
  ]);
  const separators = new RegExp(`[${spec.separators}]+`, "g");
  const runs = spec.units.map((unit) => {
    const one = `[${unit.letter}]${unit.marks ? `[${unit.marks}]*` : ""}`;
    return new RegExp(
      `(?<![${unit.guard}])${one}(?:[${spec.separators}]+${one}(?![${unit.guard}])){${spec.minRun - 1},}`,
      "g",
    );
  });
  const pairs = spec.joinPairs.map((pair) => ({
    re: new RegExp(
      `(?<![${pair.guard}])${pair.parts.join(`[${spec.separators}]+`)}(?![${pair.guard}])`,
      "g",
    ),
    joined: pair.parts.join(""),
  }));
  return (text) => {
    let out = String(text ?? "").normalize(spec.form);
    out = Array.from(out, (ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (dropped.has(code)) return "";
      const range = digits.find(([lo, hi]) => code >= lo && code <= hi);
      return range ? String(code - range[0]) : ch;
    }).join("");
    if (spec.lowercase) out = out.toLowerCase();
    for (const run of runs) out = out.replace(run, (match) => match.replace(separators, ""));
    for (const pair of pairs) out = out.replace(pair.re, pair.joined);
    return out;
  };
}

/** The text markers from the shared table, read once. A table without a usable normalise stops everything. */
let markerSignals = null;
let normaliser = (text) => String(text ?? "");
function textMarkers() {
  if (!markerSignals) {
    let table = null;
    try {
      table = require("./resource-paths.cjs").readConfigJson(MARKERS_FILE, null).value;
    } catch {
      table = null;
    }
    markerSignals = loadMarkerSignals(table);
    try {
      normaliser = buildNormaliser(table.normalise);
    } catch {
      markerSignals = FAIL_CLOSED;
    }
  }
  return markerSignals;
}

/** The text the markers are matched against, besides the raw text. */
function normaliseText(text) {
  textMarkers();
  return normaliser(text);
}

/** Signals, checked in order: the shared markers, then the financial rule, then the lower tiers. */
const OTHER_SIGNALS = [
  {
    level: "sensitive",
    label: "financial or identity number",
    test: financialIdentityHit,
    folded: true,
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
function signals() {
  return [...textMarkers(), ...OTHER_SIGNALS];
}

function classify(content) {
  const text = typeof content === "string" ? content : safeText(content);
  if (!text.trim()) return { level: "public", reasons: [], sample: 0 };
  const reasons = [];
  // The most sensitive signal that matched wins — never the average.
  let rank = LEVELS.indexOf("public");
  const all = signals();
  const folded = normaliseText(text);
  for (const signal of all) {
    const forms = signal.folded && folded !== text ? [text, folded] : [text];
    const hit = forms.some((form) =>
      typeof signal.test === "function" ? signal.test(form) : signal.re.test(form),
    );
    if (!hit) continue;
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
  const hardStop = classification.level === SENSITIVE;
  const triggered = classification.reasons.join("; ") || "credential-like";
  return {
    external: true,
    requiresConfirmation: !auto,
    autoAllowed: auto,
    hardStop,
    classification,
    reason: auto
      ? `${classification.level.toUpperCase()} content to ${where}, a provider you already connected — sent automatically`
      : hardStop
        ? `Blocked: SENSITIVE — ${triggered}. ${WAY_FORWARD} Nothing was sent to ${where}.`
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
    level === SENSITIVE
      ? `${WAY_FORWARD} FRIDAY asks every single time for this — the answer is never remembered.`
      : "FRIDAY asks every single time for this — the answer is never remembered.",
  ];
  return lines.join("\n");
}

module.exports = {
  LEVELS,
  get SIGNALS() {
    return signals();
  },
  MARKERS_FILE,
  normaliseText,
  MARKERS_MISSING_LABEL,
  loadMarkerSignals,
  WAY_FORWARD,
  luhnOk,
  financialIdentityHit,
  classify,
  isExternal,
  isLocalKind,
  guardEgress,
  describeEgress,
  autoSendable,
};
