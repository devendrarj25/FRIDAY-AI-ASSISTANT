// FRIDAY · skill: in-finance-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Loan EMI, SIP, fixed deposit, percent and bill split. Money maths in one skill: loans, investments, deposits, percentages and shared bills.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "in-emi-sip",
    gate: null,
    run: (() => {
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
          r === 0
            ? principal / months
            : (principal * r * (1 + r) ** months) / ((1 + r) ** months - 1);
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

      async function run(input = {}) {
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

      return run;
    })(),
  },
  {
    id: "in-fd-compound",
    gate: null,
    run: (() => {
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

      async function run(input = {}) {
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

      return run;
    })(),
  },
  {
    id: "in-split-bill",
    gate: null,
    run: (() => {
      // FRIDAY · skill: in-split-bill
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Split a bill between people, with optional tax (GST) and tip, and say who pays the extra paisa.

      const r2 = (n) => Math.round(n * 100) / 100;
      const inr = (n) =>
        r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const NUM = "(\\d+(?:\\.\\d+)?)";

      async function run(input = {}) {
        let t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b/g, " ");
        let tip = input.tip != null ? Number(input.tip) : 0;
        let tax = input.tax != null ? Number(input.tax) : 0;
        let people = input.people != null ? Number(input.people) : null;

        let m = new RegExp(`${NUM}\\s*%\\s*tip|tip\\s*(?:of\\s*)?${NUM}\\s*%`).exec(t);
        if (m) {
          if (input.tip == null) tip = Number(m[1] ?? m[2]);
          t = t.replace(m[0], " ");
        }
        m = new RegExp(
          `(?:gst|tax|vat|service charge)\\s*(?:of\\s*)?${NUM}\\s*%|${NUM}\\s*%\\s*(?:gst|tax|vat|service charge)`,
        ).exec(t);
        if (m) {
          if (input.tax == null) tax = Number(m[1] ?? m[2]);
          t = t.replace(m[0], " ");
        }
        m =
          /(\d+)\s*(?:people|persons?|friends|log|members|ways|heads|pax)\b/.exec(t) ||
          /(?:among|between|by)\s+(\d+)\b/.exec(t);
        if (m) {
          if (people == null) people = Number(m[1]);
          t = t.replace(m[0], " ");
        }
        let total = input.total != null ? Number(input.total) : null;
        if (total == null) {
          const a = /(\d+(?:,\d+)*(?:\.\d+)?)/.exec(t);
          if (a) total = Number(a[1].replace(/,/g, ""));
        }
        if (!Number.isFinite(total) || total <= 0 || !Number.isInteger(people) || people < 1) {
          return {
            ok: false,
            error:
              "Need a bill amount and the number of people, e.g. split 2400 among 4 people with 10% tip.",
          };
        }
        const taxAmount = (total * tax) / 100;
        const tipAmount = (total * tip) / 100;
        const grand = total + taxAmount + tipAmount;
        const cents = Math.round(grand * 100);
        const base = Math.floor(cents / people);
        const extra = cents - base * people; // this many people pay one paisa more
        const perPerson = base / 100;
        return {
          ok: true,
          bill: r2(total),
          taxAmount: r2(taxAmount),
          tipAmount: r2(tipAmount),
          grandTotal: r2(grand),
          people,
          perPerson,
          extraPaisaPayers: extra,
          answer: `Total ₹${inr(grand)} for ${people}: ₹${inr(perPerson)} each${extra ? `, and ${extra} of you pay one paisa more so the bill adds up` : ""}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "in-percent-calc",
    gate: null,
    run: (() => {
      // FRIDAY · skill: in-percent-calc
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Percentage questions: X% of Y, what percent A is of B, increase or decrease, discounts, markup and margin.

      const num = (s) => Number(String(s).replace(/,/g, ""));
      const N = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?|\\.\\d+)";
      const r2 = (n) => Math.round(n * 100) / 100;
      const money = (n) =>
        r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b/g, " ");
        const mode = String(input?.mode ?? "");
        let m;
        if (
          mode === "of" ||
          (m = text.match(new RegExp(`${N}\\s*(?:%|percent)\\s*(?:of|ka|ki|ke)\\s*${N}`)))
        ) {
          const p = m ? num(m[1]) : num(input.percent);
          const base = m ? num(m[2]) : num(input.base);
          return {
            ok: true,
            mode: "percent of",
            answer: `${p}% of ${base} = ${r2((p / 100) * base)}.`,
            result: r2((p / 100) * base),
          };
        }
        if (
          (m = text.match(
            new RegExp(`${N}\\s+(?:is|as)\\s+what\\s+(?:%|percent)(?:age)?\\s+of\\s+${N}`),
          )) ||
          (m = text.match(
            new RegExp(`what\\s+(?:%|percent)(?:age)?\\s+(?:is|of)\\s+${N}\\s+(?:of|in)\\s+${N}`),
          )) ||
          (m = text.match(new RegExp(`${N}\\s+(?:kitne|kya)\\s+(?:%|percent)\\s+(?:hai\\s+)?${N}`)))
        ) {
          const [a, b] = [num(m[1]), num(m[2])];
          if (b === 0) return { ok: false, error: "The whole cannot be zero." };
          return {
            ok: true,
            mode: "what percent",
            answer: `${a} is ${r2((a / b) * 100)}% of ${b}.`,
            result: r2((a / b) * 100),
          };
        }
        if (
          (m = text.match(
            new RegExp(
              `(?:from|change|increase|decrease)\\s+(?:from\\s+)?${N}\\s+(?:to|->)\\s+${N}`,
            ),
          ))
        ) {
          const [from, to] = [num(m[1]), num(m[2])];
          if (from === 0) return { ok: false, error: "The starting value cannot be zero." };
          const change = ((to - from) / Math.abs(from)) * 100;
          return {
            ok: true,
            mode: "change",
            answer: `From ${from} to ${to} is ${change >= 0 ? "an increase" : "a decrease"} of ${r2(Math.abs(change))}%.`,
            result: r2(change),
            difference: r2(to - from),
          };
        }
        if (
          (m = text.match(
            new RegExp(`(?:add|plus|increase)\\s+${N}\\s*(?:%|percent)\\s+(?:to|on)\\s+${N}`),
          )) ||
          (m = text.match(
            new RegExp(`${N}\\s*(?:%|percent)\\s+(?:extra|more|markup)\\s+(?:on|to)\\s+${N}`),
          ))
        ) {
          const [p, base] = [num(m[1]), num(m[2])];
          return {
            ok: true,
            mode: "add percent",
            answer: `${base} plus ${p}% = ${r2(base * (1 + p / 100))} (the ${p}% is ${r2((base * p) / 100)}).`,
            result: r2(base * (1 + p / 100)),
            amount: r2((base * p) / 100),
          };
        }
        if (
          (m = text.match(
            new RegExp(
              `(?:subtract|minus|less|discount(?:ed)?(?: by)?|off)\\s+${N}\\s*(?:%|percent)?\\s*(?:from|on|of)\\s+${N}`,
            ),
          )) ||
          (m = text.match(
            new RegExp(
              `${N}\\s*(?:%|percent)\\s*(?:discount|off|chhoot|chhut)\\s+(?:on|from|par|pe)?\\s*${N}`,
            ),
          ))
        ) {
          const [p, base] = [num(m[1]), num(m[2])];
          return {
            ok: true,
            mode: "discount",
            answer: `${p}% off ${money(base)}: you save ${money((base * p) / 100)} and pay ${money(base * (1 - p / 100))}.`,
            saving: r2((base * p) / 100),
            result: r2(base * (1 - p / 100)),
          };
        }
        if (
          (m = text.match(
            new RegExp(
              `(?:cost|cp|bought)\\D{0,12}${N}\\D{1,25}(?:price|sp|sell(?:ing)?|sold)\\D{0,12}${N}`,
            ),
          ))
        ) {
          const [cost, price] = [num(m[1]), num(m[2])];
          if (cost === 0 || price === 0)
            return { ok: false, error: "Cost and price must be above zero." };
          const profit = price - cost;
          return {
            ok: true,
            mode: "markup and margin",
            answer: `Cost ${money(cost)}, price ${money(price)}: profit ${money(profit)}, markup ${r2((profit / cost) * 100)}% of cost, margin ${r2((profit / price) * 100)}% of price.`,
            profit: r2(profit),
            markupPercent: r2((profit / cost) * 100),
            marginPercent: r2((profit / price) * 100),
            note: "Markup is profit over cost; margin is profit over selling price. They are not the same number.",
          };
        }
        return {
          ok: false,
          error:
            "Try: 15% of 2400, 30 is what percent of 120, change from 80 to 100, add 18% to 5000, 20% off 1500, or cost 80 price 100.",
        };
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
