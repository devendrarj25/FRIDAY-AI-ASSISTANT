// FRIDAY · skill: in-inr-words
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Writes an amount in Indian digit grouping (12,34,567.89) and in words (lakh, crore), as cheques and invoices need.

const ONES = [
  "",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below1000(n) {
  const parts = [];
  if (n >= 100) {
    parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
    n %= 100;
  }
  if (n >= 20) {
    parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ""));
  } else if (n > 0) parts.push(ONES[n]);
  return parts.join(" ");
}

/** Whole number to Indian words (crore, lakh, thousand). */
export function wordsOf(n) {
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 1e7);
  const lakh = Math.floor((n % 1e7) / 1e5);
  const thousand = Math.floor((n % 1e5) / 1e3);
  const rest = n % 1e3;
  const out = [];
  if (crore) out.push(`${wordsOf(crore)} Crore`);
  if (lakh) out.push(`${below1000(lakh)} Lakh`);
  if (thousand) out.push(`${below1000(thousand)} Thousand`);
  if (rest) out.push(below1000(rest));
  return out.join(" ");
}

export function group(rupees) {
  const s = String(rupees);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  return `${s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

/** "1.5 crore", "2 lakh 50 thousand", "12,34,567.89", "Rs. 500". */
function amountFrom(input) {
  if (typeof input?.amount === "number") return input.amount;
  const text = String(input?.amount ?? input?.text ?? input?.prompt ?? "")
    .toLowerCase()
    .replace(/,/g, "");
  const unit = {
    crore: 1e7,
    cr: 1e7,
    lakh: 1e5,
    lac: 1e5,
    lakhs: 1e5,
    thousand: 1e3,
    hazaar: 1e3,
    hazar: 1e3,
    k: 1e3,
  };
  let total = 0;
  let any = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(crore|cr|lakhs?|lac|thousand|hazaa?r|k)\b/g)) {
    total += Number(m[1]) * unit[m[2]];
    any = true;
  }
  if (any) return total;
  const plain = text.match(/(\d+(?:\.\d+)?)/);
  return plain ? Number(plain[1]) : NaN;
}

export async function run(input = {}) {
  // From a sentence, a number counts only when money is meant (rupees, words, lakh, crore...). The amount field always counts.
  const sentence = String(input?.text ?? input?.prompt ?? "");
  if (
    input?.amount === undefined &&
    !/(rupee|rupaye|rupay|\brs\b|\u20b9|\binr\b|amount|words|lakh|lac\b|crore|paise|cheque)/i.test(
      sentence,
    )
  ) {
    return {
      ok: false,
      error:
        "Say it as an amount: for example 1234567.89, 1.5 crore or rupees in words for 250000.",
    };
  }
  const value = amountFrom(input);
  if (!Number.isFinite(value) || value < 0)
    return {
      ok: false,
      error: "Give an amount such as 1234567.89, 1.5 crore or 2 lakh 50 thousand.",
    };
  if (value >= 1e12)
    return { ok: false, error: "Amounts of one lakh crore or more are not supported." };
  const paiseTotal = Math.round(value * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  const words = `Rupees ${wordsOf(rupees)}${paise ? ` and Paise ${wordsOf(paise)}` : ""} Only`;
  const grouped = `${group(rupees)}.${String(paise).padStart(2, "0")}`;
  return {
    ok: true,
    rupees,
    paise,
    indianGrouping: `₹${grouped}`,
    inWords: words,
    answer: `₹${grouped} = ${words}`,
    note: paiseTotal !== value * 100 ? "Rounded to the nearest paisa." : undefined,
  };
}

export default run;
