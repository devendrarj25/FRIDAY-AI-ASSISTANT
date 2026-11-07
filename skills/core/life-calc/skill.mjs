// FRIDAY · skill: life-calc
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Fuel and trip cost, electricity cost of appliances. Everyday running costs worked out exactly.
// It holds 2 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "fuel-trip",
    gate: /fuel|petrol|diesel|cng|mileage|kmpl|trip cost|road trip|toll/,
    run: (() => {
      // Trip cost: fuel needed and its price for a distance, split between travellers, with tolls.
      const r2 = (n) => Math.round(n * 100) / 100;
      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b|,/g, " ");
        const get = (key, re) =>
          input[key] != null ? Number(input[key]) : Number((re.exec(t) ?? [])[1]);
        const km = get("km", /(\d+(?:\.\d+)?)\s*(?:km|kms|kilomet\w+)(?!\s*\/\s*h|ph)/);
        const mileage =
          get(
            "mileage",
            /(\d+(?:\.\d+)?)\s*(?:kmpl|km\s*\/\s*l|km per l\w*|mileage)|mileage\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/,
          ) || Number((/mileage\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/.exec(t) ?? [])[1]);
        const price =
          get(
            "price",
            /(?:petrol|diesel|fuel|cng)?\s*(?:price|rate|at)?\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*l|per l\w*|a litre|\/litre)/,
          ) || Number((/(?:petrol|diesel|fuel|price)\D{0,12}(\d+(?:\.\d+)?)/.exec(t) ?? [])[1]);
        const people = get("people", /(\d+)\s*(?:people|persons?|friends|passengers|members)/) || 1;
        const tolls = get("tolls", /tolls?\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/) || 0;
        const roundTrip = /round.?trip|return|both ways|up and down/.test(t) || input.roundTrip;
        if (![km, mileage, price].every((x) => Number.isFinite(x) && x > 0)) {
          return {
            ok: false,
            error:
              "Give distance, mileage and fuel price, e.g. 450 km, mileage 15 kmpl, petrol 105 per litre, 4 people.",
          };
        }
        const dist = km * (roundTrip ? 2 : 1);
        const litres = dist / mileage;
        const fuel = litres * price;
        const total = fuel + tolls;
        return {
          ok: true,
          distanceKm: dist,
          litres: r2(litres),
          fuelCost: r2(fuel),
          tolls,
          totalCost: r2(total),
          perPerson: r2(total / people),
          costPerKm: r2(total / dist),
          answer: `${dist} km${roundTrip ? " (round trip)" : ""} at ${mileage} km/l needs ${r2(litres)} litres: ${tolls ? `fuel ${r2(fuel)} + tolls ${tolls} = ` : ""}${r2(total)}; ${r2(total / people)} each for ${people}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "power-cost",
    gate: /electricity|power cost|kwh|watts?|units? consumed|energy cost|bijli|light bill|\bac\b|\bfan\b|geyser|heater|fridge|tariff|per unit|appliance/,
    run: (() => {
      // Electricity cost: units (kWh) and rupees for an appliance by its power rating or a typical wattage.
      const TYPICAL = {
        "led bulb": 9,
        bulb: 9,
        fan: 75,
        "ceiling fan": 75,
        "tube light": 36,
        tv: 100,
        television: 100,
        laptop: 60,
        desktop: 200,
        computer: 200,
        router: 10,
        fridge: 150,
        refrigerator: 150,
        "washing machine": 500,
        iron: 1000,
        geyser: 2000,
        "water heater": 2000,
        microwave: 1200,
        mixer: 500,
        "air conditioner": 1500,
        ac: 1500,
        "1.5 ton ac": 1500,
        "1 ton ac": 1100,
        "2 ton ac": 2000,
        cooler: 200,
        "water pump": 750,
        motor: 750,
        heater: 1500,
        charger: 10,
      };
      const r2 = (n) => Math.round(n * 100) / 100;

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/₹|\brs\b\.?|\binr\b|,/g, " ");
        let watts =
          input.watts != null
            ? Number(input.watts)
            : Number((/(\d+(?:\.\d+)?)\s*(?:w|watts?)\b/.exec(t) ?? [])[1]);
        const kw = Number((/(\d+(?:\.\d+)?)\s*kw\b/.exec(t) ?? [])[1]);
        let name = null;
        if (!(watts > 0) && kw > 0) watts = kw * 1000;
        if (!(watts > 0)) {
          name =
            Object.keys(TYPICAL)
              .sort((a, b) => b.length - a.length)
              .find((k) => new RegExp(`\\b${k.replace(/\./g, "\\.")}\\b`).test(t)) ?? null;
          if (name) watts = TYPICAL[name];
        }
        const hours =
          input.hoursPerDay != null
            ? Number(input.hoursPerDay)
            : Number((/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/.exec(t) ?? [])[1]);
        const rate =
          input.rate != null
            ? Number(input.rate)
            : Number(
                (/(?:rate|tariff|at|price)?\s*(\d+(?:\.\d+)?)\s*(?:\/\s*unit|per unit|a unit|\/kwh|per kwh)/.exec(
                  t,
                ) ?? [])[1],
              ) ||
              Number((/(?:rate|tariff)\s*(?:of|is|=|:)?\s*(\d+(?:\.\d+)?)/.exec(t) ?? [])[1]) ||
              8;
        const days =
          input.days != null
            ? Number(input.days)
            : Number((/(\d+)\s*days?/.exec(t) ?? [])[1]) || (/month/.test(t) ? 30 : 1);
        if (!(watts > 0) || !(hours > 0))
          return {
            ok: false,
            error:
              "Give an appliance or its watts and the hours per day, e.g. 1.5 ton AC 8 hours, rate 8 per unit, 30 days.",
          };
        const units = (watts / 1000) * hours * days;
        return {
          ok: true,
          watts,
          assumedTypicalWatts: Boolean(name),
          kwh: r2(units),
          cost: r2(units * rate),
          ratePerUnit: rate,
          days,
          answer: `${name ? `A typical ${name} draws about ${watts} W. ` : ""}${watts} W for ${hours} h x ${days} day(s) = ${r2(units)} units (kWh), about ${r2(units * rate)} at ${rate} per unit${/per unit|tariff|rate/.test(t) ? "" : " (rate assumed; give yours)"}.`,
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
