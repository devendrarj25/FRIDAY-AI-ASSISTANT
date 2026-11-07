// FRIDAY · skill: ops-timestamp
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Unix time (seconds or milliseconds) to a readable date and back, in UTC and in a time zone offset (default India).

const pad = (n, w = 2) => String(n).padStart(w, "0");
const NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function offsetOf(text) {
  const m = String(text ?? "+5:30")
    .trim()
    .match(/^(?:UTC|IST)?([+-])?(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return 330;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -minutes : minutes;
}
const label = (offset) =>
  `UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;

function shown(ms, offset) {
  const d = new Date(ms + offset * 60000);
  return {
    iso: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${offset === 0 ? "Z" : `${offset > 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`}`,
    weekday: NAMES[d.getUTCDay()],
  };
}

export async function run(input = {}) {
  const text = String(
    input?.value ?? input?.timestamp ?? input?.text ?? input?.prompt ?? "",
  ).trim();
  const offset = offsetOf(
    input?.utcOffset ??
      input?.timezone ??
      (text.match(/(?:UTC|GMT)\s*([+-]\d{1,2}(?::?\d{2})?)/i) ?? [])[1],
  );
  let ms;
  let from;
  if (/\bnow\b/i.test(text) && !/\d{4}-\d{2}-\d{2}/.test(text)) {
    ms = Date.now();
    from = "now";
  } else {
    const iso = text.match(
      /\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*(?:Z|[+-]\d{2}:?\d{2})?/,
    );
    const digits = text.match(/(?<![\d.])-?\d{9,16}(?![\d.])/);
    if (digits && !iso) {
      const n = Number(digits[0]);
      const len = digits[0].replace("-", "").length;
      ms = len <= 11 ? n * 1000 : len <= 13 ? n : len <= 16 ? n / 1000 : NaN;
      from = len <= 11 ? "Unix seconds" : len <= 13 ? "Unix milliseconds" : "Unix microseconds";
    } else if (iso) {
      const s = iso[0].trim();
      const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(s);
      const normalised = s.replace(" ", "T");
      const parsed = hasZone
        ? Date.parse(normalised.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"))
        : Date.parse(`${normalised.length === 10 ? `${normalised}T00:00:00` : normalised}Z`) -
          offset * 60000;
      ms = parsed;
      from = hasZone ? "ISO date with its own zone" : `ISO date read as ${label(offset)}`;
    }
  }
  if (!Number.isFinite(ms))
    return {
      ok: false,
      error:
        "Give a Unix timestamp (1700000000 or 1700000000000), an ISO date (2026-11-07 15:30) or the word now.",
    };
  const utc = shown(ms, 0);
  const local = shown(ms, offset);
  return {
    ok: true,
    answer: `${utc.iso} (UTC) = ${local.iso} ${label(offset)}, ${local.weekday}. Unix: ${Math.floor(ms / 1000)} s, ${Math.floor(ms)} ms.`,
    interpretedAs: from,
    unixSeconds: Math.floor(ms / 1000),
    unixMilliseconds: Math.floor(ms),
    utc: utc.iso,
    local: local.iso,
    localOffset: label(offset),
    weekday: local.weekday,
    usedClock: from === "now" ? true : undefined,
  };
}

export default run;
