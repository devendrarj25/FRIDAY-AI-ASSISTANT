// FRIDAY · skill: in-emi-sip
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Loan EMI with a repayment schedule, and SIP / lumpsum growth estimates.
// These are estimates from the numbers you give: a loan follows the lender's own schedule, and an investment
// return is never guaranteed.

const num = (v) =>
  v === undefined || v === null || v === "" ? NaN : Number(String(v).replace(/,/g, ""));
const fmt = (n) =>
  n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(n * 100) / 100;

/** Pull "5 lakh", "50,000", "8.5%", "20 years", "240 months" out of a sentence. */
function readPrompt(text) {
  const t = text.toLowerCase().replace(/,/g, "");
  const out = {};
  const unit = {
    crore: 1e7,
    cr: 1e7,
    lakhs: 1e5,
    lakh: 1e5,
    lac: 1e5,
    k: 1e3,
    thousand: 1e3,
    hazaar: 1e3,
  };
  const amounts = [
    ...t.matchAll(
      /(\d+(?:\.\d+)?)\s*(crore|cr|lakhs?|lac|k|thousand|hazaar)?\b(?!\s*(?:%|percent|years?\b|yrs?\b|months?\b|mths?\b|saal\b|sal\b|mahin[ae]\b))/g,
    ),
  ]
    .map((m) => Number(m[1]) * (m[2] ? unit[m[2]] : 1))
    .filter((n) => n > 0);
  const rate = t.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|pc)/);
  const years = t.match(/(\d+(?:\.\d+)?)\s*(?:years?|yrs?|saal|sal)\b/);
  const months = t.match(/(\d+(?:\.\d+)?)\s*(?:months?|mths?|mahine|mahina)\b/);
  if (amounts.length) out.amount = amounts[0];
  if (rate) out.rate = Number(rate[1]);
  if (years) out.years = Number(years[1]);
  if (months) out.months = Number(months[1]);
  out.kind = /\bsip\b/.test(t)
    ? "sip"
    : /lump ?sum|one[- ]time|ek baar/.test(t)
      ? "lumpsum"
      : /\b(emi|loan|karz|home loan|car loan)\b/.test(t)
        ? "emi"
        : "";
  return out;
}

function emi(principal, annualRate, months, showRows) {
  const r = annualRate / 12 / 100;
  const payment =
    r === 0 ? principal / months : (principal * r * (1 + r) ** months) / ((1 + r) ** months - 1);
  let balance = principal;
  const rows = [];
  let interestTotal = 0;
  for (let k = 1; k <= months; k += 1) {
    const interest = balance * r;
    const principalPart = Math.min(balance, payment - interest);
    balance = Math.max(0, balance - principalPart);
    interestTotal += interest;
    if (k <= showRows)
      rows.push({
        month: k,
        emi: round2(payment),
        interest: round2(interest),
        principal: round2(principalPart),
        balance: round2(balance),
      });
  }
  return { payment, interestTotal, rows };
}

export async function run(input = {}) {
  const read = readPrompt(String(input?.prompt ?? input?.text ?? ""));
  const kind = String(input?.kind ?? input?.mode ?? read.kind ?? "").toLowerCase();
  const amount = num(input?.principal ?? input?.monthly ?? input?.amount ?? read.amount);
  const rate = num(input?.rate ?? input?.annualRate ?? read.rate);
  const years = num(input?.years ?? read.years);
  const monthsGiven = num(input?.months ?? read.months);
  const months = Number.isFinite(monthsGiven)
    ? Math.round(monthsGiven)
    : Number.isFinite(years)
      ? Math.round(years * 12)
      : NaN;
  if (!["emi", "loan", "sip", "lumpsum"].includes(kind))
    return {
      ok: false,
      error:
        "Say what to work out: an EMI (loan amount, rate, tenure), a SIP (monthly amount, expected return, years) or a lumpsum.",
    };
  if (!(amount > 0) || !Number.isFinite(rate) || rate < 0 || !(months > 0)) {
    return {
      ok: false,
      error:
        "Need an amount, a yearly rate in percent and a period (years or months), for example: EMI on 25 lakh at 8.5% for 20 years.",
    };
  }
  if (rate > 100 || months > 1200)
    return {
      ok: false,
      error: "Rate must be at most 100 percent and the period at most 100 years.",
    };
  if (kind === "emi" || kind === "loan") {
    const { payment, interestTotal, rows } = emi(
      amount,
      rate,
      months,
      Math.max(1, Math.min(24, Number(input?.rows) || 12)),
    );
    const total = payment * months;
    return {
      ok: true,
      kind: "EMI",
      principal: amount,
      annualRatePercent: rate,
      months,
      monthlyEmi: round2(payment),
      totalInterest: round2(interestTotal),
      totalPayable: round2(total),
      interestShareOfTotalPercent: round2((interestTotal / total) * 100),
      firstMonths: rows,
      answer: `EMI ₹${fmt(payment)} a month for ${months} months; total interest ₹${fmt(interestTotal)}, total paid ₹${fmt(total)}.`,
      note: "Reducing-balance monthly EMI. A lender's schedule can differ by a few rupees (rounding, fees, the first-month days).",
    };
  }
  const r = rate / 12 / 100;
  if (kind === "lumpsum") {
    const maturity = amount * (1 + rate / 100) ** (months / 12);
    return {
      ok: true,
      kind: "Lumpsum",
      invested: amount,
      expectedAnnualReturnPercent: rate,
      years: round2(months / 12),
      estimatedValue: round2(maturity),
      estimatedGain: round2(maturity - amount),
      answer: `₹${fmt(amount)} at ${rate}% a year for ${round2(months / 12)} years grows to about ₹${fmt(maturity)}.`,
      note: "An estimate at a fixed yearly return. Real returns vary and are not guaranteed; tax and costs are not included.",
    };
  }
  const start = String(input?.timing ?? "start").toLowerCase() !== "end";
  const maturity =
    r === 0 ? amount * months : amount * (((1 + r) ** months - 1) / r) * (start ? 1 + r : 1);
  const invested = amount * months;
  return {
    ok: true,
    kind: "SIP",
    monthlyAmount: amount,
    expectedAnnualReturnPercent: rate,
    months,
    totalInvested: round2(invested),
    estimatedValue: round2(maturity),
    estimatedGain: round2(maturity - invested),
    answer: `₹${fmt(amount)} a month for ${months} months at ${rate}% a year: invested ₹${fmt(invested)}, estimated value ₹${fmt(maturity)}.`,
    assumption: `Monthly compounding at ${rate}/12 percent, each instalment at the ${start ? "start" : "end"} of its month.`,
    note: "An estimate, not a promise. Market-linked returns change every month; tax, exit load and expense ratio are not included.",
  };
}

export default run;
