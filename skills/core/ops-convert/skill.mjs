// FRIDAY · skill: ops-convert
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Convert units, data sizes, download time and number bases. One converter for every kind of number.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "ops-unit-convert",
    gate: null,
    run: (() => {
      // FRIDAY · skill: ops-unit-convert
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Convert length, weight, volume, area, speed and temperature, e.g. "5 km to miles" or "100 f in c".

      // key: [dimension, factor to the base unit, aliases without spaces]
      const UNITS = {
        mm: ["length", 0.001, ["mm", "millimeter", "millimetre"]],
        cm: ["length", 0.01, ["cm", "centimeter", "centimetre"]],
        m: ["length", 1, ["m", "meter", "metre"]],
        km: ["length", 1000, ["km", "kilometer", "kilometre"]],
        in: ["length", 0.0254, ["in", "inch", "inche", "inches"]],
        ft: ["length", 0.3048, ["ft", "foot", "feet"]],
        yd: ["length", 0.9144, ["yd", "yard"]],
        mi: ["length", 1609.344, ["mi", "mile"]],
        mg: ["mass", 0.000001, ["mg", "milligram"]],
        g: ["mass", 0.001, ["g", "gram", "gm"]],
        kg: ["mass", 1, ["kg", "kilogram", "kilo"]],
        quintal: ["mass", 100, ["quintal"]],
        tonne: ["mass", 1000, ["tonne", "ton", "metricton"]],
        lb: ["mass", 0.45359237, ["lb", "lbs", "pound"]],
        oz: ["mass", 0.028349523125, ["oz", "ounce"]],
        ml: ["volume", 0.001, ["ml", "milliliter", "millilitre"]],
        l: ["volume", 1, ["l", "liter", "litre", "ltr"]],
        gal: ["volume", 3.785411784, ["gal", "gallon"]],
        qt: ["volume", 0.946352946, ["qt", "quart"]],
        cup: ["volume", 0.2365882365, ["cup"]],
        floz: ["volume", 0.0295735295625, ["floz", "fluidounce"]],
        tbsp: ["volume", 0.01478676478125, ["tbsp", "tablespoon"]],
        tsp: ["volume", 0.00492892159375, ["tsp", "teaspoon"]],
        sqm: ["area", 1, ["sqm", "squaremeter", "squaremetre", "m2", "m²"]],
        sqft: ["area", 0.09290304, ["sqft", "squarefeet", "squarefoot", "ft2", "ft²"]],
        sqyd: ["area", 0.83612736, ["sqyd", "squareyard"]],
        sqkm: ["area", 1000000, ["sqkm", "squarekilometer", "squarekilometre", "km2", "km²"]],
        acre: ["area", 4046.8564224, ["acre"]],
        hectare: ["area", 10000, ["hectare", "ha"]],
        ms: ["speed", 1, ["m/s", "mps", "meterpersecond"]],
        kmh: ["speed", 1 / 3.6, ["km/h", "kmh", "kmph", "kph", "kilometerperhour"]],
        mph: ["speed", 0.44704, ["mph", "mileperhour"]],
        knot: ["speed", 1852 / 3600, ["knot", "kt"]],
        c: ["temp", 0, ["c", "°c", "celsius", "centigrade"]],
        f: ["temp", 0, ["f", "°f", "fahrenheit"]],
        k: ["temp", 0, ["k", "kelvin"]],
      };
      const ALIAS = {};
      for (const [key, [, , names]] of Object.entries(UNITS)) for (const n of names) ALIAS[n] = key;

      function resolve(words) {
        const parts = words.trim().toLowerCase().replace(/\./g, "").split(/\s+/);
        for (let n = Math.min(3, parts.length); n >= 1; n--) {
          const k = parts.slice(0, n).join("");
          if (ALIAS[k]) return ALIAS[k];
          if (ALIAS[k.replace(/s$/, "")]) return ALIAS[k.replace(/s$/, "")];
        }
        return null;
      }

      const toCelsius = (v, u) => (u === "c" ? v : u === "f" ? ((v - 32) * 5) / 9 : v - 273.15);
      const fromCelsius = (v, u) => (u === "c" ? v : u === "f" ? (v * 9) / 5 + 32 : v + 273.15);
      const fmt = (n) => Number(n.toPrecision(8));

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const m =
          /(-?\d+(?:\.\d+)?)\s*([a-z°²/]+(?:\s[a-z°²/]+){0,2}?)\s+(?:to|in|into|se|mein)\s+([a-z°²/]+(?:\s[a-z°²/]+){0,2})/.exec(
            text,
          );
        const value = input.value != null ? Number(input.value) : m ? Number(m[1]) : NaN;
        const from = input.from ? resolve(String(input.from)) : m ? resolve(m[2]) : null;
        const to = input.to ? resolve(String(input.to)) : m ? resolve(m[3]) : null;
        if (!Number.isFinite(value) || !from || !to) {
          return { ok: false, error: "Say it like 5 km to miles, 70 kg to lb or 100 f to c." };
        }
        const [dimA, fa] = UNITS[from];
        const [dimB, fb] = UNITS[to];
        if (dimA !== dimB) return { ok: false, error: `Cannot convert ${dimA} to ${dimB}.` };
        const result =
          dimA === "temp" ? fromCelsius(toCelsius(value, from), to) : (value * fa) / fb;
        const out = fmt(result);
        return {
          ok: true,
          dimension: dimA,
          from,
          to,
          value,
          result: out,
          answer: `${value} ${from} = ${out} ${to}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-size-convert",
    gate: null,
    run: (() => {
      // FRIDAY · skill: ops-size-convert
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Convert data sizes between bytes, KB/MB/GB/TB (1000s) and KiB/MiB/GiB/TiB (1024s), and explain what Windows shows.

      const U = {
        b: 1,
        byte: 1,
        kb: 1e3,
        mb: 1e6,
        gb: 1e9,
        tb: 1e12,
        pb: 1e15,
        kib: 1024,
        mib: 1024 ** 2,
        gib: 1024 ** 3,
        tib: 1024 ** 4,
        pib: 1024 ** 5,
      };
      const norm = (u) => {
        const k = u.toLowerCase().replace(/s$/, "");
        return k === "bytes" ? "b" : k;
      };
      const fmt = (n) => Number(n.toPrecision(7));
      const label = (k) =>
        k.endsWith("ib") ? k[0].toUpperCase() + "iB" : k === "b" ? "bytes" : k.toUpperCase();
      const SHOW = ["kb", "mb", "gb", "tb", "kib", "mib", "gib", "tib"];

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? "")
          .toLowerCase()
          .replace(/(\d),(?=\d{3}\b)/g, "$1");
        const m = /(\d+(?:\.\d+)?)\s*(bytes?|b|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib)\b/.exec(text);
        const value = input.value != null ? Number(input.value) : m ? Number(m[1]) : NaN;
        const unit = norm(String(input.unit ?? (m ? m[2] : "")));
        if (!Number.isFinite(value) || !(unit in U)) {
          return { ok: false, error: "Give a size such as 1.5 GB, 2048 KiB or 700 MB." };
        }
        const bytes = value * U[unit];
        const table = Object.fromEntries(
          SHOW.map((k) => [k.toUpperCase().replace("IB", "iB"), fmt(bytes / U[k])]),
        );
        const to = /(?:to|in|into)\s+(bytes?|kb|mb|gb|tb|pb|kib|mib|gib|tib|pib)\b/.exec(text);
        const target = to ? norm(to[1]) : null;
        const windows = unit === "gb" || unit === "gib" || unit === "tb" || unit === "mb";
        const note =
          "Drive makers sell in 1000s (GB); Windows File Explorer divides by 1024 and still writes GB, so a 500 GB drive shows about 465 GB.";
        return {
          ok: true,
          bytes: fmt(bytes),
          table,
          answer: target
            ? `${value} ${label(unit)} = ${fmt(bytes / U[target])} ${label(target)}.${windows ? ` ${note}` : ""}`
            : `${value} ${label(unit)} = ${fmt(bytes)} bytes = ${table.GB} GB = ${table.GiB} GiB.${windows ? ` ${note}` : ""}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-download-time",
    gate: null,
    run: (() => {
      // FRIDAY · skill: ops-download-time
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // How long a download takes for a size and a line speed, or the speed needed to finish in a given time.

      const SIZE = {
        b: 1,
        kb: 1e3,
        mb: 1e6,
        gb: 1e9,
        tb: 1e12,
        kib: 1024,
        mib: 1024 ** 2,
        gib: 1024 ** 3,
        tib: 1024 ** 4,
      };
      // Speeds in bits per second (network "Mbps") or bytes per second ("MB/s").
      const BITS = { bps: 1, kbps: 1e3, mbps: 1e6, gbps: 1e9 };
      const BYTES = { "kb/s": 1e3, "mb/s": 1e6, "gb/s": 1e9, kbps_bytes: 1e3 };

      const bytesFromText = (text) => {
        const m = text
          .toLowerCase()
          .match(/(\d+(?:[.,]\d+)?)\s*(kib|mib|gib|tib|kb|mb|gb|tb|b)\b(?!\s*\/s|ps)/);
        return m ? Number(m[1].replace(",", ".")) * SIZE[m[2]] : NaN;
      };
      const bytesPerSecondFromText = (text) => {
        const t = text.toLowerCase();
        const bits = t.match(/(\d+(?:[.,]\d+)?)\s*(gbps|mbps|kbps|bps)\b/);
        if (bits) return (Number(bits[1].replace(",", ".")) * BITS[bits[2]]) / 8;
        const bytes = t.match(/(\d+(?:[.,]\d+)?)\s*(gb\/s|mb\/s|kb\/s)/);
        if (bytes) return Number(bytes[1].replace(",", ".")) * BYTES[bytes[2]];
        return NaN;
      };
      const secondsFromText = (text) => {
        let total = 0;
        let any = false;
        for (const m of text
          .toLowerCase()
          .matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g)) {
          const unit = m[2][0];
          total += Number(m[1]) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
          any = true;
        }
        return any ? total : NaN;
      };

      function human(seconds) {
        const s = Math.round(seconds);
        if (s < 60) return `${s} s`;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        return [h ? `${h} h` : "", m ? `${m} min` : "", !h && r ? `${r} s` : ""]
          .filter(Boolean)
          .join(" ");
      }
      const size = (bytes) =>
        bytes >= 1e9
          ? `${(bytes / 1e9).toFixed(2)} GB`
          : bytes >= 1e6
            ? `${(bytes / 1e6).toFixed(1)} MB`
            : `${Math.round(bytes / 1e3)} KB`;

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? "");
        const bytes = Number.isFinite(Number(input?.bytes))
          ? Number(input.bytes)
          : bytesFromText(String(input?.size ?? text));
        const speed = bytesPerSecondFromText(String(input?.speed ?? text));
        const secondsGiven = Number.isFinite(Number(input?.seconds))
          ? Number(input.seconds)
          : secondsFromText(
              String(
                input?.time ??
                  text.replace(
                    /\d+(?:[.,]\d+)?\s*(?:kib|mib|gib|tib|kb|mb|gb|tb|gbps|mbps|kbps|bps)\b(?:\/s)?/gi,
                    " ",
                  ),
              ),
            );
        const efficiency = Math.min(1, Math.max(0.1, Number(input?.efficiency ?? 0.85)));
        if (Number.isFinite(bytes) && Number.isFinite(speed)) {
          const ideal = bytes / speed;
          const real = ideal / efficiency;
          return {
            ok: true,
            answer: `${size(bytes)} at ${((speed * 8) / 1e6).toFixed(1)} Mbps takes about ${human(real)} in practice (${human(ideal)} at full line speed).`,
            sizeBytes: bytes,
            lineSpeedMbps: Number(((speed * 8) / 1e6).toFixed(3)),
            fullSpeedSeconds: Math.round(ideal),
            realisticSeconds: Math.round(real),
            assumption: `Realistic time assumes ${Math.round(efficiency * 100)}% of the line speed (protocol overhead, server speed, Wi-Fi). Mbps is megabits: divide by 8 for megabytes per second.`,
          };
        }
        if (Number.isFinite(bytes) && Number.isFinite(secondsGiven)) {
          const needed = (bytes / secondsGiven) * 8;
          const withOverhead = needed / efficiency;
          return {
            ok: true,
            answer: `To get ${size(bytes)} in ${human(secondsGiven)} you need about ${(withOverhead / 1e6).toFixed(1)} Mbps of real line speed (${(needed / 1e6).toFixed(1)} Mbps at 100% efficiency).`,
            requiredMbps: Number((withOverhead / 1e6).toFixed(2)),
            requiredMbpsAtFullEfficiency: Number((needed / 1e6).toFixed(2)),
          };
        }
        if (Number.isFinite(speed) && Number.isFinite(secondsGiven)) {
          const got = speed * secondsGiven * efficiency;
          return {
            ok: true,
            answer: `In ${human(secondsGiven)} at ${((speed * 8) / 1e6).toFixed(1)} Mbps you download about ${size(got)}.`,
            downloadedBytes: Math.round(got),
          };
        }
        return {
          ok: false,
          error:
            "Give two of: a size (4.2 GB), a speed (20 Mbps or 5 MB/s) and a time (30 minutes). For example: how long does 4.2 GB take at 20 Mbps.",
        };
      }

      return run;
    })(),
  },
  {
    id: "dev-base-convert",
    gate: /\b(binary|hex|hexadecimal|octal|decimal|base|bin)\b|0x|0b/,
    run: (() => {
      // FRIDAY · skill: dev-base-convert
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Convert whole numbers between decimal, hexadecimal, binary and octal (any size), with 0x, 0b and 0o prefixes.

      const BASES = {
        binary: 2,
        bin: 2,
        octal: 8,
        oct: 8,
        decimal: 10,
        dec: 10,
        hexadecimal: 16,
        hex: 16,
      };
      const WORDS = "binary|bin|octal|oct|decimal|dec|hexadecimal|hex";
      const DIGITS = "0123456789abcdef";

      function parse(digits, base) {
        let n = 0n;
        const b = BigInt(base);
        for (const ch of digits.toLowerCase()) {
          const d = DIGITS.indexOf(ch);
          if (d < 0 || d >= base) return null;
          n = n * b + BigInt(d);
        }
        return n;
      }

      async function run(input = {}) {
        const text = String(input?.prompt ?? input?.text ?? input?.value ?? "").toLowerCase();
        let digits = null;
        let base = 10;
        let m;
        if (input.value != null && input.base != null) {
          digits = String(input.value).replace(/^0[xbo]/i, "");
          base = Number(input.base);
        } else if ((m = /\b0x([0-9a-f]+)\b/.exec(text))) {
          [digits, base] = [m[1], 16];
        } else if ((m = /\b0b([01]+)\b/.exec(text))) {
          [digits, base] = [m[1], 2];
        } else if ((m = /\b0o([0-7]+)\b/.exec(text))) {
          [digits, base] = [m[1], 8];
        } else if (
          (m = new RegExp(`\\b([0-9a-f]+)\\s*(${WORDS})\\b`).exec(text)) &&
          parse(m[1], BASES[m[2]]) !== null
        ) {
          [digits, base] = [m[1], BASES[m[2]]];
        } else if (
          (m = new RegExp(`\\bfrom\\s+(${WORDS})\\s+([0-9a-f]+)\\b`).exec(text)) &&
          parse(m[2], BASES[m[1]]) !== null
        ) {
          [digits, base] = [m[2], BASES[m[1]]];
        } else if ((m = /\b(\d+)\b/.exec(text))) {
          digits = m[1];
        }
        const n = digits == null ? null : parse(digits, base);
        if (n === null || !Number.isInteger(base) || base < 2 || base > 16) {
          return {
            ok: false,
            error: "Give a whole number, e.g. 255 to binary, 0xFF, or 1010 binary to decimal.",
          };
        }
        const dec = n.toString(10);
        const hex = n.toString(16);
        const bin = n.toString(2);
        const oct = n.toString(8);
        const code = n <= 126n && n >= 32n ? String.fromCharCode(Number(n)) : null;
        const want = new RegExp(`\\b(?:to|in|into)\\s+(${WORDS})\\b`).exec(text);
        const target = want ? BASES[want[1]] : null;
        const pick = { 2: bin, 8: oct, 10: dec, 16: hex }[target];
        return {
          ok: true,
          decimal: dec,
          hex,
          binary: bin,
          octal: oct,
          bits: bin === "0" ? 1 : bin.length,
          character: code,
          answer: pick
            ? `${digits} (base ${base}) = ${pick} (base ${target}).`
            : `${digits} (base ${base}) = ${dec} decimal = 0x${hex} = 0b${bin} = 0o${oct}.`,
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
