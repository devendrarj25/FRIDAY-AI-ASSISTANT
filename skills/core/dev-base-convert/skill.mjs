// FRIDAY · skill: dev-base-convert
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Convert whole numbers between decimal, hexadecimal, binary and octal (any size), with 0x, 0b and 0o prefixes.

const BASES = {
  binary: 2,
  bin: 2,
  octal: 8,
  oct: 8,
  decimal: 10,
  dec: 10,
  hexadecimal: 16,
  hex: 16,
};
const WORDS = "binary|bin|octal|oct|decimal|dec|hexadecimal|hex";
const DIGITS = "0123456789abcdef";

function parse(digits, base) {
  let n = 0n;
  const b = BigInt(base);
  for (const ch of digits.toLowerCase()) {
    const d = DIGITS.indexOf(ch);
    if (d < 0 || d >= base) return null;
    n = n * b + BigInt(d);
  }
  return n;
}

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? input?.value ?? "").toLowerCase();
  let digits = null;
  let base = 10;
  let m;
  if (input.value != null && input.base != null) {
    digits = String(input.value).replace(/^0[xbo]/i, "");
    base = Number(input.base);
  } else if ((m = /\b0x([0-9a-f]+)\b/.exec(text))) {
    [digits, base] = [m[1], 16];
  } else if ((m = /\b0b([01]+)\b/.exec(text))) {
    [digits, base] = [m[1], 2];
  } else if ((m = /\b0o([0-7]+)\b/.exec(text))) {
    [digits, base] = [m[1], 8];
  } else if (
    (m = new RegExp(`\\b([0-9a-f]+)\\s*(${WORDS})\\b`).exec(text)) &&
    parse(m[1], BASES[m[2]]) !== null
  ) {
    [digits, base] = [m[1], BASES[m[2]]];
  } else if (
    (m = new RegExp(`\\bfrom\\s+(${WORDS})\\s+([0-9a-f]+)\\b`).exec(text)) &&
    parse(m[2], BASES[m[1]]) !== null
  ) {
    [digits, base] = [m[2], BASES[m[1]]];
  } else if ((m = /\b(\d+)\b/.exec(text))) {
    digits = m[1];
  }
  const n = digits == null ? null : parse(digits, base);
  if (n === null || !Number.isInteger(base) || base < 2 || base > 16) {
    return {
      ok: false,
      error: "Give a whole number, e.g. 255 to binary, 0xFF, or 1010 binary to decimal.",
    };
  }
  const dec = n.toString(10);
  const hex = n.toString(16);
  const bin = n.toString(2);
  const oct = n.toString(8);
  const code = n <= 126n && n >= 32n ? String.fromCharCode(Number(n)) : null;
  const want = new RegExp(`\\b(?:to|in|into)\\s+(${WORDS})\\b`).exec(text);
  const target = want ? BASES[want[1]] : null;
  const pick = { 2: bin, 8: oct, 10: dec, 16: hex }[target];
  return {
    ok: true,
    decimal: dec,
    hex,
    binary: bin,
    octal: oct,
    bits: bin === "0" ? 1 : bin.length,
    character: code,
    answer: pick
      ? `${digits} (base ${base}) = ${pick} (base ${target}).`
      : `${digits} (base ${base}) = ${dec} decimal = 0x${hex} = 0b${bin} = 0o${oct}.`,
  };
}

export default run;
