// FRIDAY · skill: cal-ics-event
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Builds a standards-correct iCalendar (.ics) event that Outlook, Google Calendar and phones import,
// without any calendar account or connector. Text is escaped and long lines are folded as RFC 5545 requires.

const pad = (n, w = 2) => String(n).padStart(w, "0");

function parseWhen(text, offsetMinutes) {
  const s = String(text ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?(Z)?$/);
  if (!m) return null;
  const allDay = m[4] === undefined;
  const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  const utc = m[6] ? local : local - offsetMinutes * 60000;
  return { allDay, utc, local, y: +m[1], mo: +m[2], d: +m[3] };
}
const utcStamp = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const dateStamp = (ms) => utcStamp(ms).slice(0, 8);

const escapeText = (v) =>
  String(v ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets continue on the next line after CRLF + one space. */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const ch of line) {
    const n = new TextEncoder().encode(ch).length;
    if (size + n > limit) {
      out.push(current);
      current = "";
      size = 0;
      limit = 74; // the leading space of a continuation counts too
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

const offsetOf = (text) => {
  const m = String(text ?? "+5:30")
    .trim()
    .match(/^(?:UTC)?([+-])?(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return 330;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
};

export async function run(input = {}) {
  const title = String(input?.title ?? input?.summary ?? "").trim();
  const offset = offsetOf(input?.utcOffset ?? input?.timezone);
  const start = parseWhen(input?.start, offset);
  if (!title) return { ok: false, error: "Give the event a title." };
  if (!start)
    return {
      ok: false,
      error: "Give a start such as 2026-11-12 15:30 (or 2026-11-12 for an all-day event).",
    };
  let end = input?.end ? parseWhen(input.end, offset) : null;
  if (input?.end && !end) return { ok: false, error: "The end must look like 2026-11-12 16:30." };
  const minutes = Number(input?.durationMinutes ?? 60);
  const endUtc = end
    ? end.utc
    : start.allDay
      ? start.utc + 86400000
      : start.utc + (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60000;
  if (endUtc <= start.utc && !start.allDay)
    return { ok: false, error: "The end must be after the start." };
  const stamp = input?.stamp ? Date.parse(input.stamp) : Date.now();
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FRIDAY//Calendar event//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
  ];
  lines.push(
    `UID:${hash(`${title}|${input.start}|${input.end ?? ""}|${input.location ?? ""}`)}@friday.local`,
  );
  lines.push(`DTSTAMP:${utcStamp(Number.isFinite(stamp) ? stamp : Date.now())}`);
  if (start.allDay) {
    lines.push(
      `DTSTART;VALUE=DATE:${dateStamp(start.local)}`,
      `DTEND;VALUE=DATE:${dateStamp(end && end.allDay ? end.local + 86400000 : start.local + 86400000)}`,
    );
  } else {
    lines.push(`DTSTART:${utcStamp(start.utc)}`, `DTEND:${utcStamp(endUtc)}`);
  }
  lines.push(`SUMMARY:${escapeText(title)}`);
  if (input?.location) lines.push(`LOCATION:${escapeText(input.location)}`);
  if (input?.description) lines.push(`DESCRIPTION:${escapeText(input.description)}`);
  const repeat = String(input?.repeat ?? "").toLowerCase();
  if (["daily", "weekly", "monthly", "yearly"].includes(repeat)) {
    const count = Number(input?.count);
    lines.push(
      `RRULE:FREQ=${repeat.toUpperCase()}${Number.isInteger(count) && count > 0 ? `;COUNT=${count}` : ""}`,
    );
  }
  const reminder = Number(input?.reminderMinutes);
  if (Number.isFinite(reminder) && reminder >= 0) {
    lines.push(
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeText(title)}`,
      `TRIGGER:-PT${Math.round(reminder)}M`,
      "END:VALARM",
    );
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  const ics = `${lines.map(fold).join("\r\n")}\r\n`;
  return {
    ok: true,
    answer: `Calendar file for "${title}" (${start.allDay ? "all day" : `${new Date(start.utc).toISOString().slice(0, 16)}Z`}). Save the text as event.ics and open it.`,
    fileName: `${
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "event"
    }.ics`,
    ics,
    note: `Times without a Z are read in UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)} (set utcOffset to change it) and written as UTC, so every calendar shows the right moment.`,
  };
}

export default run;
