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
  (paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

export async function run(input = {}) {
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
    out.warnings.push("No rate was given, so 18% was used. Say the rate (for example 5% or 40%).");
  if (!COMMON.includes(rate))
    out.warnings.push(
      `${rate}% is not one of the common rates (${COMMON.join(", ")}%). Special rates exist for some goods; confirm on the GST notification.`,
    );
  out.rateGuide =
    "Common rates since 22 Sep 2025: 0, 5, 18 and 40 percent. The rate depends on the item's HSN or SAC code, not on its name.";
  return out;
}

export default run;
