/**
 * FRIDAY · billing firewall (main process, last line of defence).
 *
 * The model router decides *which* model should answer. This file decides
 * whether that request is allowed to leave the machine and cost money, and it
 * sits BELOW the router, at the provider-request boundary:
 *
 *   Agent / Task → Model Router → Provider Adapter → BILLING FIREWALL → API
 *
 * Nothing may bypass it: chat turns, agents, tools, plugins, workflows,
 * schedulers, background jobs and remote clients all reach a provider through
 * the same dispatch, so a single guard here covers every caller.
 *
 * Absolute rules encoded here:
 *   • a configured paid API key is NOT authorisation to spend;
 *   • automatic routing may never unlock paid inference by itself;
 *   • unknown billing status is only usable under free-first/manual routing;
 *   • the kill switch overrides everything.
 *
 * Pure logic — no Electron, no disk, no HTTP — so the app and the unit tests
 * exercise exactly the same decision.
 */

const billingPolicy = require("./billing-policy.cjs");
const modelAccess = require("./model-access.cjs");

/** Local inference costs nothing; everything else must prove it is free. */
const LOCAL_KINDS = new Set([
  "local",
  "ollama",
  "llama.cpp",
  "llamacpp",
  "lmstudio",
  "vllm",
  "localai",
  "jan",
  "mlx",
]);

/**
 * The billing class of one concrete request.
 * "free"    — verified free: local, or a provider/model explicitly known free.
 * "paid"    — known to bill.
 * "unknown" — unverified. Eligible only in free-first/manual routing.
 *
 * A raw inventory spec (health probe, kernel payload) often has no `access`
 * stamp yet. The model router still knows that provider, so we ask it rather
 * than treating a pasted Gemini/Groq key as unknown-cost and blocking it
 * until the owner unlocks paid spend.
 */
function billingClass(model) {
  if (!model || typeof model !== "object") return "unknown";
  if (modelAccess.isLocalModel(model)) return "free";
  const kind = String(model.type || model.meta?.kind || "").toLowerCase();
  if (LOCAL_KINDS.has(kind)) return "free";
  const record =
    (model.accessRecord && typeof model.accessRecord === "object" && model.accessRecord) ||
    (model.meta?.accessRecord &&
      typeof model.meta.accessRecord === "object" &&
      model.meta.accessRecord) ||
    (model.access && typeof model.access === "object" && model.access.billingMode
      ? model.access
      : null);
  if (record) {
    if (record.eligibility === "EXHAUSTED" || record.eligibility === "NOT_ELIGIBLE") {
      return record.billingMode === "PAID" ? "paid" : "unknown";
    }
    const coarse = modelAccess.coarseAccess(record);
    if (coarse === "free" || coarse === "paid" || coarse === "unknown") return coarse;
  }
  const access = String(typeof model.access === "string" ? model.access : "").toLowerCase();
  if (access === "free" || access === "paid" || access === "unknown") return access;
  return modelAccess.classifyAccess(model);
}

/** Is this request known to be safely free? Unknown remains unverified. */
const isBillable = (model) => billingClass(model) !== "free";

/**
 * The one decision every provider request must pass.
 *
 * @param {object} options
 *  - model:        the resolved model spec about to be dispatched
 *  - billing:      the stored billing record (any shape; normalised here)
 *  - explicitPaid: the OWNER picked this paid model for this request
 *  - policy:       the effective usage policy the router ran with
 *  - now:          clock injection for tests
 * @returns {{allowed: boolean, billingClass: string, reason: string, requiresApproval: boolean}}
 */
function guardProviderRequest(options = {}) {
  const {
    model = null,
    billing = null,
    explicitPaid = false,
    policy = null,
    now = Date.now(),
  } = options;

  const klass = billingClass(model);
  // Paid-only is the invert of free-only: free and unverified models are
  // excluded before the usual unlock path. Paid models still need paidAccess
  // / autoPaidUsage / explicit pick and still honour the kill switch.
  if (policy === "paid-only" && klass !== "paid") {
    return {
      allowed: false,
      billingClass: klass,
      requiresApproval: false,
      reason: "the current cost mode is paid-only — free and unverified models are excluded",
    };
  }
  if (klass === "free") {
    return {
      allowed: true,
      billingClass: "free",
      requiresApproval: false,
      reason: "official free evidence or local — no spending possible",
    };
  }

  // Unknown-cost, exhausted credits, and paid models all need owner
  // authorisation. An API key alone is not consent, and free-only never
  // falls through to a paid call.
  const unlocked = billingPolicy.paidUnlocked(billing, now);
  if (!unlocked.allowed) {
    return {
      allowed: false,
      billingClass: klass,
      requiresApproval: true,
      reason:
        klass === "unknown"
          ? "billing status for this model is unverified, so FRIDAY treats it as paid — paid AI access is off"
          : unlocked.reason,
    };
  }

  const state = billingPolicy.normaliseBilling(billing);
  // Paid access is unlocked, but automatic routing still may not spend on its
  // own: without AUTO_PAID_USAGE only a model the owner picked may bill.
  if (!explicitPaid && !state.autoPaidUsage) {
    return {
      allowed: false,
      billingClass: klass,
      requiresApproval: true,
      reason: "automatic paid usage is off — pick this model yourself to allow it to bill",
    };
  }
  // A free-only policy is a hard floor even when paid access is unlocked.
  if (policy === "free-only") {
    return {
      allowed: false,
      billingClass: klass,
      requiresApproval: true,
      reason: "the current cost mode is free-only — paid models are excluded",
    };
  }

  return {
    allowed: true,
    billingClass: klass,
    requiresApproval: false,
    reason: explicitPaid ? "owner selected this paid model" : unlocked.reason,
  };
}

/** Short line for logs and for the message the owner sees when blocked. */
function describeBlock(decision, model) {
  const label = model?.label || model?.id || "this model";
  return `${label} was blocked by FRIDAY's billing firewall: ${decision.reason}.`;
}

module.exports = {
  LOCAL_KINDS,
  billingClass,
  isBillable,
  guardProviderRequest,
  describeBlock,
};
