// FRIDAY · skill: saf-password-check
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Estimate how strong a password is without ever repeating it: length, character kinds, guessable patterns, entropy.

const COMMON = new Set(
  (
    "password passw0rd password1 password123 123456 1234567 12345678 123456789 1234567890 qwerty qwerty123 qwertyuiop " +
    "abc123 letmein welcome welcome1 admin admin123 iloveyou monkey dragon football login master sunshine princess " +
    "111111 000000 123123 changeme secret hello123 india123 india@123 test1234 default guest root"
  ).split(" "),
);
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i" };
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm", "1234567890"];

function human(seconds) {
  if (seconds < 1) return "instantly";
  const units = [
    ["year", 31557600],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
    ["second", 1],
  ];
  if (seconds > 31557600 * 1e9) return "longer than the age of the universe";
  for (const [name, s] of units) {
    if (seconds >= s) {
      const v = Math.floor(seconds / s);
      return `about ${v.toLocaleString("en-US")} ${name}${v === 1 ? "" : "s"}`;
    }
  }
  return "instantly";
}

function extract(input) {
  if (input.password != null) return String(input.password);
  const t = String(input?.prompt ?? input?.text ?? "");
  let m = /["“'‘`]([^"”'’`]{1,128})["”'’`]/.exec(t);
  if (m) return m[1];
  m =
    /password\s*(?:is|=|:)\s*(\S+)/i.exec(t) ||
    /\bis\s+(\S+)\s+(?:a\s+)?(?:strong|safe|good|secure|weak)/i.exec(t);
  if (m) return m[1];
  m = /(?:check|test|rate)\s+(?:the\s+)?(?:strength\s+of\s+)?(?:password\s+)?(\S+)$/i.exec(
    t.trim(),
  );
  return m ? m[1] : null;
}

export async function run(input = {}) {
  const pw = extract(input);
  if (!pw)
    return { ok: false, error: "Give the password in quotes, e.g. is 'Tr0ub4dor&3' strong?" };
  const chars = [...pw];
  const len = chars.length;
  const kinds = {
    lower: /\p{Ll}/u.test(pw),
    upper: /\p{Lu}/u.test(pw),
    digits: /\d/.test(pw),
    symbols: /[^\p{L}\p{N}\s]/u.test(pw),
    spaces: /\s/.test(pw),
  };
  let pool = 0;
  if (kinds.lower) pool += 26;
  if (kinds.upper) pool += 26;
  if (kinds.digits) pool += 10;
  if (kinds.symbols) pool += 33;
  if (kinds.spaces) pool += 1;
  if (/[^\x00-\x7f]/.test(pw)) pool += 100;
  pool = Math.max(pool, 10);

  const lower = pw.toLowerCase();
  const base = lower.replace(/[\d\W_]+$/g, "");
  const deleet = [...base].map((c) => LEET[c] ?? c).join("");
  const flags = [];
  const isCommon = [lower, base, deleet, [...lower].map((c) => LEET[c] ?? c).join("")].some((c) =>
    COMMON.has(c),
  );
  if (isCommon) flags.push("is one of the most common passwords");

  // Characters that add little: runs of one character, and ascending or descending sequences.
  const weak = new Array(len).fill(false);
  for (let i = 0; i + 2 < len; i++) {
    const a = chars[i].codePointAt(0);
    const b = chars[i + 1].codePointAt(0);
    const c = chars[i + 2].codePointAt(0);
    if (a === b && b === c) [i, i + 1, i + 2].forEach((k) => (weak[k] = true));
    else if (b - a === c - b && Math.abs(b - a) === 1)
      [i, i + 1, i + 2].forEach((k) => (weak[k] = true));
  }
  for (const row of ROWS) {
    for (const r of [row, [...row].reverse().join("")]) {
      for (let i = 0; i + 4 <= r.length; i++) {
        const piece = r.slice(i, i + 4);
        let at = lower.indexOf(piece);
        while (at >= 0) {
          for (let k = 0; k < 4; k++) weak[at + k] = true;
          at = lower.indexOf(piece, at + 1);
        }
      }
    }
  }
  const weakCount = weak.filter(Boolean).length;
  if (weakCount) flags.push("has repeated characters or an easy sequence (aaa, 123, abc, qwer)");
  if (/(?:19|20)\d{2}\b/.test(pw)) flags.push("contains something that looks like a year");
  if (len < 12) flags.push("shorter than 12 characters");

  let bits = (len - weakCount * 0.75) * Math.log2(pool);
  if (isCommon) bits = Math.min(bits, 10);
  bits = Math.max(0, Math.round(bits * 10) / 10);
  const verdict =
    bits < 28
      ? "very weak"
      : bits < 36
        ? "weak"
        : bits < 60
          ? "fair"
          : bits < 80
            ? "strong"
            : "very strong";
  const seconds = Math.pow(2, bits) / 2 / 1e10;
  const tips = [];
  if (len < 14) tips.push("Use 14 or more characters; length helps most.");
  if (!kinds.symbols && !kinds.spaces)
    tips.push("A passphrase of 4 or more random words is easier to remember and stronger.");
  tips.push("Use a different password for every site, kept in a password manager.");
  return {
    ok: true,
    length: len,
    kinds,
    entropyBits: bits,
    verdict,
    crackTimeOfflineFastHash: human(seconds),
    flags,
    tips,
    answer: `${verdict} (${bits} bits, ${len} characters). An attacker with a fast offline attack needs ${human(seconds)}.${flags.length ? ` Problems: ${flags.join("; ")}.` : ""}`,
  };
}

export default run;
