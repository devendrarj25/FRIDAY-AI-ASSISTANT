// FRIDAY · skill: dat-extract-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Extract entities, compare lists, count frequency, key-value to JSON. Turns messy text into tidy data.
// It holds 4 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "extract-entities",
    gate: /extract|find all|list all|pull out|grab|emails? in|links? in|phone numbers/,
    run: (() => {
      // Extract: pulls emails, links, phone numbers, dates, amounts, hashtags, mentions and IP addresses out of messy text.
      const uniq = (a) => [...new Set(a)];

      async function run(input = {}) {
        const text = String(input.text ?? input?.prompt ?? "");
        if (text.trim().length < 5) return { ok: false, error: "Paste the text to extract from." };
        const found = {
          emails: uniq(text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []),
          links: uniq(
            (text.match(/\bhttps?:\/\/[^\s<>"')]+/g) ?? []).map((u) => u.replace(/[.,;:!?]+$/, "")),
          ),
          phones: uniq(
            (
              text.match(
                /(?:\+91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b|\+\d{1,3}[\s-]?\d{2,5}[\s-]?\d{3,5}[\s-]?\d{3,5}\b/g,
              ) ?? []
            ).map((p) => p.trim()),
          ),
          dates: uniq(
            text.match(
              /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s+\d{4}\b/gi,
            ) ?? [],
          ),
          amounts: uniq(
            text.match(
              /(?:₹|Rs\.?|INR|\$|USD|EUR|€|£)\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:lakh|crore|k|m|million|bn))?/gi,
            ) ?? [],
          ),
          hashtags: uniq(text.match(/(?<![\w&])#[\p{L}\p{N}_]+/gu) ?? []),
          mentions: uniq(text.match(/(?<![\w@])@[A-Za-z0-9_]{2,}\b(?!\.[a-z])/g) ?? []),
          ipAddresses: uniq(
            (text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []).filter((ip) =>
              ip.split(".").every((x) => Number(x) <= 255),
            ),
          ),
        };
        const total = Object.values(found).reduce((a, v) => a + v.length, 0);
        if (!total)
          return {
            ok: false,
            error:
              "Nothing to extract: no emails, links, phones, dates, amounts, hashtags, mentions or IPs found.",
          };
        return {
          ok: true,
          total,
          ...found,
          answer: Object.entries(found)
            .filter(([, v]) => v.length)
            .map(([k, v]) => `${k} (${v.length}): ${v.slice(0, 8).join(", ")}`)
            .join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "list-compare",
    gate: /compare.*lists?|difference between.*lists?|common (?:items|elements)|only in|intersection|union|diff of lists|\bvs\.?\b|versus/,
    run: (() => {
      // Compare two lists: what is only in the first, only in the second, in both, and the combined unique list.
      const clean = (v) =>
        (Array.isArray(v) ? v.map(String) : String(v).split(/\r?\n|,(?!\d{3})|;/))
          .map((x) => x.replace(/^[\s\-*•\d.)]+/, "").trim())
          .filter(Boolean);

      async function run(input = {}) {
        let a = input.a;
        let b = input.b;
        if (a == null || b == null) {
          const text = String(input.text ?? input?.prompt ?? "");
          const body = text.replace(/^[^\n]*?(?:compare|difference|common|lists?)[^\n]*?:\s*/i, "");
          const sep = /\n\s*(?:-{3,}|={3,}|vs\.?|versus)\s*\n|\s+(?:vs\.?|versus)\s+/i;
          const halves = body.split(sep);
          if (halves.length < 2)
            return { ok: false, error: "Give two lists separated by a line with --- (or 'vs')." };
          a = halves[0];
          b = halves[1];
        }
        const A = clean(a);
        const B = clean(b);
        if (!A.length || !B.length)
          return { ok: false, error: "Both lists need at least one item." };
        const key = (x) => x.toLowerCase();
        const sa = new Map(A.map((x) => [key(x), x]));
        const sb = new Map(B.map((x) => [key(x), x]));
        const onlyA = [...sa].filter(([k]) => !sb.has(k)).map(([, v]) => v);
        const onlyB = [...sb].filter(([k]) => !sa.has(k)).map(([, v]) => v);
        const both = [...sa].filter(([k]) => sb.has(k)).map(([, v]) => v);
        const union = [...new Map([...sa, ...sb])].map(([, v]) => v);
        return {
          ok: true,
          onlyInFirst: onlyA,
          onlyInSecond: onlyB,
          inBoth: both,
          union,
          duplicatesInFirst: A.length - sa.size,
          duplicatesInSecond: B.length - sb.size,
          answer: `Only in first (${onlyA.length}): ${onlyA.join(", ") || "none"}\nOnly in second (${onlyB.length}): ${onlyB.join(", ") || "none"}\nIn both (${both.length}): ${both.join(", ") || "none"}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "frequency",
    gate: /frequency|count (?:occurrences|each|how many times)|most common|histogram|tally|how often/,
    run: (() => {
      // Frequency: counts how often each word or line appears, most common first.
      async function run(input = {}) {
        let text = input.text != null ? String(input.text) : String(input?.prompt ?? "");
        const m = /^([^:\n]{0,70}):\s*([\s\S]+)$/.exec(text);
        if (
          input.text == null &&
          m &&
          /frequency|count|tally|most common|histogram|occurrences/i.test(m[1])
        )
          text = m[2];
        const byLine =
          input.by === "line" ||
          (input.by == null && /\bby line|each line|lines\b/i.test(String(input?.prompt ?? "")));
        const items = byLine
          ? text
              .split(/\r?\n/)
              .map((x) => x.trim())
              .filter(Boolean)
          : (text.toLowerCase().match(/[\p{L}\p{M}\p{N}'’]+/gu) ?? []);
        if (items.length < 2) return { ok: false, error: "Paste the text or list to count." };
        const map = new Map();
        for (const it of items) map.set(it, (map.get(it) ?? 0) + 1);
        const limit = Number(input.limit) || 10;
        const rows = [...map.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, limit)
          .map(([item, count]) => ({
            item,
            count,
            percent: Math.round((count / items.length) * 1000) / 10,
          }));
        return {
          ok: true,
          total: items.length,
          unique: map.size,
          top: rows,
          answer: `${items.length} ${byLine ? "lines" : "words"}, ${map.size} unique. Most common: ${rows.map((r) => `${r.item} x${r.count}`).join(", ")}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "kv-to-json",
    gate: /to json|key.?value|make json|into json|convert.*json/,
    run: (() => {
      // Key-value text to JSON: lines like name: Asha or port=8080 become an object (dotted keys nest, numbers and booleans are typed).
      const typed = (v) => {
        const s = v.trim().replace(/^(["'])(.*)\1$/, "$2");
        if (/^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v.trim());
        if (/^(true|yes)$/i.test(s)) return true;
        if (/^(false|no)$/i.test(s)) return false;
        if (/^(null|none)$/i.test(s)) return null;
        return s;
      };

      async function run(input = {}) {
        const lines = String(input.text ?? input?.prompt ?? "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#"));
        const out = {};
        let n = 0;
        for (const line of lines) {
          const m = /^([A-Za-z_][\w. -]{0,60}?)\s*[:=]\s*(.*)$/.exec(line);
          if (!m) continue;
          if (!m[2].trim()) continue;
          n++;
          const path = m[1].trim().split(".");
          let cur = out;
          path.slice(0, -1).forEach((k) => {
            if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
            cur = cur[k];
          });
          cur[path[path.length - 1]] = typed(m[2]);
        }
        if (n < 1) return { ok: false, error: "No key: value or key=value lines found." };
        const json = JSON.stringify(out, null, 2);
        return { ok: true, pairs: n, json: out, answer: json };
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
