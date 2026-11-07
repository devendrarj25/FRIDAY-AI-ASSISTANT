// FRIDAY · skill: in-percent-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Percentage questions: X% of Y, what percent A is of B, increase or decrease, discounts, markup and margin.

const num = (s) => Number(String(s).replace(/,/g, ""));
const N = "(\\d+(?:,\\d{3})*(?:\\.\\d+)?|\\.\\d+)";
const r2 = (n) => Math.round(n * 100) / 100;
const money = (n) =>
  r2(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "")
    .toLowerCase()
    .replace(/₹|rs\.?|inr/g, " ");
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
      new RegExp(`(?:from|change|increase|decrease)\\s+(?:from\\s+)?${N}\\s+(?:to|->)\\s+${N}`),
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

export default run;
