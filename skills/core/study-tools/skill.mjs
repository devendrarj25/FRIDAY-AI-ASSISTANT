// FRIDAY · skill: study-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Spaced repetition, grade conversion, exam plan and pomodoro. Planning and arithmetic for students.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "spaced-repetition",
    gate: /spaced|sm-?2|flashcard|review schedule|anki|revision schedule|leitner/,
    run: (() => {
      // Spaced repetition (SM-2): when to review a flashcard or topic next, from how well you remembered it.
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const num = (key, re, fallback) =>
          input[key] != null ? Number(input[key]) : re.exec(t) ? Number(re.exec(t)[1]) : fallback;
        const quality = num(
          "quality",
          /(?:quality|grade|rating|score)\s*(?:of|is|=|:)?\s*([0-5])\b/,
          NaN,
        );
        const reps = num(
          "repetitions",
          /(?:reps?|repetitions?|streak)\s*(?:of|is|=|:)?\s*(\d+)/,
          0,
        );
        let ease = num("easeFactor", /ease(?:\s*factor)?\s*(?:of|is|=|:)?\s*(\d(?:\.\d+)?)/, 2.5);
        const interval = num("interval", /interval\s*(?:of|is|=|:)?\s*(\d+)/, 0);
        if (!Number.isFinite(quality)) {
          const plan = [];
          let i = 0;
          let e = 2.5;
          for (let n = 0; n < 7; n++) {
            i = n === 0 ? 1 : n === 1 ? 6 : Math.round(i * e);
            plan.push(i);
          }
          const days = [];
          let total = 0;
          for (const d of plan) {
            total += d;
            days.push(total);
          }
          return {
            ok: true,
            scheduleIfAlwaysRecalled: days,
            answer: `Review on day ${days.join(", ")} after first learning (if you recall each time with quality 4). Give a quality 0-5 for one card to get its next date.`,
          };
        }
        if (quality < 0 || quality > 5)
          return { ok: false, error: "Quality is 0 (blackout) to 5 (perfect)." };
        ease = Math.max(1.3, ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
        let nextReps;
        let next;
        if (quality < 3) {
          nextReps = 0;
          next = 1;
        } else {
          nextReps = reps + 1;
          next = reps === 0 ? 1 : reps === 1 ? 6 : Math.round(Math.max(1, interval) * ease);
        }
        return {
          ok: true,
          nextIntervalDays: next,
          repetitions: nextReps,
          easeFactor: Math.round(ease * 100) / 100,
          answer:
            quality < 3
              ? "Forgotten: start over, review again tomorrow."
              : `Review again in ${next} day(s); ease ${Math.round(ease * 100) / 100}, repetition ${nextReps}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "grade-convert",
    gate: /cgpa|gpa|sgpa|marks|percentage of|to percentage|to cgpa|division/,
    run: (() => {
      // Marks and grades: marks to percentage, CGPA to percentage (x9.5, CBSE rule) and back, division by percentage.
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        let m;
        const r2 = (n) => Math.round(n * 100) / 100;
        const div = (p) =>
          p >= 75
            ? "distinction"
            : p >= 60
              ? "first division"
              : p >= 50
                ? "second division"
                : p >= 40
                  ? "third division / pass"
                  : "below pass marks";
        if (
          (m = /(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+(?:\.\d+)?)/.exec(t)) &&
          !/cgpa|gpa/.test(t)
        ) {
          const p = (Number(m[1]) / Number(m[2])) * 100;
          if (!(Number(m[2]) > 0)) return { ok: false, error: "Total marks must be above 0." };
          return {
            ok: true,
            percentage: r2(p),
            cgpaEquivalent: r2(p / 9.5),
            answer: `${m[1]} out of ${m[2]} = ${r2(p)}% (${div(p)}); about ${r2(p / 9.5)} CGPA on the CBSE 10-point scale.`,
          };
        }
        if (
          (m = /(\d+(?:\.\d+)?)\s*(?:cgpa|gpa|sgpa)/.exec(t)) ||
          (m = /(?:cgpa|gpa|sgpa)\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/.exec(t))
        ) {
          const g = Number(m[1]);
          if (g > 10)
            return { ok: false, error: "CGPA is on a 10-point scale (or 4-point for GPA)." };
          if (g <= 4 && /\bgpa\b/.test(t) && !/cgpa|sgpa/.test(t))
            return {
              ok: true,
              percentage: r2((g / 4) * 100),
              answer: `GPA ${g} on a 4.0 scale is roughly ${r2((g / 4) * 100)}% (universities differ; ask yours for the official rule).`,
            };
          return {
            ok: true,
            percentage: r2(g * 9.5),
            answer: `CGPA ${g} x 9.5 = ${r2(g * 9.5)}% (CBSE formula; many universities publish their own).`,
          };
        }
        if ((m = /(\d+(?:\.\d+)?)\s*(?:%|percent|percentage)/.exec(t))) {
          const p = Number(m[1]);
          return {
            ok: true,
            cgpa: r2(p / 9.5),
            division: div(p),
            answer: `${p}% = ${r2(p / 9.5)} CGPA (CBSE 9.5 rule), ${div(p)}.`,
          };
        }
        return {
          ok: false,
          error: "Say it like 432 out of 500, CGPA 8.2 to percentage, or 78% to CGPA.",
        };
      }

      return run;
    })(),
  },
  {
    id: "exam-plan",
    gate: /exam|study plan|revision plan|days left|timetable/,
    run: (() => {
      // Exam plan: splits the days left into learning, revision and mock-test days for a number of subjects or topics.
      const parseDate = (s) => {
        let m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
        if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
        m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
        if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
        return NaN;
      };

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const now = new Date();
        const today = input.today
          ? parseDate(String(input.today))
          : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        let days = input.days != null ? Number(input.days) : NaN;
        const exam = parseDate(t.replace(/today\s*[:=]\s*\S+/, ""));
        if (!(days > 0) && Number.isFinite(exam)) days = Math.round((exam - today) / 86400000);
        const dm = /(\d+)\s*days?\s*(?:left|to go|remaining|before)/.exec(t);
        if (!(days > 0) && dm) days = Number(dm[1]);
        const subjects =
          input.subjects != null
            ? Number(input.subjects)
            : Number((/(\d+)\s*(?:subjects?|papers?|chapters?|topics?|units?)/.exec(t) ?? [])[1]);
        const hours =
          input.hours != null
            ? Number(input.hours)
            : Number(
                (/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s*(?:a|per|each|\/)?\s*day/.exec(t) ?? [])[1],
              ) || 4;
        if (!(days > 0) || !(subjects > 0)) {
          return {
            ok: false,
            error:
              "Give the exam date (or days left) and the number of subjects or topics, e.g. exam on 2026-12-15, 6 subjects, 4 hours a day.",
          };
        }
        const revision = Math.max(1, Math.round(days * 0.25));
        const mocks = Math.max(
          0,
          Math.min(Math.floor(days / 7), Math.round(days * 0.1) || (days > 14 ? 1 : 0)),
        );
        const learning = Math.max(1, days - revision);
        const perDay = Math.round((subjects / learning) * 100) / 100;
        const daysPerSubject = Math.round((learning / subjects) * 10) / 10;
        return {
          ok: true,
          daysLeft: days,
          learningDays: learning,
          revisionDays: revision,
          mockTests: mocks,
          daysPerSubject,
          topicsPerDay: perDay,
          hoursPerDay: hours,
          totalStudyHours: Math.round(days * hours),
          answer: `${days} day(s) left, ${subjects} subject(s) at ${hours} h a day: about ${daysPerSubject} day(s) per subject for ${learning} learning days, then ${revision} revision days${mocks ? ` with ${mocks} full mock test(s)` : ""}. ${Math.round(days * hours)} study hours in total. Keep one rest day a week.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "pomodoro-plan",
    gate: /pomodoro|focus (?:sessions|blocks)|study blocks/,
    run: (() => {
      // Pomodoro: breaks a study or work stretch into focus blocks with short and long breaks.
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const h = Number((/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/.exec(t) ?? [])[1]);
        const mm = Number((/(\d+)\s*(?:minutes?|mins?|m)\b/.exec(t) ?? [])[1]);
        const total =
          input.minutes != null
            ? Number(input.minutes)
            : (Number.isFinite(h) ? h * 60 : 0) + (Number.isFinite(mm) ? mm : 0);
        if (!(total >= 25))
          return { ok: false, error: "Give the time you have, e.g. pomodoro plan for 3 hours." };
        const focus =
          Number(input.focus) ||
          Number((/(\d+)\s*(?:min|minute)s?\s*(?:focus|work|blocks?)/.exec(t) ?? [])[1]) ||
          25;
        const short = 5;
        const long = 20;
        const blocks = [];
        let used = 0;
        let n = 0;
        let clock = 0;
        const hhmm = (x) => `${Math.floor(x / 60)}:${String(x % 60).padStart(2, "0")}`;
        while (used + focus <= total) {
          n++;
          blocks.push({ block: n, focusFrom: hhmm(clock), focusTo: hhmm(clock + focus) });
          used += focus;
          clock += focus;
          const gap = n % 4 === 0 ? long : short;
          if (used + gap + focus > total) break;
          used += gap;
          clock += gap;
        }
        return {
          ok: true,
          focusBlocks: n,
          focusMinutes: n * focus,
          blocks,
          answer: `${n} focus block(s) of ${focus} min with a ${short} min break after each and ${long} min after every fourth (offsets from the start: ${blocks.map((b) => `${b.focusFrom}-${b.focusTo}`).join(", ")}). Total focused time ${n * focus} min.`,
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
