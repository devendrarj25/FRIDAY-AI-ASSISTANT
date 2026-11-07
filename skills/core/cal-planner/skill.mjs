// FRIDAY · skill: cal-planner
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Calendar event files, cron schedules and day plans. Turns plans into calendar files, schedules and timed day plans.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "cal-ics-event",
    gate: null,
    run: (() => {
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

      async function run(input = {}) {
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
        if (input?.end && !end)
          return { ok: false, error: "The end must look like 2026-11-12 16:30." };
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

      return run;
    })(),
  },
  {
    id: "cal-time-blocks",
    gate: null,
    run: (() => {
      // FRIDAY · skill: cal-time-blocks
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Lay a list of tasks with durations out as a timed schedule from a start time, with a short break between them.

      const hhmm = (mins) => {
        const m = ((mins % 1440) + 1440) % 1440;
        return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      };
      const DUR = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/i;

      async function run(input = {}) {
        let text = String(input?.prompt ?? input?.text ?? "");
        let buffer = input.buffer != null ? Number(input.buffer) : 5;
        const bm = /(\d+)\s*(?:min(?:ute)?s?|m)\s*(?:break|buffer|gap)s?/i.exec(text);
        if (bm) {
          if (input.buffer == null) buffer = Number(bm[1]);
          text = text.replace(bm[0], " ");
        }
        let start = 9 * 60;
        const tm =
          /\b(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text) || /\b(\d{1,2})()\s*(am|pm)\b/i.exec(text);
        if (tm) {
          let h = Number(tm[1]);
          const mm = Number(tm[2] || 0);
          const ap = (tm[3] || "").toLowerCase();
          if (ap === "pm" && h < 12) h += 12;
          if (ap === "am" && h === 12) h = 0;
          if (h < 24 && mm < 60) start = h * 60 + mm;
          text = text.replace(tm[0], " ");
        }
        if (input.start != null) {
          const sm = /^(\d{1,2}):(\d{2})$/.exec(String(input.start));
          if (sm) start = Number(sm[1]) * 60 + Number(sm[2]);
        }
        const pieces = text.split(/[,;\n]|\band\b|\bthen\b|->/i);
        const tasks = [];
        for (const piece of pieces) {
          const d = DUR.exec(piece);
          if (!d) continue;
          const minutes = Math.round(Number(d[1]) * (/^h/i.test(d[2]) ? 60 : 1));
          if (minutes < 1 || minutes > 1440) continue;
          let name = piece.replace(d[0], " ").replace(/\bfor\b/gi, " ");
          for (let i = 0; i < 3; i++) {
            name = name.replace(
              /^[\s:,.-]*(?:plan|schedule|my day|day plan|timetable|starting|start|begin|at|from)\b[\s:,.-]*/i,
              "",
            );
          }
          name = name.replace(/^[\s:,.()-]+|[\s:,.()-]+$/g, "").replace(/\s+/g, " ");
          tasks.push({ task: name || `Task ${tasks.length + 1}`, minutes });
        }
        if (!tasks.length) {
          return {
            ok: false,
            error: "Give tasks with durations, e.g. plan 9:00: report 45m, email 20m, gym 30m.",
          };
        }
        let t = start;
        const schedule = tasks.map((x, i) => {
          const row = {
            task: x.task,
            start: hhmm(t),
            end: hhmm(t + x.minutes),
            minutes: x.minutes,
          };
          t += x.minutes + (i < tasks.length - 1 ? buffer : 0);
          return row;
        });
        const total = tasks.reduce((a, x) => a + x.minutes, 0);
        return {
          ok: true,
          schedule,
          bufferMinutes: buffer,
          totalMinutes: total,
          finish: hhmm(t),
          answer:
            schedule.map((r) => `${r.start}-${r.end}  ${r.task} (${r.minutes} min)`).join("\n") +
            `\nDone by ${hhmm(t)}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-cron-explain",
    gate: null,
    run: (() => {
      // FRIDAY · skill: ops-cron-explain
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Explains a 5-field cron expression in words, validates it and lists the next run times.

      const MONTHS = [
        "JAN",
        "FEB",
        "MAR",
        "APR",
        "MAY",
        "JUN",
        "JUL",
        "AUG",
        "SEP",
        "OCT",
        "NOV",
        "DEC",
      ];
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
        if (!/^\d+$/.test(token))
          throw new Error(`"${token}" is not a number or name for ${field.name}`);
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
          for (let n = from; n <= to; n += step)
            set.add(field.name === "day of week" && n === 7 ? 0 : n);
        }
        return { set, wildcard };
      }

      function parse(expression) {
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

      function nextRuns(parsed, from, count, offsetMinutes) {
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
          if (minute.test(window[0]) && window.every((w) => cronWord.test(w)))
            return window.join(" ");
        }
        return "";
      }

      async function run(input = {}) {
        const raw =
          String(input?.cron ?? input?.expression ?? "").trim() ||
          fromText(String(input?.prompt ?? input?.text ?? ""));
        if (!raw)
          return {
            ok: false,
            error: "Give a cron expression such as */15 * * * * or 0 9 * * MON-FRI.",
          };
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

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
