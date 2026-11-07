// FRIDAY · skill: dat-stats
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Descriptive statistics for a list of numbers: count, sum, mean, median, mode, spread, quartiles and outliers.

const r4 = (n) => Math.round(n * 10000) / 10000;

function numbersFrom(text) {
  const out = [];
  for (const piece of text.split(/[\s;]+/)) {
    if (!piece) continue;
    if (/^-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?$/.test(piece)) {
      out.push(Number(piece.replace(/,/g, "")));
      continue;
    }
    for (const part of piece.split(",")) {
      const m = /^[^\d-]*(-?\d+(?:\.\d+)?)[^\d]*$/.exec(part);
      if (m) out.push(Number(m[1]));
    }
  }
  return out;
}

function quantile(sorted, p) {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export async function run(input = {}) {
  let nums = Array.isArray(input.numbers)
    ? input.numbers.map(Number).filter(Number.isFinite)
    : null;
  if (!nums) {
    let text = String(input?.prompt ?? input?.text ?? "");
    const colon = /^([^:\n]{0,80}):([\s\S]+)$/.exec(text);
    if (
      colon &&
      /stat|mean|average|median|mode|sum|std|deviation|variance|numbers?|data/i.test(colon[1])
    )
      text = colon[2];
    nums = numbersFrom(text);
  }
  if (!nums.length)
    return { ok: false, error: "Give some numbers, e.g. stats of 12, 15, 9, 22, 18." };
  const n = nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0);
  const counts = new Map();
  for (const v of nums) counts.set(v, (counts.get(v) ?? 0) + 1);
  const top = Math.max(...counts.values());
  const modes =
    top > 1
      ? [...counts.entries()]
          .filter(([, c]) => c === top)
          .map(([v]) => v)
          .sort((a, b) => a - b)
      : [];
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const fence = 1.5 * (q3 - q1);
  const outliers = sorted.filter((v) => v < q1 - fence || v > q3 + fence);
  const result = {
    ok: true,
    count: n,
    sum: r4(sum),
    mean: r4(mean),
    median: r4(quantile(sorted, 0.5)),
    modes,
    min: sorted[0],
    max: sorted[n - 1],
    range: r4(sorted[n - 1] - sorted[0]),
    q1: r4(q1),
    q3: r4(q3),
    populationStdDev: r4(Math.sqrt(ss / n)),
    sampleStdDev: n > 1 ? r4(Math.sqrt(ss / (n - 1))) : null,
    outliers,
  };
  return {
    ...result,
    answer: `n=${n}, sum ${result.sum}, mean ${result.mean}, median ${result.median}, min ${result.min}, max ${result.max}${modes.length ? `, mode ${modes.join("/")}` : ""}, std dev ${result.sampleStdDev ?? result.populationStdDev}${outliers.length ? `, outlier(s) ${outliers.join(", ")}` : ""}.`,
  };
}

export default run;
