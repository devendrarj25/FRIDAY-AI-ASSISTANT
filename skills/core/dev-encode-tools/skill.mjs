// FRIDAY · skill: dev-encode-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Base64, URL, HTML, hex encoding, Roman numerals and number words. Encoders and numeral systems in both directions.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "encode-text",
    gate: /encode|decode|escape|unescape|percent|entities|base64|\bhex\b/,
    run: (() => {
      // Encode text: URL (percent) escapes, HTML entities, Base64, hex and \u escapes, both directions.
      const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const utf8 = (s) => {
        const out = [];
        const enc = encodeURIComponent(s);
        for (let i = 0; i < enc.length; i++) {
          if (enc[i] === "%") {
            out.push(parseInt(enc.slice(i + 1, i + 3), 16));
            i += 2;
          } else out.push(enc.charCodeAt(i));
        }
        return out;
      };
      const fromUtf8 = (bytes) =>
        decodeURIComponent(bytes.map((b) => "%" + b.toString(16).padStart(2, "0")).join(""));
      function toB64(bytes) {
        let o = "";
        for (let i = 0; i < bytes.length; i += 3) {
          const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
          const n = (a << 16) | (b << 8) | c;
          o +=
            B64[(n >> 18) & 63] +
            B64[(n >> 12) & 63] +
            (i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=") +
            (i + 2 < bytes.length ? B64[n & 63] : "=");
        }
        return o;
      }
      function fromB64(s) {
        const clean = s.replace(/[\s=]/g, "").replace(/-/g, "+").replace(/_/g, "/");
        if (/[^A-Za-z0-9+/]/.test(clean)) throw new Error("Not valid Base64.");
        const bytes = [];
        let buf = 0;
        let bits = 0;
        for (const ch of clean) {
          buf = (buf << 6) | B64.indexOf(ch);
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            bytes.push((buf >> bits) & 255);
          }
        }
        return bytes;
      }
      const ENT = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

      async function run(input = {}) {
        const prompt = String(input?.prompt ?? input?.text ?? "");
        const kind = String(
          input.kind ??
            (/\bbase64\b|\bb64\b/i.test(prompt)
              ? "base64"
              : /\bhtml\b|entit/i.test(prompt)
                ? "html"
                : /\burl\b|percent/i.test(prompt)
                  ? "url"
                  : /\bhex\b/i.test(prompt)
                    ? "hex"
                    : /unicode|\\u/i.test(prompt)
                      ? "unicode"
                      : ""),
        ).toLowerCase();
        const dir = String(
          input.direction ??
            (/\bdecode|unescape|decod/i.test(prompt)
              ? "decode"
              : /\bencode|escape\b|encod/i.test(prompt)
                ? "encode"
                : ""),
        ).toLowerCase();
        if (!kind || !dir)
          return {
            ok: false,
            error: "Say what to do, e.g. encode base64: hello, or url decode: a%20b.",
          };
        const body =
          input.value != null ? String(input.value) : (/[:]\s*([\s\S]+)$/.exec(prompt)?.[1] ?? "");
        if (!body.trim()) return { ok: false, error: "Add the text after a colon." };
        const src = body.replace(/^\s+|\s+$/g, "");
        try {
          let result;
          if (kind === "base64")
            result = dir === "encode" ? toB64(utf8(src)) : fromUtf8(fromB64(src));
          else if (kind === "url")
            result =
              dir === "encode"
                ? encodeURIComponent(src)
                : decodeURIComponent(src.replace(/\+/g, " "));
          else if (kind === "html") {
            result =
              dir === "encode"
                ? src.replace(/[&<>"']/g, (c) => ENT[c])
                : src.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);|&#(\d+);/g, (_, n, d) =>
                    d
                      ? String.fromCodePoint(Number(d))
                      : { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " }[
                          n
                        ],
                  );
          } else if (kind === "hex") {
            result =
              dir === "encode"
                ? utf8(src)
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("")
                : fromUtf8(
                    (src.replace(/[^0-9a-f]/gi, "").match(/../g) ?? []).map((h) => parseInt(h, 16)),
                  );
          } else if (kind === "unicode") {
            result =
              dir === "encode"
                ? [...src]
                    .map((c) =>
                      c.codePointAt(0) > 127
                        ? "\\u" + c.codePointAt(0).toString(16).padStart(4, "0")
                        : c,
                    )
                    .join("")
                : src.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
          } else
            return {
              ok: false,
              error: `Unknown kind "${kind}". Use base64, url, html, hex or unicode.`,
            };
          return { ok: true, kind, direction: dir, result, answer: result };
        } catch (error) {
          return {
            ok: false,
            error: `Could not ${dir} that as ${kind}: ${String(error?.message ?? error)}`,
          };
        }
      }

      return run;
    })(),
  },
  {
    id: "roman-numeral",
    gate: /roman/,
    run: (() => {
      // Roman numerals: whole numbers 1 to 3999 to Roman numerals and back.
      const MAP = [
        [1000, "M"],
        [900, "CM"],
        [500, "D"],
        [400, "CD"],
        [100, "C"],
        [90, "XC"],
        [50, "L"],
        [40, "XL"],
        [10, "X"],
        [9, "IX"],
        [5, "V"],
        [4, "IV"],
        [1, "I"],
      ];

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "");
        const roman =
          /\b(?=[MDCLXVI]{1,15}\b)M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})\b/.exec(
            t.toUpperCase().replace(/[^A-Z\s]/g, " "),
          );
        const asNumber = /(\d{1,4})/.exec(t);
        if (/to roman|as roman|in roman|roman (?:numeral )?for/i.test(t) && asNumber) {
          let n = Number(asNumber[1]);
          if (n < 1 || n > 3999) return { ok: false, error: "Roman numerals cover 1 to 3999." };
          let s = "";
          for (const [v, r] of MAP)
            while (n >= v) {
              s += r;
              n -= v;
            }
          return {
            ok: true,
            number: Number(asNumber[1]),
            roman: s,
            answer: `${asNumber[1]} = ${s}`,
          };
        }
        if (roman && roman[0] && /roman|numeral/i.test(t)) {
          const s = roman[0];
          let n = 0;
          for (let i = 0; i < s.length; i++) {
            const cur =
              MAP.find(([, r]) => r === s[i])?.[0] ??
              { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 }[s[i]];
            const next = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 }[s[i + 1]] ?? 0;
            n += cur < next ? -cur : cur;
          }
          return { ok: true, roman: s, number: n, answer: `${s} = ${n}` };
        }
        return {
          ok: false,
          error: "Say it like 2026 to roman, or what is XLII in roman numerals.",
        };
      }

      return run;
    })(),
  },
  {
    id: "number-words",
    gate: /english words|in words|spell|number to words|words to number|ordinal|written as|to (?:a )?number|to digits|in digits|\b(?:hundred|thousand|million)\b/,
    run: (() => {
      // English number words: 1234 to "one thousand two hundred thirty-four", ordinals, and words back to a number.
      const ONES = [
        "zero",
        "one",
        "two",
        "three",
        "four",
        "five",
        "six",
        "seven",
        "eight",
        "nine",
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
      ];
      const TENS = [
        "",
        "",
        "twenty",
        "thirty",
        "forty",
        "fifty",
        "sixty",
        "seventy",
        "eighty",
        "ninety",
      ];
      const SCALES = [
        [1000000000000n, "trillion"],
        [1000000000n, "billion"],
        [1000000n, "million"],
        [1000n, "thousand"],
      ];

      function below1000(n) {
        const parts = [];
        if (n >= 100) {
          parts.push(ONES[Math.floor(n / 100)] + " hundred");
          n %= 100;
        }
        if (n >= 20) {
          parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : ""));
        } else if (n > 0 || !parts.length) parts.push(ONES[n]);
        return parts.join(" ");
      }
      function words(n) {
        if (n === 0n) return "zero";
        const neg = n < 0n;
        if (neg) n = -n;
        const out = [];
        for (const [v, name] of SCALES) {
          if (n >= v) {
            out.push(below1000(Number(n / v)) + " " + name);
            n %= v;
          }
        }
        if (n > 0n) out.push(below1000(Number(n)));
        return (neg ? "minus " : "") + out.join(" ");
      }
      const ordinal = (w) =>
        w
          .replace(
            /(one|two|three|five|eight|nine|twelve|y)$/,
            (m) =>
              ({
                one: "first",
                two: "second",
                three: "third",
                five: "fifth",
                eight: "eighth",
                nine: "ninth",
                twelve: "twelfth",
                y: "ieth",
              })[m],
          )
          .replace(/(?<!th|st|nd|rd)$/, (m, off, s) =>
            /(first|second|third|fifth|eighth|ninth|twelfth|ieth)$/.test(s) ? "" : "th",
          );

      async function run(input = {}) {
        const t = String(input?.prompt ?? input?.text ?? "").toLowerCase();
        const digits = /(-?\d[\d,]*)/.exec(t);
        if (digits && !/words? to (?:a )?number|to digits/.test(t)) {
          const n = BigInt(digits[1].replace(/,/g, ""));
          if (n > 999999999999999n || n < -999999999999999n)
            return { ok: false, error: "Numbers up to 999 trillion." };
          const w = words(n);
          return { ok: true, words: w, ordinal: ordinal(w), answer: `${digits[1]} = ${w}` };
        }
        const tokens =
          t
            .replace(/-/g, " ")
            .replace(/\band\b/g, " ")
            .match(/[a-z]+/g) ?? [];
        const small = Object.fromEntries(ONES.map((w, i) => [w, i]));
        TENS.forEach((w, i) => w && (small[w] = i * 10));
        let total = 0;
        let cur = 0;
        let any = false;
        for (const w of tokens) {
          if (w in small) {
            cur += small[w];
            any = true;
          } else if (w === "hundred") {
            cur *= 100;
            any = true;
          } else {
            const sc = SCALES.find(([, name]) => name === w);
            if (sc) {
              total += cur * Number(sc[0]);
              cur = 0;
              any = true;
            }
          }
        }
        if (!any)
          return {
            ok: false,
            error: "Give a number (1234) or number words (twenty one thousand).",
          };
        return { ok: true, number: total + cur, answer: `${total + cur}` };
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
