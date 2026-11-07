// FRIDAY · skill: dat-table-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Profile and convert CSV tables and compute statistics. Tables and numbers: profile, convert and summarise.
// It holds 3 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "dat-csv-profile",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dat-csv-profile
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Profiles pasted CSV or TSV: delimiter, columns, types, blanks, unique values, number ranges and damaged rows.

      function parseCsv(text, delimiter) {
        const rows = [];
        let row = [];
        let cell = "";
        let quoted = false;
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i];
          if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
              cell += '"';
              i += 1;
            } else if (ch === '"') quoted = false;
            else cell += ch;
          } else if (ch === '"' && cell === "") quoted = true;
          else if (ch === delimiter) {
            row.push(cell);
            cell = "";
          } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
          } else cell += ch;
        }
        if (cell !== "" || row.length) {
          row.push(cell);
          rows.push(row);
        }
        return {
          rows: rows.filter((r) => !(r.length === 1 && r[0] === "")),
          unclosedQuote: quoted,
        };
      }

      function detectDelimiter(text) {
        const sample = text.split(/\r?\n/).slice(0, 20).filter(Boolean);
        let best = ",";
        let bestScore = -1;
        for (const d of [",", ";", "\t", "|"]) {
          const counts = sample.map((l) => l.split(d).length - 1);
          const first = counts[0] ?? 0;
          const consistent = counts.filter((c) => c === first).length;
          const score = first > 0 ? consistent * 10 + first : 0;
          if (score > bestScore) {
            bestScore = score;
            best = d;
          }
        }
        return best;
      }

      const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
      const DMY = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;
      function kindOf(value) {
        const v = value.trim();
        if (/^[+-]?\d+$/.test(v)) return "integer";
        if (/^[+-]?(?:\d+\.\d*|\.\d+|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(v)) return "decimal";
        if (/^(?:true|false|yes|no|y|n)$/i.test(v)) return "boolean";
        if (ISO.test(v) || DMY.test(v)) return "date";
        return "text";
      }

      async function run(input = {}) {
        const text = String(input?.csv ?? input?.text ?? input?.prompt ?? "").replace(
          /^\ufeff/,
          "",
        );
        if (!text.trim())
          return { ok: false, error: "Paste the CSV or TSV text, with the header line first." };
        const delimiter = input?.delimiter
          ? String(input.delimiter).replace("\\t", "\t")
          : detectDelimiter(text);
        const { rows, unclosedQuote } = parseCsv(text, delimiter);
        if (rows.length < 2)
          return { ok: false, error: "Need a header line and at least one data row." };
        const header = rows[0].map((h, i) => (h.trim() === "" ? `column ${i + 1}` : h.trim()));
        const data = rows.slice(1);
        const width = header.length;
        const bad = [];
        data.forEach((r, i) => {
          if (r.length !== width) bad.push({ row: i + 2, fields: r.length });
        });
        const seen = new Map();
        let duplicates = 0;
        for (const r of data) {
          const key = JSON.stringify(r);
          seen.set(key, (seen.get(key) ?? 0) + 1);
        }
        for (const n of seen.values()) if (n > 1) duplicates += n - 1;
        const columns = header.map((name, c) => {
          const values = data.map((r) => r[c] ?? "");
          const filled = values.filter((v) => v.trim() !== "");
          const kinds = new Map();
          for (const v of filled) kinds.set(kindOf(v), (kinds.get(kindOf(v)) ?? 0) + 1);
          const ranked = [...kinds.entries()].sort((a, b) => b[1] - a[1]);
          let type = ranked[0]?.[0] ?? "empty";
          if (kinds.size > 1)
            type = kinds.has("text")
              ? "text"
              : kinds.has("decimal") ||
                  (kinds.has("integer") && kinds.size === 2 && kinds.has("decimal"))
                ? "decimal"
                : "mixed";
          const counts = new Map();
          for (const v of filled) counts.set(v, (counts.get(v) ?? 0) + 1);
          const col = {
            name,
            type,
            filled: filled.length,
            blank: values.length - filled.length,
            unique: counts.size,
            topValues: [...counts.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([value, count]) => ({ value: value.slice(0, 40), count })),
          };
          if (type === "integer" || type === "decimal") {
            const nums = filled.map((v) => Number(v.replace(/,/g, ""))).filter(Number.isFinite);
            if (nums.length) {
              const sum = nums.reduce((s, n) => s + n, 0);
              col.min = Math.min(...nums);
              col.max = Math.max(...nums);
              col.mean = Math.round((sum / nums.length) * 1000) / 1000;
            }
          }
          const padded = filled.filter((v) => v !== v.trim()).length;
          if (padded) col.paddedWithSpaces = padded;
          if (kinds.size > 1) col.mixedKinds = ranked.map(([k, n]) => `${k}: ${n}`);
          return col;
        });
        const issues = [];
        if (bad.length)
          issues.push(
            `${bad.length} row(s) have a different number of fields than the header (${width}).`,
          );
        if (unclosedQuote) issues.push("A quoted field is never closed.");
        if (duplicates) issues.push(`${duplicates} duplicate row(s).`);
        const empties = columns.filter((c) => c.type === "empty").map((c) => c.name);
        if (empties.length) issues.push(`Empty column(s): ${empties.join(", ")}.`);
        const mixed = columns.filter((c) => c.mixedKinds).map((c) => c.name);
        if (mixed.length) issues.push(`Mixed value kinds in: ${mixed.join(", ")}.`);
        const dupHeader = header.filter((h, i) => header.indexOf(h) !== i);
        if (dupHeader.length)
          issues.push(`Repeated header name(s): ${[...new Set(dupHeader)].join(", ")}.`);
        return {
          ok: true,
          delimiter: delimiter === "\t" ? "tab" : delimiter,
          rows: data.length,
          columnCount: width,
          columns,
          damagedRows: bad.slice(0, 10),
          duplicateRows: duplicates,
          issues,
          answer: `${data.length} row(s) x ${width} column(s), delimiter ${delimiter === "\t" ? "tab" : `"${delimiter}"`}. ${issues.length ? issues.join(" ") : "No problems found."}`,
        };
      }

      return run;
    })(),
  },
  {
    id: "dat-table-convert",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dat-table-convert
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Converts a table between CSV (or TSV), a Markdown table and JSON (a list of objects).

      function parseCsv(text, delimiter) {
        const rows = [];
        let row = [];
        let cell = "";
        let quoted = false;
        for (let i = 0; i < text.length; i += 1) {
          const ch = text[i];
          if (quoted) {
            if (ch === '"' && text[i + 1] === '"') {
              cell += '"';
              i += 1;
            } else if (ch === '"') quoted = false;
            else cell += ch;
          } else if (ch === '"' && cell === "") quoted = true;
          else if (ch === delimiter) {
            row.push(cell);
            cell = "";
          } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i += 1;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = "";
          } else cell += ch;
        }
        if (cell !== "" || row.length) {
          row.push(cell);
          rows.push(row);
        }
        return rows.filter((r) => !(r.length === 1 && r[0] === ""));
      }

      const csvCell = (v, d) => {
        const s =
          v === null || v === undefined
            ? ""
            : typeof v === "object"
              ? JSON.stringify(v)
              : String(v);
        return s.includes('"') || s.includes("\n") || s.includes(d)
          ? `"${s.replace(/"/g, '""')}"`
          : s;
      };

      function fromMarkdown(text) {
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("|"));
        const cells = (l) =>
          l
            .replace(/^\||\|$/g, "")
            .split(/(?<!\\)\|/)
            .map((c) => c.trim().replace(/\\\|/g, "|"));
        const rows = lines.map(cells).filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
        return rows;
      }

      function detect(text) {
        const t = text.trim();
        if (/^[[{]/.test(t)) return "json";
        if (t.split(/\r?\n/).filter((l) => l.trim().startsWith("|")).length >= 2) return "markdown";
        return t.includes("\t") ? "tsv" : "csv";
      }

      async function run(input = {}) {
        const text = String(input?.table ?? input?.text ?? input?.prompt ?? "");
        const from = String(input?.from ?? "").toLowerCase() || detect(text);
        const to =
          String(input?.to ?? "").toLowerCase() ||
          ((text.toLowerCase().match(/\bto\s+(csv|tsv|json|markdown|md)\b/) ?? [])[1] ?? "");
        const target = to === "md" ? "markdown" : to;
        if (!text.trim())
          return {
            ok: false,
            error: "Paste the table (CSV, Markdown or JSON) and say what to convert it to.",
          };
        if (!["csv", "tsv", "json", "markdown"].includes(target))
          return { ok: false, error: "Say the target format: csv, tsv, markdown or json." };
        let header;
        let body;
        try {
          if (from === "json") {
            const value = JSON.parse(text.replace(/^[^[{]*(?=[[{])/, ""));
            const list = Array.isArray(value) ? value : [value];
            if (!list.every((x) => x && typeof x === "object" && !Array.isArray(x)))
              return {
                ok: false,
                error: 'JSON must be a list of objects, for example [{"a":1},{"a":2}].',
              };
            header = [...new Set(list.flatMap((o) => Object.keys(o)))];
            body = list.map((o) => header.map((h) => o[h] ?? ""));
          } else {
            const rows =
              from === "markdown"
                ? fromMarkdown(text)
                : parseCsv(
                    text
                      .replace(/^\ufeff/, "")
                      .replace(/^[^\n]*\bto\s+(?:csv|tsv|json|markdown|md)\b[^\n]*\n/i, ""),
                    from === "tsv"
                      ? "\t"
                      : text.split(/\r?\n/)[0].split(";").length >
                          text.split(/\r?\n/)[0].split(",").length
                        ? ";"
                        : ",",
                  );
            if (rows.length < 1) return { ok: false, error: "No table found in the text." };
            header = rows[0];
            body = rows.slice(1);
          }
        } catch (error) {
          return { ok: false, error: `Could not read the ${from} table: ${error.message}` };
        }
        const numeric = (v) =>
          typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim()) && !/^0\d/.test(v.trim())
            ? Number(v)
            : v;
        let result;
        if (target === "json")
          result = JSON.stringify(
            body.map((r) => Object.fromEntries(header.map((h, i) => [h, numeric(r[i] ?? "")]))),
            null,
            2,
          );
        else if (target === "markdown") {
          const esc = (v) =>
            String(v ?? "")
              .replace(/\|/g, "\\|")
              .replace(/\r?\n/g, " ");
          const widths = header.map((h, i) =>
            Math.max(3, esc(h).length, ...body.map((r) => esc(r[i]).length)),
          );
          const line = (r) => `| ${widths.map((w, i) => esc(r[i]).padEnd(w)).join(" | ")} |`;
          result = [
            line(header),
            `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
            ...body.map(line),
          ].join("\n");
        } else {
          const d = target === "tsv" ? "\t" : ",";
          result = [header, ...body].map((r) => r.map((c) => csvCell(c, d)).join(d)).join("\n");
        }
        return {
          ok: true,
          from,
          to: target,
          rows: body.length,
          columns: header.length,
          result,
          answer: `Converted ${body.length} row(s) x ${header.length} column(s) from ${from} to ${target}.`,
        };
      }

      return run;
    })(),
  },
  {
    id: "dat-stats",
    gate: /stat|mean|average|median|mode|std|deviation|variance|outlier|quartile|sum of|total of|range|\bmin|\bmax/,
    run: (() => {
      // FRIDAY · skill: dat-stats
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Descriptive statistics for a list of numbers: count, sum, mean, median, mode, spread, quartiles and outliers.

      const r4 = (n) => Math.round(n * 10000) / 10000;

      function numbersFrom(text) {
        const out = [];
        for (const piece of text.split(/[\s;]+/)) {
          if (!piece) continue;
          if (/^-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?$/.test(piece)) {
            out.push(Number(piece.replace(/,/g, "")));
            continue;
          }
          for (const part of piece.split(",")) {
            const m = /^[^\d-]*(-?\d+(?:\.\d+)?)[^\d]*$/.exec(part);
            if (m) out.push(Number(m[1]));
          }
        }
        return out;
      }

      function quantile(sorted, p) {
        const pos = (sorted.length - 1) * p;
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
      }

      async function run(input = {}) {
        let nums = Array.isArray(input.numbers)
          ? input.numbers.map(Number).filter(Number.isFinite)
          : null;
        if (!nums) {
          let text = String(input?.prompt ?? input?.text ?? "");
          const colon = /^([^:\n]{0,80}):([\s\S]+)$/.exec(text);
          if (
            colon &&
            /stat|mean|average|median|mode|sum|std|deviation|variance|numbers?|data/i.test(colon[1])
          )
            text = colon[2];
          nums = numbersFrom(text);
        }
        if (!nums.length)
          return { ok: false, error: "Give some numbers, e.g. stats of 12, 15, 9, 22, 18." };
        const n = nums.length;
        const sorted = [...nums].sort((a, b) => a - b);
        const sum = nums.reduce((a, b) => a + b, 0);
        const mean = sum / n;
        const ss = nums.reduce((a, b) => a + (b - mean) ** 2, 0);
        const counts = new Map();
        for (const v of nums) counts.set(v, (counts.get(v) ?? 0) + 1);
        const top = Math.max(...counts.values());
        const modes =
          top > 1
            ? [...counts.entries()]
                .filter(([, c]) => c === top)
                .map(([v]) => v)
                .sort((a, b) => a - b)
            : [];
        const q1 = quantile(sorted, 0.25);
        const q3 = quantile(sorted, 0.75);
        const fence = 1.5 * (q3 - q1);
        const outliers = sorted.filter((v) => v < q1 - fence || v > q3 + fence);
        const result = {
          ok: true,
          count: n,
          sum: r4(sum),
          mean: r4(mean),
          median: r4(quantile(sorted, 0.5)),
          modes,
          min: sorted[0],
          max: sorted[n - 1],
          range: r4(sorted[n - 1] - sorted[0]),
          q1: r4(q1),
          q3: r4(q3),
          populationStdDev: r4(Math.sqrt(ss / n)),
          sampleStdDev: n > 1 ? r4(Math.sqrt(ss / (n - 1))) : null,
          outliers,
        };
        return {
          ...result,
          answer: `n=${n}, sum ${result.sum}, mean ${result.mean}, median ${result.median}, min ${result.min}, max ${result.max}${modes.length ? `, mode ${modes.join("/")}` : ""}, std dev ${result.sampleStdDev ?? result.populationStdDev}${outliers.length ? `, outlier(s) ${outliers.join(", ")}` : ""}.`,
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
