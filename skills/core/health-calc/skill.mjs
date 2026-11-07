// FRIDAY · skill: health-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// BMI, calories, heart-rate zones, running pace and water intake. Fitness arithmetic with the formulas shown, as guidance and never as medical advice.
// It holds 5 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "bmi",
    gate: /bmi|body mass|ideal weight|healthy weight/,
    run: (() => {
      // BMI: body mass index, WHO and Asia-Pacific bands, and the healthy weight range for a height.
      const r1 = (n) => Math.round(n * 10) / 10;

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        let kg = input.weightKg != null ? Number(input.weightKg) : NaN;
        let cm = input.heightCm != null ? Number(input.heightCm) : NaN;
        let m;
        if (!(kg > 0)) {
          if ((m = /(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo|kilos|kilogram)/.exec(t))) kg = Number(m[1]);
          else if ((m = /(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)/.exec(t)))
            kg = Number(m[1]) * 0.45359237;
        }
        if (!(cm > 0)) {
          if (
            (m = /(\d)\s*(?:'|ft|feet|foot)\s*(\d{1,2})?\s*(?:"|in|inch|inches)?/.exec(t)) &&
            !/kg/.test(m[0])
          ) {
            cm = (Number(m[1]) * 12 + Number(m[2] || 0)) * 2.54;
          } else if ((m = /(\d+(?:\.\d+)?)\s*cm/.exec(t))) cm = Number(m[1]);
          else if ((m = /(\d(?:\.\d+)?)\s*(?:m|meter|metre)s?\b/.exec(t))) cm = Number(m[1]) * 100;
        }
        if (!(kg > 0 && kg < 500) || !(cm > 50 && cm < 260)) {
          return { ok: false, error: "Give weight and height, e.g. 70 kg 175 cm, or 154 lb 5'9." };
        }
        const h = cm / 100;
        const bmi = kg / (h * h);
        const who =
          bmi < 18.5 ? "underweight" : bmi < 25 ? "normal" : bmi < 30 ? "overweight" : "obese";
        const asia =
          bmi < 18.5
            ? "underweight"
            : bmi < 23
              ? "normal"
              : bmi < 25
                ? "overweight (at risk)"
                : "obese";
        const low = 18.5 * h * h;
        const high = 24.9 * h * h;
        return {
          ok: true,
          bmi: r1(bmi),
          whoCategory: who,
          asiaPacificCategory: asia,
          healthyRangeKg: [r1(low), r1(high)],
          answer: `BMI ${r1(bmi)}: ${who} by WHO bands (${asia} by the Asia-Pacific bands used for Indians). Healthy weight for ${r1(cm)} cm is ${r1(low)}-${r1(high)} kg. A screening number, not a diagnosis; muscle and age change what it means.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "calories",
    gate: /calori|bmr|tdee|metabolic|maintenance|macro/,
    run: (() => {
      // Calories: basal metabolic rate (Mifflin-St Jeor), daily needs by activity, and a simple protein target.
      const LEVELS = [
        ["sedentary", 1.2, /sedentary|desk|little exercise|no exercise/],
        ["light", 1.375, /light|1-3 days|lightly/],
        ["moderate", 1.55, /moderate|3-5 days|moderately/],
        ["active", 1.725, /very active|6-7 days|daily exercise|active/],
        ["extra", 1.9, /extra|athlete|twice a day|physical job/],
      ];

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const num = (re, key) =>
          input[key] != null ? Number(input[key]) : re.exec(t) ? Number(re.exec(t)[1]) : NaN;
        const kg = num(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo)/, "weightKg");
        const cm = num(/(\d+(?:\.\d+)?)\s*cm/, "heightCm");
        const age = num(/(\d{1,3})\s*(?:years?|yrs?|yo|y\/o|saal)|\bage\s*(\d{1,3})/, "age");
        const ageFix = Number.isFinite(age) ? age : Number((/\bage\s*(\d{1,3})/.exec(t) ?? [])[1]);
        const sex = input.sex
          ? String(input.sex).toLowerCase()
          : /\bfemale|woman|girl|\bf\b/.test(t)
            ? "female"
            : /\bmale|\bman\b|boy|\bm\b/.test(t)
              ? "male"
              : null;
        if (!(kg > 0 && cm > 0 && ageFix > 0) || !sex) {
          return {
            ok: false,
            error: "Give sex, age, weight and height, e.g. male 30 years 75 kg 175 cm moderate.",
          };
        }
        const bmr = 10 * kg + 6.25 * cm - 5 * ageFix + (sex === "male" ? 5 : -161);
        const level =
          LEVELS.slice()
            .reverse()
            .find((l) => l[2].test(t)) ?? LEVELS[0];
        const chosen = input.activity
          ? (LEVELS.find((l) => l[0] === input.activity) ?? level)
          : level;
        const tdee = bmr * chosen[1];
        const r = (n) => Math.round(n);
        return {
          ok: true,
          bmr: r(bmr),
          activity: chosen[0],
          maintenance: r(tdee),
          gentleCut: r(tdee - 400),
          gentleGain: r(tdee + 300),
          proteinGramsPerDay: [r(kg * 1.2), r(kg * 2)],
          answer: `Basal ${r(bmr)} kcal; with ${chosen[0]} activity you burn about ${r(tdee)} kcal a day. A gentle cut is ${r(tdee - 400)}, a gentle gain ${r(tdee + 300)}. Protein ${r(kg * 1.2)}-${r(kg * 2)} g a day. An estimate (+/-10%), not medical advice.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "hr-zones",
    gate: /heart rate|hr zone|max hr|zone 2|pulse|bpm/,
    run: (() => {
      // Heart-rate zones from age (Tanaka formula) or a measured maximum, with the Karvonen method when resting pulse is known.
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const age =
          input.age != null
            ? Number(input.age)
            : Number(
                (/(\d{1,3})\s*(?:years?|yrs?|yo|saal)|\bage\s*(\d{1,3})/.exec(t) ?? [])
                  .slice(1)
                  .find(Boolean),
              );
        const measured =
          input.maxHr != null
            ? Number(input.maxHr)
            : Number(
                (/max(?:imum)?\s*(?:hr|heart rate|pulse)?\s*(?:is|=|:)?\s*(\d{2,3})/.exec(t) ??
                  [])[1],
              );
        const resting =
          input.restingHr != null
            ? Number(input.restingHr)
            : Number(
                (/rest(?:ing)?\s*(?:hr|heart rate|pulse)?\s*(?:is|=|:)?\s*(\d{2,3})/.exec(t) ??
                  [])[1],
              );
        const max =
          measured > 100 ? measured : age > 5 && age < 100 ? Math.round(208 - 0.7 * age) : NaN;
        if (!Number.isFinite(max))
          return {
            ok: false,
            error: "Give an age (or a measured max heart rate), e.g. heart rate zones for age 35.",
          };
        const reserve = resting > 30 && resting < max ? max - resting : null;
        const names = [
          "Zone 1 recovery",
          "Zone 2 easy / fat burn",
          "Zone 3 aerobic",
          "Zone 4 threshold",
          "Zone 5 maximum",
        ];
        const edges = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
        const zones = names.map((name, i) => {
          const lo = reserve
            ? Math.round(resting + reserve * edges[i])
            : Math.round(max * edges[i]);
          const hi = reserve
            ? Math.round(resting + reserve * edges[i + 1])
            : Math.round(max * edges[i + 1]);
          return { zone: name, bpm: [lo, hi] };
        });
        return {
          ok: true,
          maxHeartRate: max,
          method: reserve
            ? "Karvonen (heart-rate reserve)"
            : measured > 100
              ? "measured maximum"
              : "Tanaka 208 - 0.7 x age",
          zones,
          answer: `Max ${max} bpm. ${zones.map((z) => `${z.zone}: ${z.bpm[0]}-${z.bpm[1]}`).join("; ")}. A guide; a fitness test or a doctor gives the real maximum.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "pace-calc",
    gate: /pace|running|\brun\b|race|marathon|\b5k\b|\b10k\b|splits|per km/,
    run: (() => {
      // Running pace: pace and speed from distance and time, time from pace, and race-time predictions (Riegel).
      const RACES = {
        "5k": 5,
        "10k": 10,
        half: 21.0975,
        "half marathon": 21.0975,
        marathon: 42.195,
        mile: 1.609344,
      };

      function parseTime(s) {
        const c = /(?:(\d+):)?(\d{1,2}):(\d{2})(?![\d:])/.exec(s);
        if (c) {
          const parts = /(\d+):(\d{1,2}):(\d{2})/.exec(s);
          if (parts) return Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
          return Number(c[2]) * 60 + Number(c[3]);
        }
        const h = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)/.exec(s);
        const m = /(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?)/.exec(s);
        const sec = /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)/.exec(s);
        if (h || m || sec)
          return (
            (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0)
          );
        return NaN;
      }
      const fmt = (sec) => {
        const s = Math.round(sec);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        return (
          (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(r).padStart(2, "0")}`
        );
      };

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        let km = NaN;
        let m;
        const race = Object.keys(RACES)
          .sort((a, b) => b.length - a.length)
          .find((k) => new RegExp(`\\b${k}\\b`).test(t));
        if ((m = /(\d+(?:\.\d+)?)\s*(km|kilomet\w+|k\b)/.exec(t))) km = Number(m[1]);
        else if ((m = /(\d+(?:\.\d+)?)\s*(?:mi|miles?)\b/.exec(t))) km = Number(m[1]) * 1.609344;
        else if (race) km = RACES[race];
        const seconds = parseTime(t.replace(/(\d+(?:\.\d+)?)\s*(?:km|miles?|mi)\b/g, " "));
        const target =
          /(?:predict|marathon|half marathon|10k|5k)\b.*\b(?:predict|for|at)\b|predict/.test(t)
            ? Object.keys(RACES)
                .sort((a, b) => b.length - a.length)
                .filter((k) => new RegExp(`(?:predict|for|at|run)\\s+(?:a\\s+)?${k}\\b`).test(t))[0]
            : null;
        if (!(km > 0) || !(seconds > 0)) {
          return {
            ok: false,
            error: "Give a distance and a time, e.g. 10 km in 55:30, or 5k 25:00 predict marathon.",
          };
        }
        const pace = seconds / km;
        const out = {
          ok: true,
          distanceKm: Math.round(km * 1000) / 1000,
          time: fmt(seconds),
          pacePerKm: fmt(pace),
          pacePerMile: fmt(pace * 1.609344),
          speedKmh: Math.round((km / (seconds / 3600)) * 100) / 100,
        };
        const predictions = {};
        for (const [name, d] of Object.entries(RACES)) {
          if (name === "half" || name === "mile") continue;
          predictions[name] = fmt(seconds * Math.pow(d / km, 1.06));
        }
        out.predictions = predictions;
        out.answer = `${out.distanceKm} km in ${out.time}: ${out.pacePerKm} per km (${out.pacePerMile} per mile), ${out.speedKmh} km/h.${
          target
            ? ` Predicted ${target}: ${predictions[target === "half" ? "half marathon" : target]}.`
            : ` Predicted: ${Object.entries(predictions)
                .map(([k, v]) => `${k} ${v}`)
                .join(", ")}.`
        }`;
        return out;
      }

      return run;
    })(),
  },
  {
    id: "water-intake",
    gate: /water intake|how much water|hydrat|drink.*water/,
    run: (() => {
      // Water intake: a daily guide from body weight, exercise and heat.
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const kg =
          input.weightKg != null
            ? Number(input.weightKg)
            : Number((/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo)/.exec(t) ?? [])[1]);
        if (!(kg > 20 && kg < 300))
          return {
            ok: false,
            error: "Give your weight, e.g. how much water should I drink at 70 kg.",
          };
        const exercise =
          Number(
            (/(\d+)\s*(?:min|minutes)\s*(?:of\s*)?(?:exercise|workout|run|gym|walk)/.exec(t) ??
              [])[1],
          ) || 0;
        const hot = /hot|summer|garmi|humid/.test(t);
        const litres = kg * 0.033 + (exercise / 30) * 0.35 + (hot ? 0.5 : 0);
        const r = Math.round(litres * 10) / 10;
        return {
          ok: true,
          litres: r,
          glasses250ml: Math.round(litres / 0.25),
          answer: `About ${r} litres a day (${Math.round(litres / 0.25)} glasses of 250 ml), including water from food and tea. Drink more in heat or when sweating; people with kidney or heart conditions should follow their doctor.`,
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
