// FRIDAY · skill: in-tax-invoice
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// GST, invoice totals and rupees in words. Everything about GST bills in one skill.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "in-gst-calc",
    gate: /gst|igst|cgst|sgst|\btax\b|\bvat\b/,
    run: (() => {
      // FRIDAY · skill: in-gst-calc
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Adds GST to a price, or takes it out of a GST-inclusive price, with the CGST + SGST or IGST split.
      // All money is handled in paise (whole numbers), so rounding never drifts.

      // Rates in force after 22 September 2025 (the 56th GST Council): 5% and 18%, with 40% for a short list of
      // sin and luxury goods, and 0 for exempt supplies. The right rate depends on the item (its HSN or SAC code):
      // this skill never guesses a rate from a product name.
      const COMMON = [0, 5, 18, 40];

      const rupees = (paise) => Math.round(paise) / 100;
      const fmt = (paise) =>
        (paise / 100).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

      function parse(input) {
        const text = String(input?.prompt ?? input?.text ?? "");
        let amount = Number(input?.amount);
        let rate = input?.rate !== undefined ? Number(input.rate) : undefined;
        if (rate === undefined) {
          const r =
            text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|pc|pratishat)/i) ??
            text.match(/\b(?:gst|rate)\s*(?:of|at|@|:)?\s*(\d+(?:\.\d+)?)/i);
          if (r) rate = Number(r[1]);
        }
        if (!Number.isFinite(amount)) {
          const stripped = text
            .replace(/(\d+(?:\.\d+)?)\s*(?:%|percent|pc|pratishat)/gi, " ")
            .replace(/\b(?:gst|rate)\s*(?:of|at|@|:)?\s*\d+(?:\.\d+)?/gi, " ")
            .replace(/,/g, "");
          const nums = [...stripped.matchAll(/(?:rs\.?|inr|₹)?\s*(\d+(?:\.\d+)?)/gi)].map((m) =>
            Number(m[1]),
          );
          amount = nums[0];
        }
        const lower = text.toLowerCase();
        const mode =
          String(input?.mode ?? "").toLowerCase() ||
          (/\b(inclusive|including|included|incl|with gst|gst (?:mein|me) (?:shamil|included)|gst sahit|andar)\b/.test(
            lower,
          )
            ? "inclusive"
            : "exclusive");
        const inter =
          typeof input?.interstate === "boolean"
            ? input.interstate
            : /\b(igst|inter-?state|other state|bahar ke state)\b/.test(lower);
        return { amount, rate, mode: mode.startsWith("incl") ? "inclusive" : "exclusive", inter };
      }

      async function run(input = {}) {
        const { amount, rate: given, mode, inter } = parse(input);
        if (!Number.isFinite(amount) || amount < 0)
          return {
            ok: false,
            error: "Give an amount, for example: GST 18% on 5000, or 11800 including 18% GST.",
          };
        const assumed = given === undefined || !Number.isFinite(given);
        const rate = assumed ? 18 : given;
        if (rate < 0 || rate > 100)
          return { ok: false, error: "The GST rate must be between 0 and 100." };
        const gross = Math.round(amount * 100);
        let taxable;
        let tax;
        let total;
        if (mode === "inclusive") {
          taxable = Math.round((gross * 100) / (100 + rate));
          tax = gross - taxable;
          total = gross;
        } else {
          taxable = gross;
          tax = Math.round((gross * rate) / 100);
          total = gross + tax;
        }
        const out = {
          ok: true,
          mode,
          rate,
          rateAssumed: assumed,
          supply: inter ? "inter-state (IGST)" : "intra-state (CGST + SGST)",
          taxableValue: rupees(taxable),
          gstAmount: rupees(tax),
          totalAmount: rupees(total),
        };
        if (inter) out.igst = rupees(tax);
        else {
          const cgst = Math.floor(tax / 2);
          out.cgst = rupees(cgst);
          out.sgst = rupees(tax - cgst);
          out.splitNote =
            "CGST and SGST are each half of the GST; an odd paisa goes to SGST so the parts add up.";
        }
        out.answer = `${mode === "inclusive" ? "Inside" : "On"} ₹${fmt(gross)} at ${rate}% GST: taxable ₹${fmt(taxable)}, GST ₹${fmt(tax)}${inter ? " (IGST)" : ` (CGST ₹${fmt(Math.floor(tax / 2))} + SGST ₹${fmt(tax - Math.floor(tax / 2))})`}, total ₹${fmt(total)}.`;
        out.warnings = [];
        if (assumed)
          out.warnings.push(
            "No rate was given, so 18% was used. Say the rate (for example 5% or 40%).",
          );
        if (!COMMON.includes(rate))
          out.warnings.push(
            `${rate}% is not one of the common rates (${COMMON.join(", ")}%). Special rates exist for some goods; confirm on the GST notification.`,
          );
        out.rateGuide =
          "Common rates since 22 Sep 2025: 0, 5, 18 and 40 percent. The rate depends on the item's HSN or SAC code, not on its name.";
        return out;
      }

      return run;
    })(),
  },
  {
    id: "in-invoice-total",
    gate: null,
    run: (() => {
      // FRIDAY · skill: in-invoice-total
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Adds up an invoice: line totals, discount, GST per rate, round-off and the grand total in words.
      // Money is kept in paise (whole numbers) so the parts always add up to the total.

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
      const TENS = [
        "",
        "",
        "Twenty",
        "Thirty",
        "Forty",
        "Fifty",
        "Sixty",
        "Seventy",
        "Eighty",
        "Ninety",
      ];
      function below1000(n) {
        const parts = [];
        if (n >= 100) {
          parts.push(`${ONES[Math.floor(n / 100)]} Hundred`);
          n %= 100;
        }
        if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ""));
        else if (n > 0) parts.push(ONES[n]);
        return parts.join(" ");
      }
      function words(n) {
        if (n === 0) return "Zero";
        const out = [];
        if (Math.floor(n / 1e7)) out.push(`${words(Math.floor(n / 1e7))} Crore`);
        if (Math.floor((n % 1e7) / 1e5)) out.push(`${below1000(Math.floor((n % 1e7) / 1e5))} Lakh`);
        if (Math.floor((n % 1e5) / 1e3))
          out.push(`${below1000(Math.floor((n % 1e5) / 1e3))} Thousand`);
        if (n % 1e3) out.push(below1000(n % 1e3));
        return out.join(" ");
      }
      const money = (paise) =>
        (paise / 100).toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

      /** "Laptop 2 x 45000 18%", "Mouse 3 @ 500 gst 18", "Cable 10 x 120" (rate defaults to the invoice rate). */
      function parseLines(text, defaultRate) {
        const items = [];
        for (const raw of text.split(/\r?\n|;/)) {
          const line = raw.trim().replace(/,/g, "");
          if (!line) continue;
          const m = line.match(
            /^(.*?)[\s:-]*(\d+(?:\.\d+)?)\s*(?:x|×|\*|@)\s*(?:rs\.?|₹|inr)?\s*(\d+(?:\.\d+)?)(.*)$/i,
          );
          if (!m) continue;
          // The discount is read first and cut out, so its percent is never taken for the GST rate.
          let tail = m[4] ?? "";
          const disc =
            tail.match(/(\d+(?:\.\d+)?)\s*%\s*(?:disc(?:ount)?|off)\b/i) ??
            tail.match(/(?:disc(?:ount)?|off)\s*(\d+(?:\.\d+)?)\s*%?/i);
          if (disc) tail = tail.replace(disc[0], " ");
          const rate = tail.match(/gst\s*(\d+(?:\.\d+)?)/i) ?? tail.match(/(\d+(?:\.\d+)?)\s*%/);
          items.push({
            description: m[1].trim() || "Item",
            qty: Number(m[2]),
            rate: Number(m[3]),
            gst: rate ? Number(rate[1]) : defaultRate,
            discountPercent: disc ? Number(disc[1]) : 0,
          });
        }
        return items;
      }

      async function run(input = {}) {
        const defaultRate =
          Number.isFinite(Number(input?.gst)) && input?.gst !== undefined ? Number(input.gst) : 18;
        const items = Array.isArray(input?.items)
          ? input.items.map((x) => ({
              description: String(x.description ?? x.name ?? "Item"),
              qty: Number(x.qty ?? x.quantity ?? 1),
              rate: Number(x.rate ?? x.price),
              gst: Number(x.gst ?? defaultRate),
              discountPercent: Number(x.discountPercent ?? x.discount ?? 0),
            }))
          : parseLines(String(input?.lines ?? input?.text ?? input?.prompt ?? ""), defaultRate);
        if (!items.length)
          return {
            ok: false,
            error:
              "Give the lines, one per row, for example: Laptop 2 x 45000 18%  (description, quantity x rate, GST percent).",
          };
        const bad = items.find(
          (x) => !(x.qty > 0) || !(x.rate >= 0) || !(x.gst >= 0 && x.gst <= 100),
        );
        if (bad)
          return {
            ok: false,
            error: `Line "${bad.description}" has an invalid quantity, rate or GST percent.`,
          };
        const inter =
          Boolean(input?.interstate) ||
          /\b(igst|inter-?state)\b/i.test(String(input?.prompt ?? ""));
        const lines = items.map((x) => {
          const gross = Math.round(x.qty * x.rate * 100);
          const discount = Math.round((gross * x.discountPercent) / 100);
          const taxable = gross - discount;
          const tax = Math.round((taxable * x.gst) / 100);
          return {
            description: x.description,
            qty: x.qty,
            rate: x.rate,
            gstPercent: x.gst,
            discountPercent: x.discountPercent,
            taxable,
            tax,
            total: taxable + tax,
          };
        });
        const byRate = new Map();
        for (const l of lines) {
          const row = byRate.get(l.gstPercent) ?? { taxable: 0, tax: 0 };
          row.taxable += l.taxable;
          row.tax += l.tax;
          byRate.set(l.gstPercent, row);
        }
        const taxable = lines.reduce((s, l) => s + l.taxable, 0);
        const tax = lines.reduce((s, l) => s + l.tax, 0);
        const exact = taxable + tax;
        const rounded = Math.round(exact / 100) * 100;
        const roundOff = rounded - exact;
        const grand = Math.round(rounded / 100);
        return {
          ok: true,
          supply: inter ? "inter-state (IGST)" : "intra-state (CGST + SGST)",
          lines: lines.map((l) => ({
            ...l,
            taxable: l.taxable / 100,
            tax: l.tax / 100,
            total: l.total / 100,
          })),
          gstByRate: [...byRate.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([rate, v]) => ({
              ratePercent: rate,
              taxable: v.taxable / 100,
              ...(inter
                ? { igst: v.tax / 100 }
                : {
                    cgst: Math.floor(v.tax / 2) / 100,
                    sgst: (v.tax - Math.floor(v.tax / 2)) / 100,
                  }),
            })),
          subtotalTaxable: taxable / 100,
          totalGst: tax / 100,
          roundOff: roundOff / 100,
          grandTotal: grand,
          grandTotalInWords: `Rupees ${words(grand)} Only`,
          answer: `${lines.length} line(s): taxable ₹${money(taxable)} + GST ₹${money(tax)}${roundOff ? ` ${roundOff > 0 ? "+" : "-"} round-off ₹${money(Math.abs(roundOff))}` : ""} = ₹${money(rounded)}.`,
          note: "GST per line uses the rate you gave for that line. Check the rate against the item's HSN or SAC code before issuing the invoice.",
        };
      }

      return run;
    })(),
  },
  {
    id: "in-inr-words",
    gate: /words|likh|in letters/,
    run: (() => {
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
      const TENS = [
        "",
        "",
        "Twenty",
        "Thirty",
        "Forty",
        "Fifty",
        "Sixty",
        "Seventy",
        "Eighty",
        "Ninety",
      ];

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
      function wordsOf(n) {
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

      function group(rupees) {
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
        for (const m of text.matchAll(
          /(\d+(?:\.\d+)?)\s*(crore|cr|lakhs?|lac|thousand|hazaa?r|k)\b/g,
        )) {
          total += Number(m[1]) * unit[m[2]];
          any = true;
        }
        if (any) return total;
        const plain = text.match(/(\d+(?:\.\d+)?)/);
        return plain ? Number(plain[1]) : NaN;
      }

      async function run(input = {}) {
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
