// FRIDAY · skill: saf-pii-redact
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Masks personal data (email, phone, PAN, Aadhaar, card, UPI id, IP address) before text goes to a cloud model.

// Verhoeff checksum: the check used by Aadhaar numbers.
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeff(digits) {
  let c = 0;
  [...digits].reverse().forEach((ch, i) => {
    c = D[c][P[i % 8][Number(ch)]];
  });
  return c === 0;
}
export function luhn(digits) {
  let sum = 0;
  [...digits].reverse().forEach((ch, i) => {
    let n = Number(ch);
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  });
  return sum % 10 === 0;
}

const KINDS = [
  { kind: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: "PAN", re: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g },
  {
    kind: "AADHAAR",
    re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    check: (m) => {
      const d = m.replace(/\D/g, "");
      return d !== [...d].reverse().join("") && verhoeff(d);
    },
  },
  {
    kind: "CARD",
    re: /\b(?:\d[ -]?){13,19}\b/g,
    check: (m) => {
      const d = m.replace(/\D/g, "");
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  {
    kind: "UPI",
    re: /\b[A-Za-z0-9._-]{2,}@(?:ok(?:hdfcbank|icici|sbi|axis)|ybl|ibl|axl|paytm|upi|apl|oksbi|sbi|hdfcbank|icici|axisbank)\b/gi,
  },
  {
    kind: "PHONE",
    re: /(?<![\d.])(?:\+91[ -]?|0)?[6-9]\d{4}[ -]?\d{5}(?![\d.])|(?<![\d.])\+\d{1,3}[ -]?\d{2,4}[ -]?\d{3,4}[ -]?\d{3,4}(?![\d.])/g,
  },
  { kind: "IP", re: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];

function partial(kind, value) {
  const d = value.replace(/\s|-/g, "");
  if (kind === "EMAIL") return value.replace(/^(.).*(@.*)$/, "$1***$2");
  if (kind === "PHONE" || kind === "AADHAAR" || kind === "CARD")
    return `${"*".repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`;
  if (kind === "PAN") return `${value.slice(0, 2)}*****${value.slice(-2)}`;
  return `[${kind}]`;
}

export async function run(input = {}) {
  const text = String(input?.text ?? input?.prompt ?? "");
  if (!text.trim()) return { ok: false, error: "Paste the text to clean." };
  const mode = String(input?.mode ?? "mask").toLowerCase() === "partial" ? "partial" : "mask";
  const counts = {};
  const taken = [];
  const hits = [];
  for (const { kind, re, check } of KINDS) {
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue; // the first kind to claim a span keeps it
      if (check && !check(m[0])) continue;
      taken.push([start, end]);
      hits.push({ kind, start, end, value: m[0] });
      counts[kind] = (counts[kind] ?? 0) + 1;
    }
  }
  hits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const h of hits)
    out =
      out.slice(0, h.start) +
      (mode === "partial" ? partial(h.kind, h.value) : `[${h.kind}]`) +
      out.slice(h.end);
  const total = hits.length;
  return {
    ok: true,
    found: total,
    counts,
    mode,
    redacted: out,
    answer: total
      ? `${total} personal item(s) masked: ${Object.entries(counts)
          .map(([k, n]) => `${n} ${k}`)
          .join(", ")}.`
      : "No personal data found by these patterns.",
    note: "Pattern based: names, addresses and free-text details are not detected. Card and Aadhaar numbers are only masked when their checksum is valid.",
  };
}

export default run;
