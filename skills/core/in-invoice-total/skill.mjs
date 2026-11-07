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
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
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
  if (Math.floor((n % 1e5) / 1e3)) out.push(`${below1000(Math.floor((n % 1e5) / 1e3))} Thousand`);
  if (n % 1e3) out.push(below1000(n % 1e3));
  return out.join(" ");
}
const money = (paise) =>
  (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

export async function run(input = {}) {
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
  const bad = items.find((x) => !(x.qty > 0) || !(x.rate >= 0) || !(x.gst >= 0 && x.gst <= 100));
  if (bad)
    return {
      ok: false,
      error: `Line "${bad.description}" has an invalid quantity, rate or GST percent.`,
    };
  const inter =
    Boolean(input?.interstate) || /\b(igst|inter-?state)\b/i.test(String(input?.prompt ?? ""));
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
          : { cgst: Math.floor(v.tax / 2) / 100, sgst: (v.tax - Math.floor(v.tax / 2)) / 100 }),
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

export default run;
