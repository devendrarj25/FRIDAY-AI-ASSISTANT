// FRIDAY · skill: cal-age-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Exact age from a date of birth (years, months, days), the next birthday and the weekday of birth. Dates are day-first.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n) => String(n).padStart(2, "0");
const valid = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

function findDates(s) {
  const t = s.toLowerCase();
  const out = [];
  const taken = [];
  const add = (idx, len, y, m, d) => {
    if (!valid(y, m, d) || taken.some(([a, b]) => idx < b && idx + len > a)) return;
    taken.push([idx, idx + len]);
    out.push({ idx, y, m, d });
  };
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g))
    add(m.index, m[0].length, +m[1], +m[2], +m[3]);
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g))
    add(m.index, m[0].length, +m[3], +m[2], +m[1]);
  const name = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  for (const m of t.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${name},?\\s+(\\d{4})\\b`, "g"),
  )) {
    add(m.index, m[0].length, +m[3], MONTHS.indexOf(m[2]) + 1, +m[1]);
  }
  for (const m of t.matchAll(
    new RegExp(`\\b${name}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g"),
  )) {
    add(m.index, m[0].length, +m[3], MONTHS.indexOf(m[1]) + 1, +m[2]);
  }
  return out.sort((a, b) => a.idx - b.idx);
}

export async function run(input = {}) {
  const found = findDates(String(input?.prompt ?? input?.text ?? ""));
  const parse = (v) => (v ? findDates(String(v))[0] : null);
  const dob = parse(input.dob) ?? found[0];
  let asOf = parse(input.asOf) ?? (input.dob ? found[0] : found[1]);
  if (!dob) return { ok: false, error: "Give a date of birth, e.g. born 15-08-1995 (day first)." };
  if (!asOf) {
    const now = new Date();
    asOf = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
  }
  const a = Date.UTC(dob.y, dob.m - 1, dob.d);
  const b = Date.UTC(asOf.y, asOf.m - 1, asOf.d);
  if (a > b) return { ok: false, error: "That date of birth is after the date to measure to." };

  let years = asOf.y - dob.y;
  let months = asOf.m - dob.m;
  let days = asOf.d - dob.d;
  if (days < 0) {
    months--;
    const pm = asOf.m === 1 ? 12 : asOf.m - 1;
    days += dim(asOf.m === 1 ? asOf.y - 1 : asOf.y, pm);
  }
  if (months < 0) {
    years--;
    months += 12;
  }
  const birthday = (year) =>
    dob.m === 2 && dob.d === 29 && !valid(year, 2, 29) ? [year, 2, 28] : [year, dob.m, dob.d];
  let [by, bm, bd] = birthday(asOf.y);
  if (Date.UTC(by, bm - 1, bd) < b) [by, bm, bd] = birthday(asOf.y + 1);
  const untilBirthday = Math.round((Date.UTC(by, bm - 1, bd) - b) / 86400000);
  const totalDays = Math.round((b - a) / 86400000);
  const weekday = DAYS[new Date(a).getUTCDay()];
  return {
    ok: true,
    dateOfBirth: `${dob.y}-${pad(dob.m)}-${pad(dob.d)}`,
    asOf: `${asOf.y}-${pad(asOf.m)}-${pad(asOf.d)}`,
    years,
    months,
    days,
    totalDays,
    weekdayBorn: weekday,
    nextBirthday: `${by}-${pad(bm)}-${pad(bd)}`,
    daysToNextBirthday: untilBirthday,
    turning: years + (untilBirthday === 0 ? 0 : 1),
    answer: `${years} years, ${months} months, ${days} days (${totalDays} days) as of ${asOf.y}-${pad(asOf.m)}-${pad(asOf.d)}. Born on a ${weekday}. Next birthday ${by}-${pad(bm)}-${pad(bd)}, in ${untilBirthday} day(s).`,
  };
}

export default run;
