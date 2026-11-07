// FRIDAY · skill: ops-date-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Days between dates, a date N days or months away, an age, and a countdown to a date.

const DAY = 86400000;
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const iso = (d) => d.toISOString().slice(0, 10);

function parseDate(text) {
  const s = String(text ?? "").trim();
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = s.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return mk(+m[3], +m[2], +m[1]); // day-month-year
  return null;
}
function mk(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    ? date
    : null;
}
/** Add months, clamping to the end of a shorter month (31 Jan + 1 month = 28 Feb). */
function addMonths(date, n) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(date.getUTCDate(), last)));
}
function ymd(a, b) {
  let years = b.getUTCFullYear() - a.getUTCFullYear();
  let months = b.getUTCMonth() - a.getUTCMonth();
  let days = b.getUTCDate() - a.getUTCDate();
  if (days < 0) {
    months -= 1;
    days += new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 0)).getUTCDate();
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return { years, months, days };
}
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "");
  const dates = [...text.matchAll(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/g)]
    .map((m) => parseDate(m[0]))
    .filter(Boolean);
  const today = input?.today
    ? parseDate(input.today)
    : (() => {
        const n = new Date();
        return mk(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate());
      })();
  const start = parseDate(input?.start ?? input?.date ?? input?.birthdate) ?? dates[0] ?? null;
  const end = parseDate(input?.end) ?? dates[1] ?? null;
  const lower = text.toLowerCase();
  const addMatch =
    lower.match(
      /\b(?:add|plus|after|subtract|minus|before)\s+(-?\d+)\s*(day|week|month|year)s?\b/,
    ) ?? lower.match(/\b(-?\d+)\s*(day|week|month|year)s?\s+(?:after|before|from|later)\b/);
  const addN =
    input?.add !== undefined
      ? Number(input.add)
      : addMatch
        ? Number(addMatch[1]) * (/subtract|minus|before/.test(addMatch[0]) ? -1 : 1)
        : undefined;
  const unit = String(input?.unit ?? addMatch?.[2] ?? "day").replace(/s$/, "");
  const wantsAge = /\b(age|born|birth|janam)\b/.test(lower) || Boolean(input?.birthdate);
  const wantsUntil = /\b(until|till|countdown|days left|kitne din)\b/.test(lower);

  if (!start)
    return {
      ok: false,
      error:
        "Give a date such as 2026-12-25 or 25-12-2026 (day-month-year), for example: days between 01-01-2026 and 31-03-2026.",
    };
  if (wantsAge) {
    const a = ymd(start, today);
    if (today < start) return { ok: false, error: "That birth date is in the future." };
    return {
      ok: true,
      answer: `Age ${plural(a.years, "year")}, ${plural(a.months, "month")}, ${plural(a.days, "day")} on ${iso(today)}.`,
      age: a,
      birthdate: iso(start),
      on: iso(today),
      totalDays: Math.round((today - start) / DAY),
    };
  }
  if (addN !== undefined && Number.isFinite(addN)) {
    const result =
      unit === "month"
        ? addMonths(start, addN)
        : unit === "year"
          ? addMonths(start, addN * 12)
          : new Date(start.getTime() + addN * (unit === "week" ? 7 : 1) * DAY);
    return {
      ok: true,
      answer: `${iso(start)} ${addN >= 0 ? "plus" : "minus"} ${plural(Math.abs(addN), unit)} is ${iso(result)} (${NAMES[result.getUTCDay()]}).`,
      from: iso(start),
      result: iso(result),
      weekday: NAMES[result.getUTCDay()],
    };
  }
  if (end || wantsUntil) {
    const to = end ?? start;
    const from = end ? start : today;
    const [a, b] = from <= to ? [from, to] : [to, from];
    const days = Math.round((b - a) / DAY);
    const parts = ymd(a, b);
    return {
      ok: true,
      answer:
        wantsUntil && !end
          ? `${days} day(s) ${from <= to ? "until" : "since"} ${iso(to)} from ${iso(from)} (${plural(parts.years, "year")}, ${plural(parts.months, "month")}, ${plural(parts.days, "day")}).`
          : `${days} day(s) between ${iso(a)} and ${iso(b)} (${plural(parts.years, "year")}, ${plural(parts.months, "month")}, ${plural(parts.days, "day")}); ${Math.floor(days / 7)} week(s) and ${days % 7} day(s).`,
      days,
      weeks: Math.floor(days / 7),
      remainderDays: days % 7,
      breakdown: parts,
      from: iso(a),
      to: iso(b),
      direction: from <= to ? "forward" : "backward",
    };
  }
  return {
    ok: true,
    answer: `${iso(start)} is a ${NAMES[start.getUTCDay()]}, day ${Math.round((start - new Date(Date.UTC(start.getUTCFullYear(), 0, 0))) / DAY)} of the year.`,
    date: iso(start),
    weekday: NAMES[start.getUTCDay()],
  };
}

export default run;
