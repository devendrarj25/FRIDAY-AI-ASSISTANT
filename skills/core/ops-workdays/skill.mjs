// FRIDAY · skill: ops-workdays
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Working days between dates, a date N working days away, and the Indian financial year and quarter of a date.

const DAY_MS = 86400000;

function parseDate(text) {
  const s = String(text ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return mk(+m[3], +m[2], +m[1]); // day-month-year, the Indian order
  return null;
}
function mk(y, mo, d) {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
    ? date
    : null;
}
const iso = (d) => d.toISOString().slice(0, 10);
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function weekendFor(input) {
  const w = String(input?.weekend ?? "sat-sun").toLowerCase();
  if (w === "fri-sat") return new Set([5, 6]);
  if (w === "sun" || w === "sunday") return new Set([0]);
  if (w === "none") return new Set();
  return new Set([0, 6]);
}

function isoWeek(date) {
  const t = new Date(date.getTime());
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - yearStart) / DAY_MS + 1) / 7) };
}

function fiscal(date) {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  const quarter = m >= 4 && m <= 6 ? 1 : m >= 7 && m <= 9 ? 2 : m >= 10 && m <= 12 ? 3 : 4;
  return {
    financialYear: `FY ${start}-${String((start + 1) % 100).padStart(2, "0")}`,
    starts: `${start}-04-01`,
    ends: `${start + 1}-03-31`,
    quarter: `Q${quarter}`,
    assessmentYear: `AY ${start + 1}-${String((start + 2) % 100).padStart(2, "0")}`,
  };
}

export async function run(input = {}) {
  const raw = String(input?.prompt ?? input?.text ?? "");
  const found = [...raw.matchAll(/\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}/g)].map(
    (m) => m[0],
  );
  const start = parseDate(input?.start ?? input?.date ?? found[0]);
  const end = parseDate(input?.end ?? found[1]);
  const add =
    input?.add ??
    input?.days ??
    (raw.match(/\b(?:add|plus|after)\s+(-?\d+)\s+(?:working|business|work)/i) ?? [])[1];
  if (!start)
    return { ok: false, error: "Give a date such as 2026-04-01 or 01-04-2026 (day-month-year)." };
  const weekend = weekendFor(input);
  const holidays = new Set(
    (Array.isArray(input?.holidays)
      ? input.holidays
      : String(input?.holidays ?? "").split(/[,\s]+/)
    )
      .map(parseDate)
      .filter(Boolean)
      .map(iso),
  );
  const working = (d) => !weekend.has(d.getUTCDay()) && !holidays.has(iso(d));
  const out = {
    ok: true,
    date: iso(start),
    weekday: NAMES[start.getUTCDay()],
    isoWeek: isoWeek(start),
    indianFinancialYear: fiscal(start),
    isWorkingDay: working(start),
  };
  if (end) {
    const [a, b] = start <= end ? [start, end] : [end, start];
    let count = 0;
    let weekends = 0;
    for (let d = new Date(a.getTime()); d <= b; d = new Date(d.getTime() + DAY_MS)) {
      if (working(d)) count += 1;
      else if (weekend.has(d.getUTCDay())) weekends += 1;
    }
    out.between = {
      from: iso(a),
      to: iso(b),
      calendarDays: Math.round((b - a) / DAY_MS) + 1,
      workingDays: count,
      weekendDays: weekends,
      holidaysSkipped: [...holidays].filter((h) => h >= iso(a) && h <= iso(b)).length,
      inclusive: true,
    };
    out.answer = `${count} working day(s) from ${iso(a)} to ${iso(b)}, both days included.`;
  }
  if (add !== undefined && add !== null && add !== "" && Number.isFinite(Number(add))) {
    let n = Math.trunc(Number(add));
    const step = n < 0 ? -1 : 1;
    let d = new Date(start.getTime());
    while (n !== 0) {
      d = new Date(d.getTime() + step * DAY_MS);
      if (working(d)) n -= step;
    }
    out.added = {
      workingDays: Math.trunc(Number(add)),
      result: iso(d),
      weekday: NAMES[d.getUTCDay()],
    };
    out.answer = `${iso(d)} (${NAMES[d.getUTCDay()]}) is ${Math.trunc(Number(add))} working day(s) from ${iso(start)}.`;
  }
  out.answer ??= `${iso(start)} is a ${NAMES[start.getUTCDay()]}, in ${out.indianFinancialYear.financialYear} ${out.indianFinancialYear.quarter}.`;
  out.note =
    "Public holidays are not guessed: pass them as holidays (comma separated dates). The financial year runs 1 April to 31 March.";
  return out;
}

export default run;
