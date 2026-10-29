/**
 * FRIDAY · tool authority (main process, authoritative).
 *
 * A tool call used to be trusted because the caller said `approved: true`.
 * Anything reaching the kernel bridge could therefore grant itself shell,
 * filesystem and PC-control rights. This module removes that trust:
 *
 *   caller → main process policy → SIGNED, SINGLE-USE AUTHORIZATION → kernel
 *
 * The kernel refuses every non-safe tool without a valid authorization, and
 * only this process (and the kernel's own planner, which shares the secret)
 * can mint one. Tokens are bound to the exact tool AND the exact arguments,
 * expire in seconds and carry a nonce the kernel spends on first use.
 *
 * Pure logic — no Electron, no disk — so the app and the tests share it.
 */

const crypto = require("node:crypto");

/** Default decision per risk tier. Reads are free; anything else is asked. */
const RISK_DEFAULT = { safe: "allow", write: "ask", exec: "ask" };
const DECISIONS = ["allow", "ask", "deny"];
/** A token is only useful for the request it was minted for. */
const TOKEN_TTL_MS = 30_000;

/** Stable JSON so the JS signer and the Python verifier hash identically. */
function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function hashArgs(args) {
  return crypto
    .createHash("sha256")
    .update(canonical(args && typeof args === "object" ? args : {}))
    .digest("hex");
}

/**
 * The decision for one tool call, from the owner's stored policy.
 * `policy` maps a tool name to "allow" | "ask" | "deny"; unknown tools fall
 * back to the risk tier default, and an unknown tier is treated as "exec".
 */
function decide(toolName, risk, policy = {}) {
  const stored = policy && typeof policy === "object" ? policy[toolName] : null;
  // A stored deny always wins. A stored allow cannot weaken write/exec — those
  // owner rules are not settings. Safe tools may still be remembered as allow.
  if (stored === "deny") return "deny";
  if (stored === "allow" && risk !== "safe") return "ask";
  if (DECISIONS.includes(stored)) return stored;
  return RISK_DEFAULT[risk] || "ask";
}

/** Signs one authorization. Never call this without an owner-backed decision. */
function issue(
  secret,
  { tool, args = {}, risk = "exec", requester = "desktop", now = Date.now() },
) {
  if (!secret) throw new Error("tool authority secret is not configured");
  const payload = {
    tool,
    argsHash: hashArgs(args),
    risk,
    requester,
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: now + TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `v1.${body}.${signature}`;
}

/** Human-readable line for the approval prompt and the logs. */
function describe(tool, risk, args) {
  const detail = canonical(args);
  const shown = detail.length > 300 ? `${detail.slice(0, 300)}…` : detail;
  return `${tool} (${risk}) — ${shown}`;
}

module.exports = {
  RISK_DEFAULT,
  DECISIONS,
  TOKEN_TTL_MS,
  canonical,
  hashArgs,
  decide,
  issue,
  describe,
};
