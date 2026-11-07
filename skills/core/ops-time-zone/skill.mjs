// FRIDAY · skill: ops-time-zone
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Converts a clock time between time zones, with the daylight-saving rules of the date you give.

const ZONES = {
  ist: "Asia/Kolkata",
  india: "Asia/Kolkata",
  delhi: "Asia/Kolkata",
  mumbai: "Asia/Kolkata",
  kolkata: "Asia/Kolkata",
  bangalore: "Asia/Kolkata",
  bengaluru: "Asia/Kolkata",
  pune: "Asia/Kolkata",
  chennai: "Asia/Kolkata",
  hyderabad: "Asia/Kolkata",
  utc: "UTC",
  gmt: "UTC",
  london: "Europe/London",
  uk: "Europe/London",
  bst: "Europe/London",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  pt: "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  est: "America/New_York",
  edt: "America/New_York",
  et: "America/New_York",
  "new york": "America/New_York",
  boston: "America/New_York",
  washington: "America/New_York",
  cst: "America/Chicago",
  cdt: "America/Chicago",
  chicago: "America/Chicago",
  mst: "America/Denver",
  mdt: "America/Denver",
  denver: "America/Denver",
  toronto: "America/Toronto",
  vancouver: "America/Vancouver",
  cet: "Europe/Berlin",
  cest: "Europe/Berlin",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  madrid: "Europe/Madrid",
  rome: "Europe/Rome",
  amsterdam: "Europe/Amsterdam",
  dubai: "Asia/Dubai",
  gst: "Asia/Dubai",
  "abu dhabi": "Asia/Dubai",
  riyadh: "Asia/Riyadh",
  karachi: "Asia/Karachi",
  dhaka: "Asia/Dhaka",
  kathmandu: "Asia/Kathmandu",
  colombo: "Asia/Colombo",
  singapore: "Asia/Singapore",
  sgt: "Asia/Singapore",
  "hong kong": "Asia/Hong_Kong",
  hkt: "Asia/Hong_Kong",
  shanghai: "Asia/Shanghai",
  beijing: "Asia/Shanghai",
  tokyo: "Asia/Tokyo",
  jst: "Asia/Tokyo",
  seoul: "Asia/Seoul",
  kst: "Asia/Seoul",
  sydney: "Australia/Sydney",
  aest: "Australia/Sydney",
  aedt: "Australia/Sydney",
  melbourne: "Australia/Melbourne",
  auckland: "Pacific/Auckland",
  nzst: "Pacific/Auckland",
  moscow: "Europe/Moscow",
  istanbul: "Europe/Istanbul",
  cairo: "Africa/Cairo",
  johannesburg: "Africa/Johannesburg",
  nairobi: "Africa/Nairobi",
  lagos: "Africa/Lagos",
  "sao paulo": "America/Sao_Paulo",
  "mexico city": "America/Mexico_City",
};
const AMBIGUOUS = {
  cst: "CST can mean US Central, China or Cuba Standard Time; US Central (America/Chicago) was used.",
  bst: "BST is British Summer Time here (Europe/London), not Bangladesh Standard Time.",
  ist: "IST is India Standard Time (Asia/Kolkata), not Irish or Israel time.",
};

function zoneOf(token) {
  const t = String(token ?? "")
    .trim()
    .toLowerCase();
  if (ZONES[t]) return { id: ZONES[t], note: AMBIGUOUS[t] };
  try {
    new Intl.DateTimeFormat("en", { timeZone: token.trim() });
    return { id: token.trim() };
  } catch {
    return null;
  }
}

/** Offset of a zone at an instant, in minutes. */
function offsetAt(zone, ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** The instant at which a zone's wall clock reads y-m-d h:min. */
function instantFor(zone, y, mo, d, h, min) {
  const naive = Date.UTC(y, mo - 1, d, h, min);
  let guess = naive - offsetAt(zone, naive) * 60000;
  guess = naive - offsetAt(zone, guess) * 60000;
  return guess;
}

function parseClock(text) {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const mer = m[3]?.toLowerCase().replace(/\./g, "");
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, min, explicit: Boolean(m[2] || mer) };
}

const fmt = (zone, ms) => {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const off = offsetAt(zone, ms);
  return `${f.format(new Date(ms))} (UTC${off >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(off) / 60)).padStart(2, "0")}:${String(Math.abs(off) % 60).padStart(2, "0")})`;
};

export async function run(input = {}) {
  const text = String(input?.prompt ?? input?.text ?? "");
  const lower = text.toLowerCase();
  const fromRaw = input?.from;
  const toRaw = input?.to;
  const names = Object.keys(ZONES).sort((a, b) => b.length - a.length);
  const found = [];
  for (const n of names) {
    const at = lower.search(new RegExp(`(?<![a-z])${n.replace(/ /g, "\\s+")}(?![a-z])`));
    if (at >= 0 && !found.some((f) => at >= f.at && at < f.at + f.n.length)) found.push({ n, at });
  }
  found.sort((a, b) => a.at - b.at);
  const from = zoneOf(fromRaw ?? found[0]?.n);
  const targets = (Array.isArray(toRaw) ? toRaw : toRaw ? [toRaw] : found.slice(1).map((f) => f.n))
    .map(zoneOf)
    .filter(Boolean);
  const clock = input?.time
    ? parseClock(String(input.time))
    : parseClock(text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, " "));
  if (!from || !targets.length || !clock) {
    return {
      ok: false,
      error:
        "Say a time, the zone it is in and the zones to show, for example: 3pm IST in New York and London.",
    };
  }
  const dateText = String(input?.date ?? (text.match(/\b\d{4}-\d{2}-\d{2}\b/) ?? [])[0] ?? "");
  const today = new Date();
  const [y, mo, d] = dateText
    ? dateText.split("-").map(Number)
    : [today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate()];
  const instant = instantFor(from.id, y, mo, d, clock.h, clock.min);
  const results = targets.map((t) => ({
    zone: t.id,
    time: fmt(t.id, instant),
    ...(t.note ? { note: t.note } : {}),
  }));
  return {
    ok: true,
    answer: `${fmt(from.id, instant)} in ${from.id} = ${results.map((r) => `${r.time} in ${r.zone}`).join("; ")}.`,
    source: {
      zone: from.id,
      time: fmt(from.id, instant),
      utc: new Date(instant).toISOString(),
      ...(from.note ? { note: from.note } : {}),
    },
    converted: results,
    note: dateText
      ? "Daylight saving is applied for the date you gave."
      : "No date was given, so today's date and today's daylight-saving rules were used.",
  };
}

export default run;
