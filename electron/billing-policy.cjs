/**
 * FRIDAY · billing safety policy (main process, authoritative).
 *
 * The absolute rule this file encodes: a configured paid API key is NOT
 * permission to spend money. Paid inference stays locked until the owner
 * turns it on explicitly, and an emergency kill switch overrides everything.
 *
 * Pure logic only — no Electron, no disk, no HTTP — so `electron/main.cjs`
 * and the unit tests drive exactly the same rules.
 */

/** How a paid unlock was granted. */
const GRANT_SCOPES = ["off", "request", "session", "always"];
/** A session unlock expires on its own so a forgotten toggle cannot bill. */
const SESSION_GRANT_MS = 60 * 60 * 1000;

const DEFAULT_BILLING = {
  /** Master switch. Off = paid models can never be routed to. */
  paidAccess: false,
  /** May automatic routing choose a paid model on its own? Off by default. */
  autoPaidUsage: false,
  /** Emergency stop: blocks every paid model regardless of other settings. */
  killSwitch: false,
  /** Temporary unlock: "off" | "request" | "session" | "always". */
  grantScope: "off",
  /** Epoch ms a "session" grant expires at. */
  grantUntil: 0,
  grantedAt: 0,
};

const bool = (value, fallback = false) => (typeof value === "boolean" ? value : fallback);
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Any stored shape (or nothing) becomes a complete, safe billing record. */
function normaliseBilling(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const scope = GRANT_SCOPES.includes(source.grantScope) ? source.grantScope : "off";
  return {
    paidAccess: bool(source.paidAccess, DEFAULT_BILLING.paidAccess),
    autoPaidUsage: bool(source.autoPaidUsage, DEFAULT_BILLING.autoPaidUsage),
    killSwitch: bool(source.killSwitch, DEFAULT_BILLING.killSwitch),
    grantScope: scope,
    grantUntil: num(source.grantUntil),
    grantedAt: num(source.grantedAt),
  };
}

/** True while a temporary grant is still valid. */
function grantActive(billing, now = Date.now()) {
  const state = normaliseBilling(billing);
  if (state.grantScope === "always" || state.grantScope === "request") return true;
  if (state.grantScope === "session") return state.grantUntil > now;
  return false;
}

/**
 * May paid inference happen at all right now?
 * Returns the decision plus the plain reason shown to the owner.
 */
function paidUnlocked(billing, now = Date.now()) {
  const state = normaliseBilling(billing);
  if (state.killSwitch)
    return { allowed: false, reason: "emergency kill switch is on — paid models are blocked" };
  if (state.paidAccess) return { allowed: true, reason: "paid AI access is enabled by the owner" };
  if (grantActive(state, now))
    return { allowed: true, reason: `paid usage granted for this ${state.grantScope}` };
  return { allowed: false, reason: "paid AI access is off — free and local models only" };
}

/**
 * The usage policy the router must enforce for ONE request.
 *
 * `explicitPaid` means the owner deliberately picked a paid model for this
 * request; automatic routing never sets it.
 */
function effectivePolicy(billing, options = {}) {
  const { requested = null, explicitPaid = false, now = Date.now() } = options;
  const unlocked = paidUnlocked(billing, now);
  // Paid access being off blocks paid requests at the billing firewall. It
  // must not silently collapse the default free-first setting into strict
  // free-only, because that would also reject connected unknown-cost models.
  if (!unlocked.allowed) {
    if (requested === "free-only") return "free-only";
    // Keep paid-only so the router does not silently fall back to free models.
    if (requested === "paid-only") return "paid-only";
    return "free-preferred";
  }
  const state = normaliseBilling(billing);
  if (explicitPaid) {
    if (requested === "free-only") return "free-only";
    if (requested === "paid-only") return "paid-only";
    return "allow-paid";
  }
  if (!state.autoPaidUsage) {
    if (requested === "free-only") return "free-only";
    if (requested === "paid-only") return "paid-only";
    return "free-preferred";
  }
  return requested === "allow-paid" ||
    requested === "free-preferred" ||
    requested === "free-only" ||
    requested === "paid-only"
    ? requested
    : "free-preferred";
}

/** Applies an owner grant, returning the new billing record. */
function applyGrant(billing, scope, now = Date.now()) {
  const state = normaliseBilling(billing);
  const next = GRANT_SCOPES.includes(scope) ? scope : "off";
  if (state.killSwitch && next !== "off") return state; // kill switch wins
  return {
    ...state,
    grantScope: next,
    grantedAt: next === "off" ? 0 : now,
    grantUntil: next === "session" ? now + SESSION_GRANT_MS : 0,
  };
}

/** A one-shot ("request") grant is spent after it is used once. */
function consumeGrant(billing) {
  const state = normaliseBilling(billing);
  if (state.grantScope !== "request") return state;
  return { ...state, grantScope: "off", grantedAt: 0, grantUntil: 0 };
}

/** Engaging the kill switch also clears any grant. */
function setKillSwitch(billing, on) {
  const state = normaliseBilling(billing);
  if (!on) return { ...state, killSwitch: false };
  return { ...state, killSwitch: true, grantScope: "off", grantUntil: 0, grantedAt: 0 };
}

/** One honest line for the UI and the logs. */
function describeBilling(billing, now = Date.now()) {
  const state = normaliseBilling(billing);
  const unlocked = paidUnlocked(state, now);
  if (!unlocked.allowed) return unlocked.reason;
  return state.autoPaidUsage
    ? "paid AI access is on and automatic routing may use paid models"
    : "paid AI access is on, but only models you pick explicitly may bill";
}

module.exports = {
  GRANT_SCOPES,
  SESSION_GRANT_MS,
  DEFAULT_BILLING,
  normaliseBilling,
  grantActive,
  paidUnlocked,
  effectivePolicy,
  applyGrant,
  consumeGrant,
  setKillSwitch,
  describeBilling,
};
