// FRIDAY · skill: ops-cron-explain
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Explains a 5-field cron expression in words, validates it and lists the next run times.

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MACROS = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};
const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: DAYS, offset: 0 },
];

function value(token, field) {
  const upper = token.toUpperCase();
  if (field.names) {
    const at = field.names.indexOf(upper);
    if (at >= 0) return at + field.offset;
  }
  if (!/^\d+$/.test(token)) throw new Error(`"${token}" is not a number or name for ${field.name}`);
  const n = Number(token);
  if (n < field.min || n > field.max)
    throw new Error(`${n} is outside ${field.min}-${field.max} for ${field.name}`);
  return n;
}

function parseField(text, field) {
  const set = new Set();
  let wildcard = false;
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new Error(`bad step "${stepText}" in ${field.name}`);
      step = Number(stepText);
    }
    let from;
    let to;
    if (range === "*" || range === "?") {
      from = field.min;
      to = field.name === "day of week" ? 6 : field.max;
      if (stepText === undefined) wildcard = true;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = value(a, field);
      to = value(b, field);
      if (from > to) throw new Error(`range ${range} runs backwards in ${field.name}`);
    } else {
      from = value(range, field);
      to = stepText !== undefined ? (field.name === "day of week" ? 6 : field.max) : from;
    }
    for (let n = from; n <= to; n += step) set.add(field.name === "day of week" && n === 7 ? 0 : n);
  }
  return { set, wildcard };
}

export function parse(expression) {
  const trimmed = String(expression).trim();
  const expanded = MACROS[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      `Expected 5 fields (minute hour day-of-month month day-of-week), got ${parts.length}.`,
    );
  const parsed = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { text: expanded, fields: parsed };
}

function matches(parsed, d) {
  const [min, hour, dom, mon, dow] = parsed.fields;
  if (
    !min.set.has(d.getUTCMinutes()) ||
    !hour.set.has(d.getUTCHours()) ||
    !mon.set.has(d.getUTCMonth() + 1)
  )
    return false;
  const domOk = dom.set.has(d.getUTCDate());
  const dowOk = dow.set.has(d.getUTCDay());
  // Standard cron: when both day fields are restricted, either one may match.
  if (!dom.wildcard && !dow.wildcard) return domOk || dowOk;
  return domOk && dowOk;
}

export function nextRuns(parsed, from, count, offsetMinutes) {
  const out = [];
  // Work in "local" wall time by shifting the clock, then shift each result back.
  const start = new Date(from.getTime() + offsetMinutes * 60000);
  start.setUTCSeconds(0, 0);
  const cursor = new Date(start.getTime() + 60000);
  const limit = cursor.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (out.length < count && cursor.getTime() < limit) {
    const [, hour, dom, mon, dow] = parsed.fields;
    if (!mon.set.has(cursor.getUTCMonth() + 1)) {
      cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domOk = dom.set.has(cursor.getUTCDate());
    const dowOk = dow.set.has(cursor.getUTCDay());
    const dayOk = !dom.wildcard && !dow.wildcard ? domOk || dowOk : domOk && dowOk;
    if (!dayOk) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!hour.set.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (matches(parsed, cursor)) out.push(new Date(cursor.getTime() - offsetMinutes * 60000));
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return out;
}

function describeField(field, spec) {
  if (spec.wildcard) return `every ${field.name}`;
  const values = [...spec.set].sort((a, b) => a - b);
  const label = (n) =>
    field.name === "month"
      ? MONTHS[n - 1]
      : field.name === "day of week"
        ? DAYS[n]
        : String(n).padStart(field.name === "minute" || field.name === "hour" ? 2 : 1, "0");
  return `${field.name} ${values.map(label).join(", ")}`;
}

function sentence(parsed) {
  const [min, hour, dom, mon, dow] = parsed.fields;
  const when =
    !min.wildcard && !hour.wildcard && min.set.size === 1 && hour.set.size === 1
      ? `at ${String([...hour.set][0]).padStart(2, "0")}:${String([...min.set][0]).padStart(2, "0")}`
      : [describeField(FIELDS[1], hour), describeField(FIELDS[0], min)].join(", ");
  const days = [];
  if (!dom.wildcard) days.push(describeField(FIELDS[2], dom));
  if (!dow.wildcard) days.push(describeField(FIELDS[4], dow));
  const monthPart = !mon.wildcard ? ` in ${describeField(FIELDS[3], mon)}` : "";
  const joiner = !dom.wildcard && !dow.wildcard ? " or " : " and ";
  return `${when}${days.length ? `, on ${days.join(joiner)}` : ", every day"}${monthPart}`;
}

function offsetOf(text) {
  const m = String(text ?? "0")
    .trim()
    .match(/^(?:UTC)?([+-])?(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}

/** The first @macro, or five consecutive cron-looking words that start like a minute field. */
function fromText(text) {
  const macro = text.match(/@\w+/);
  if (macro && MACROS[macro[0].toLowerCase()]) return macro[0];
  const words = text.split(/\s+/).filter(Boolean);
  const cronWord = /^[0-9A-Za-z*?,\-/]+$/;
  const minute = /^(\*|\?|\d[\d,\-/]*|\*\/\d+)$/;
  for (let i = 0; i + 5 <= words.length; i += 1) {
    const window = words.slice(i, i + 5);
    if (minute.test(window[0]) && window.every((w) => cronWord.test(w))) return window.join(" ");
  }
  return "";
}

export async function run(input = {}) {
  const raw =
    String(input?.cron ?? input?.expression ?? "").trim() ||
    fromText(String(input?.prompt ?? input?.text ?? ""));
  if (!raw)
    return { ok: false, error: "Give a cron expression such as */15 * * * * or 0 9 * * MON-FRI." };
  let parsed;
  try {
    parsed = parse(raw);
  } catch (error) {
    return { ok: false, error: `Not a valid cron expression: ${error.message}` };
  }
  const from = input?.from ? new Date(input.from) : new Date();
  if (Number.isNaN(from.getTime()))
    return { ok: false, error: "from must be a date such as 2026-11-07T09:00:00Z." };
  const count = Math.max(1, Math.min(20, Number(input?.count) || 5));
  const offset = offsetOf(input?.utcOffset ?? input?.timezone);
  const runs = nextRuns(parsed, from, count, offset);
  const pad = (n) => String(n).padStart(2, "0");
  const local = (d) => {
    const t = new Date(d.getTime() + offset * 60000);
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  };
  return {
    ok: true,
    expression: parsed.text,
    answer: `Runs ${sentence(parsed)}.`,
    utcOffsetMinutes: offset,
    nextRuns: runs.map((d) => ({ utc: d.toISOString(), local: local(d) })),
    note: "Day-of-month and day-of-week both set means either one matches (standard cron). Times are in the offset you gave; the default is UTC.",
  };
}

export default run;
