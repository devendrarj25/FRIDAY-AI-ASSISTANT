// FRIDAY · skill: cal-date-time
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Days between dates, working days, age, timestamps and time zones. Every date and clock question in one skill.
// It holds 5 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "ops-date-calc",
    gate: null,
    run: (() => {
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
        return date.getUTCFullYear() === y &&
          date.getUTCMonth() === mo - 1 &&
          date.getUTCDate() === d
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

      async function run(input = {}) {
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
        const start =
          parseDate(input?.start ?? input?.date ?? input?.birthdate) ?? dates[0] ?? null;
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

      return run;
    })(),
  },
  {
    id: "ops-workdays",
    gate: null,
    run: (() => {
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
        return date.getUTCFullYear() === y &&
          date.getUTCMonth() === mo - 1 &&
          date.getUTCDate() === d
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

      async function run(input = {}) {
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
          return {
            ok: false,
            error: "Give a date such as 2026-04-01 or 01-04-2026 (day-month-year).",
          };
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

      return run;
    })(),
  },
  {
    id: "cal-age-calc",
    gate: /\b(age|born|birth|birthday|dob|janm|umar|old)\b/,
    run: (() => {
      // FRIDAY · skill: cal-age-calc
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Exact age from a date of birth (years, months, days), the next birthday and the weekday of birth. Dates are day-first.

      const MONTHS = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ];
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

      async function run(input = {}) {
        const found = findDates(String(input?.prompt ?? input?.text ?? ""));
        const parse = (v) => (v ? findDates(String(v))[0] : null);
        const dob = parse(input.dob) ?? found[0];
        let asOf = parse(input.asOf) ?? (input.dob ? found[0] : found[1]);
        if (!dob)
          return { ok: false, error: "Give a date of birth, e.g. born 15-08-1995 (day first)." };
        if (!asOf) {
          const now = new Date();
          asOf = { y: now.getUTCFullYear(), m: now.getUTCMonth() + 1, d: now.getUTCDate() };
        }
        const a = Date.UTC(dob.y, dob.m - 1, dob.d);
        const b = Date.UTC(asOf.y, asOf.m - 1, asOf.d);
        if (a > b)
          return { ok: false, error: "That date of birth is after the date to measure to." };

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

      return run;
    })(),
  },
  {
    id: "ops-timestamp",
    gate: null,
    run: (() => {
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

      async function run(input = {}) {
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
            from =
              len <= 11 ? "Unix seconds" : len <= 13 ? "Unix milliseconds" : "Unix microseconds";
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

      return run;
    })(),
  },
  {
    id: "ops-time-zone",
    gate: null,
    run: (() => {
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

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? "");
        const lower = text.toLowerCase();
        const fromRaw = input?.from;
        const toRaw = input?.to;
        const names = Object.keys(ZONES).sort((a, b) => b.length - a.length);
        const found = [];
        for (const n of names) {
          const at = lower.search(new RegExp(`(?<![a-z])${n.replace(/ /g, "\\s+")}(?![a-z])`));
          if (at >= 0 && !found.some((f) => at >= f.at && at < f.at + f.n.length))
            found.push({ n, at });
        }
        found.sort((a, b) => a.at - b.at);
        const from = zoneOf(fromRaw ?? found[0]?.n);
        const targets = (
          Array.isArray(toRaw) ? toRaw : toRaw ? [toRaw] : found.slice(1).map((f) => f.n)
        )
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
        const dateText = String(
          input?.date ?? (text.match(/\b\d{4}-\d{2}-\d{2}\b/) ?? [])[0] ?? "",
        );
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
