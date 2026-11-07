// FRIDAY · skill: fin-invest-tax
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// CAGR and ROI, break-even, inflation and India income tax. Money questions about returns, costs and tax.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "cagr-roi",
    gate: /cagr|\broi\b|return on|growth rate|annuali[sz]ed|absolute return|invested/,
    run: (() => {
      // Returns: CAGR between two values, absolute return and ROI, and the future value of a target growth rate.
      const SCALE = {
        lakh: 1e5,
        lac: 1e5,
        crore: 1e7,
        cr: 1e7,
        k: 1e3,
        thousand: 1e3,
        m: 1e6,
        million: 1e6,
      };
      const amounts = (t) =>
        [
          ...t.matchAll(/(\d+(?:,\d+)*(?:\.\d+)?)\s*(lakh|lac|crore|cr|thousand|million|k)?\b/g),
        ].map((m) => ({
          v: Number(m[1].replace(/,/g, "")) * (m[2] ? SCALE[m[2]] : 1),
          idx: m.index,
          len: m[0].length,
        }));
      const r2 = (n) => Math.round(n * 100) / 100;

      async function run(input = {}) {
        let t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b|\$/g, " ");
        let years = input.years != null ? Number(input.years) : NaN;
        const dm = /(\d+(?:\.\d+)?)\s*(years?|yrs?|yr|months?|mths?)\b/.exec(t);
        if (dm) {
          if (!Number.isFinite(years))
            years = /^m/.test(dm[2]) ? Number(dm[1]) / 12 : Number(dm[1]);
          t = t.replace(dm[0], " ");
        }
        let start = input.start != null ? Number(input.start) : NaN;
        let end = input.end != null ? Number(input.end) : NaN;
        if (!(start > 0) || !(end > 0)) {
          const a = amounts(t).filter((x) => x.v > 0);
          const from = /(?:from|invested?|bought|started with|put)\s+/.exec(t);
          if (a.length >= 2) {
            start = a[0].v;
            end = a[1].v;
          }
          void from;
        }
        if (!(start > 0) || !(end > 0))
          return {
            ok: false,
            error:
              "Give a start and an end value, e.g. CAGR from 1 lakh to 2.5 lakh in 5 years, or invested 50000 got 65000.",
          };
        const gain = end - start;
        const roi = (gain / start) * 100;
        const out = { ok: true, start, end, gain: r2(gain), absoluteReturnPercent: r2(roi) };
        if (years > 0) {
          out.years = r2(years);
          out.cagrPercent = r2((Math.pow(end / start, 1 / years) - 1) * 100);
          out.multiple = r2(end / start);
          out.answer = `${r2(start)} to ${r2(end)} in ${r2(years)} year(s): CAGR ${out.cagrPercent}% a year, total return ${out.absoluteReturnPercent}% (${out.multiple}x).`;
        } else {
          out.answer = `${r2(start)} to ${r2(end)}: gain ${r2(gain)}, ROI ${out.absoluteReturnPercent}%. Add the number of years to get the yearly rate (CAGR).`;
        }
        return out;
      }

      return run;
    })(),
  },
  {
    id: "break-even",
    gate: /break.?even/,
    run: (() => {
      // Break-even: units and revenue needed to cover fixed costs, and profit at a planned volume.
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b|,/g, " ");
        const get = (key, re) =>
          input[key] != null ? Number(input[key]) : Number((re.exec(t) ?? [])[1]);
        const fixed = get("fixed", /fixed(?:\s+costs?)?\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/);
        const price = get(
          "price",
          /(?:selling\s+)?price(?:\s+per\s+unit)?\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/,
        );
        const variable = get(
          "variable",
          /variable(?:\s+costs?)?(?:\s+per\s+unit)?\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/,
        );
        const planned = get(
          "units",
          /(?:sell|selling|planned|units?)\s*(?:of|is|=|:)?\s*(\d+)\s*(?:units?)?/,
        );
        if (
          ![fixed, price, variable].every((x) => Number.isFinite(x) && x >= 0) ||
          price <= variable
        ) {
          return {
            ok: false,
            error:
              "Give fixed costs, price per unit and variable cost per unit (price must be higher), e.g. break even fixed 50000 price 200 variable 120.",
          };
        }
        const margin = price - variable;
        const units = Math.ceil(fixed / margin);
        const out = {
          ok: true,
          contributionPerUnit: margin,
          contributionMarginPercent: Math.round((margin / price) * 1000) / 10,
          breakEvenUnits: units,
          breakEvenRevenue: units * price,
        };
        let line = `Each unit contributes ${margin} (${out.contributionMarginPercent}%). Break even at ${units} units, revenue ${units * price}.`;
        if (Number.isFinite(planned) && planned > 0) {
          out.profitAtPlanned = planned * margin - fixed;
          out.marginOfSafetyPercent = Math.round(((planned - units) / planned) * 1000) / 10;
          line += ` At ${planned} units the profit is ${out.profitAtPlanned} (margin of safety ${out.marginOfSafetyPercent}%).`;
        }
        out.answer = line;
        return out;
      }

      return run;
    })(),
  },
  {
    id: "inflation-adjust",
    gate: /inflation|purchasing power/,
    run: (() => {
      // Inflation: what an amount costs or is worth after some years at a given inflation rate.
      const SCALE = { lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7, k: 1e3, thousand: 1e3 };
      const r2 = (n) => Math.round(n * 100) / 100;
      const inr = (n) =>
        r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

      async function run(input = {}) {
        let t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b/g, " ");
        const rm = /(\d+(?:\.\d+)?)\s*(?:%|percent)/.exec(t);
        const rate = input.rate != null ? Number(input.rate) : rm ? Number(rm[1]) : NaN;
        if (rm) t = t.replace(rm[0], " ");
        const dm = /(\d+(?:\.\d+)?)\s*(years?|yrs?|yr)\b/.exec(t);
        const years = input.years != null ? Number(input.years) : dm ? Number(dm[1]) : NaN;
        if (dm) t = t.replace(dm[0], " ");
        const am = /(\d+(?:,\d+)*(?:\.\d+)?)\s*(lakh|lac|crore|cr|thousand|k)?\b/.exec(t);
        const amount =
          input.amount != null
            ? Number(input.amount)
            : am
              ? Number(am[1].replace(/,/g, "")) * (am[2] ? SCALE[am[2]] : 1)
              : NaN;
        if (![amount, rate, years].every((x) => Number.isFinite(x) && x > 0)) {
          return {
            ok: false,
            error:
              "Give an amount, an inflation rate and years, e.g. 1 lakh after 10 years at 6% inflation.",
          };
        }
        const future = amount * Math.pow(1 + rate / 100, years);
        const worth = amount / Math.pow(1 + rate / 100, years);
        return {
          ok: true,
          futureCostOfSameThing: r2(future),
          todaysWorthOfAmountThen: r2(worth),
          answer: `At ${rate}% inflation for ${years} year(s): something that costs ${inr(amount)} today will cost ${inr(future)}; and ${inr(amount)} then will buy only what ${inr(worth)} buys today.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "income-tax-india",
    gate: /income tax|tax on|tax for|tax slab|\bitr\b|new regime|old regime|tax payable|tax liability|take.?home/,
    run: (() => {
      // India income tax estimate for an individual below 60: new regime (default) and old regime, FY 2025-26 (AY 2026-27).
      // Rates read on 2026-11-07 from secondary sources (the Budget 2026 left them unchanged); confirm at incometax.gov.in.
      const SCALE = { lakh: 1e5, lac: 1e5, crore: 1e7, cr: 1e7, k: 1e3, thousand: 1e3 };
      const NEW = [
        [400000, 0],
        [800000, 0.05],
        [1200000, 0.1],
        [1600000, 0.15],
        [2000000, 0.2],
        [2400000, 0.25],
        [Infinity, 0.3],
      ];
      const OLD = [
        [250000, 0],
        [500000, 0.05],
        [1000000, 0.2],
        [Infinity, 0.3],
      ];
      const inr = (n) => Math.round(n).toLocaleString("en-IN");

      function slabTax(income, slabs) {
        let tax = 0;
        let prev = 0;
        for (const [limit, rate] of slabs) {
          if (income > prev) tax += (Math.min(income, limit) - prev) * rate;
          prev = limit;
        }
        return tax;
      }

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b|,/g, " ");
        const am = /(\d+(?:\.\d+)?)\s*(lakh|lac|crore|cr|thousand|k)?\b/.exec(
          t.replace(/\b(?:fy|ay)\s*\d{2,4}(?:-\d{2,4})?/g, " "),
        );
        const income =
          input.income != null
            ? Number(input.income)
            : am
              ? Number(am[1]) * (am[2] ? SCALE[am[2]] : 1)
              : NaN;
        if (!(income > 0))
          return {
            ok: false,
            error: "Give your yearly income, e.g. income tax on 15 lakh salary.",
          };
        const salaried = input.salaried ?? !/business|freelanc|self.?employed|professional/.test(t);
        const ded =
          Number(
            (/(?:deductions?|80c|investments?)\D{0,12}(\d+(?:\.\d+)?)\s*(lakh|lac|k)?/.exec(t) ??
              [])[1],
          ) *
            (SCALE[
              (/(?:deductions?|80c|investments?)\D{0,12}\d+(?:\.\d+)?\s*(lakh|lac|k)?/.exec(t) ??
                [])[1]
            ] ?? 1) ||
          Number(input.deductions) ||
          0;

        const newTaxable = Math.max(0, income - (salaried ? 75000 : 0));
        let newTax = slabTax(newTaxable, NEW);
        if (newTaxable <= 1200000) newTax = 0;
        else newTax = Math.min(newTax, newTaxable - 1200000); // marginal relief just above the rebate limit
        const newTotal = newTax * 1.04;

        const oldTaxable = Math.max(0, income - (salaried ? 50000 : 0) - ded);
        let oldTax = slabTax(oldTaxable, OLD);
        if (oldTaxable <= 500000) oldTax = 0;
        const oldTotal = oldTax * 1.04;

        const better = newTotal <= oldTotal ? "new" : "old";
        const showOld = /old|compare|which|better|deduction|80c/.test(t) || input.compare;
        return {
          ok: true,
          financialYear: "2025-26",
          income,
          newRegime: {
            taxableIncome: newTaxable,
            taxBeforeCess: Math.round(newTax),
            totalWithCess: Math.round(newTotal),
            monthly: Math.round(newTotal / 12),
          },
          oldRegime: {
            taxableIncome: oldTaxable,
            taxBeforeCess: Math.round(oldTax),
            totalWithCess: Math.round(oldTotal),
            deductionsUsed: ded,
          },
          lowerTaxRegime: better,
          answer:
            `New regime (FY 2025-26${salaried ? ", standard deduction 75,000" : ""}): taxable ${inr(newTaxable)}, tax with 4% cess ${inr(newTotal)} (about ${inr(newTotal / 12)} a month).` +
            (showOld
              ? ` Old regime with ${inr(ded)} of deductions: ${inr(oldTotal)}; the ${better} regime is lower.`
              : " Say 'compare old regime with 80C 1.5 lakh' to see the old regime.") +
            " Surcharge (income above 50 lakh), capital gains and special incomes are not included; confirm at incometax.gov.in.",
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
