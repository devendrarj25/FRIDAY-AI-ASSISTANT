// FRIDAY · skill: in-split-bill
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Split a bill between people, with optional tax (GST) and tip, and say who pays the extra paisa.

const r2 = (n) => Math.round(n * 100) / 100;
const inr = (n) =>
  r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const NUM = "(\\d+(?:\\.\\d+)?)";

export async function run(input = {}) {
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

export default run;
