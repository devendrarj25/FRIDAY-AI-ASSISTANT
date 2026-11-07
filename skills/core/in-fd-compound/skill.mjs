// FRIDAY · skill: in-fd-compound
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Fixed deposit and compound interest: maturity amount, interest earned and the effective yearly rate.

const r2 = (n) => Math.round(n * 100) / 100;
const inr = (n) =>
  r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SCALE = { lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7, k: 1e3, thousand: 1e3 };

function firstAmount(s) {
  const m = /(\d+(?:,\d+)*(?:\.\d+)?)\s*(lakh|lac|crore|cr|k|thousand)?\b/.exec(s);
  if (!m) return null;
  return Number(m[1].replace(/,/g, "")) * (m[2] ? SCALE[m[2]] : 1);
}

export async function run(input = {}) {
  let t = String(input?.prompt ?? input?.text ?? "")
    .toLowerCase()
    .replace(/₹|\brs\b\.?|\binr\b/g, " ");
  let rate = input.rate != null ? Number(input.rate) : null;
  let years = input.years != null ? Number(input.years) : null;

  const rm = /(\d+(?:\.\d+)?)\s*(?:%|percent|pc)/.exec(t);
  if (rm) {
    if (rate == null) rate = Number(rm[1]);
    t = t.replace(rm[0], " ");
  }
  const dm = /(\d+(?:\.\d+)?)\s*(years?|yrs?|yr|saal|months?|mths?|mahine|mahina)\b/.exec(t);
  if (dm) {
    if (years == null) years = /^m/.test(dm[2]) ? Number(dm[1]) / 12 : Number(dm[1]);
    t = t.replace(dm[0], " ");
  }
  const principal = input.principal != null ? Number(input.principal) : firstAmount(t);
  if (![principal, rate, years].every((n) => Number.isFinite(n) && n > 0)) {
    return {
      ok: false,
      error: "Need an amount, a yearly rate in % and a time, e.g. 1 lakh at 7% for 2 years.",
    };
  }

  let n = 4; // Indian bank FDs compound quarterly unless they say otherwise
  const c = String(input.compounding ?? t);
  if (/simple/.test(c)) n = 0;
  else if (/monthly|every month/.test(c)) n = 12;
  else if (/quarter/.test(c)) n = 4;
  else if (/half|semi/.test(c)) n = 2;
  else if (/yearly|annual|every year/.test(c)) n = 1;

  const r = rate / 100;
  const maturity =
    n === 0 ? principal * (1 + r * years) : principal * Math.pow(1 + r / n, n * years);
  const interest = maturity - principal;
  const effective = n === 0 ? r : Math.pow(1 + r / n, n) - 1;
  const label =
    n === 0
      ? "simple interest"
      : `compounded ${["", "yearly", "half-yearly", "", "quarterly"][n] || "monthly"}`;
  return {
    ok: true,
    principal: r2(principal),
    ratePercent: rate,
    years: r2(years),
    compounding: label,
    maturityAmount: r2(maturity),
    interestEarned: r2(interest),
    effectiveYearlyRatePercent: r2(effective * 100),
    answer: `₹${inr(principal)} at ${rate}% for ${r2(years)} year(s), ${label}: maturity ₹${inr(maturity)} (interest ₹${inr(interest)}, effective ${r2(effective * 100)}% a year).`,
  };
}

export default run;
