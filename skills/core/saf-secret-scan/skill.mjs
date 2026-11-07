// FRIDAY · skill: saf-secret-scan
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Finds API keys, tokens and private keys in text before it is pasted, committed or sent anywhere.
// A secret is never echoed in full: findings show a short masked preview, and a redacted copy is returned.

const RULES = [
  [
    "private key block",
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
    "high",
  ],
  ["AWS access key id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, "high"],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, "high"],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "high"],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/, "high"],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "high"],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, "high"],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{30,}\b/, "high"],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/, "high"],
  ["Stripe live key", /\b[sr]k_live_[0-9A-Za-z]{16,}\b/, "high"],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, "medium"],
  ["Bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i, "medium"],
  ["password in a URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@[^\s/]+/i, "high"],
  [
    "credential assignment",
    /\b(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|auth)\b["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/i,
    "medium",
  ],
];

const PLACEHOLDER =
  /^(?:x{4,}|\*{4,}|your[_-]|<.*>|\$\{.*\}|\{\{.*\}\}|example|changeme|placeholder|dummy|test|sample|none|null|true|false)/i;

function entropy(text) {
  const counts = new Map();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / text.length) * Math.log2(n / text.length);
  return h;
}

const mask = (value) =>
  value.length <= 8 ? "****" : `${value.slice(0, 4)}…${"*".repeat(4)} (${value.length} chars)`;

export async function run(input = {}) {
  const text = String(input?.text ?? input?.prompt ?? input?.code ?? "");
  if (!text.trim()) return { ok: false, error: "Paste the text, config or code to scan." };
  const lines = text.split(/\r?\n/);
  const findings = [];
  let redacted = text;
  const seen = new Set();
  lines.forEach((line, index) => {
    for (const [kind, pattern, severity] of RULES) {
      const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
      for (const m of line.matchAll(new RegExp(pattern.source, flags))) {
        const secret = m[1] ?? m[0];
        if (PLACEHOLDER.test(secret)) continue;
        if (kind === "credential assignment" && entropy(secret) < 2.5) continue;
        const key = `${index}:${secret}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({ line: index + 1, kind, severity, preview: mask(secret) });
        redacted = redacted.split(secret).join(`[REDACTED ${kind.toUpperCase()}]`);
      }
    }
    // A long random-looking token that no named rule caught.
    for (const m of line.matchAll(/\b[A-Za-z0-9+/_-]{32,}={0,2}\b/g)) {
      const token = m[0];
      // A plain hex hash (a checksum, a commit id) is not a secret.
      if (seen.has(`${index}:${token}`) || /^[a-f0-9]{32,64}$/i.test(token) || entropy(token) < 4.2)
        continue;
      if (findings.some((f) => f.line === index + 1)) continue;
      seen.add(`${index}:${token}`);
      findings.push({
        line: index + 1,
        kind: "high-entropy string",
        severity: "low",
        preview: mask(token),
      });
      redacted = redacted.split(token).join("[REDACTED HIGH-ENTROPY STRING]");
    }
  });
  const high = findings.filter((f) => f.severity === "high").length;
  return {
    ok: true,
    safeToShare: findings.length === 0,
    answer: findings.length
      ? `${findings.length} possible secret(s) (${high} high severity). Do not paste, commit or send this text as it is.`
      : "No secrets found by these rules. This is a pattern check, not a guarantee.",
    findings,
    redacted: findings.length ? redacted : undefined,
    nextStep: findings.length
      ? "Revoke or rotate anything real that was exposed, and keep the key in the credential store, never in text or code."
      : undefined,
  };
}

export default run;
