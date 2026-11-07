// FRIDAY · skill: dev-text-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Test regular expressions and compare two texts. Regular expression testing and text comparison.
// It holds 2 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "dev-regex-test",
    gate: /regex|regular expression|pattern|match/,
    run: (() => {
      // FRIDAY · skill: dev-regex-test
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Actually runs a regular expression against sample text and lists every match, group and position.

      const FLAGS = /^[dgimsuvy]*$/;

      async function run(input = {}) {
        let pattern = input?.pattern ?? input?.regex;
        let flags = String(input?.flags ?? "");
        let sample = input?.sample ?? input?.input;
        const prompt = String(input?.prompt ?? "");
        if (pattern === undefined && prompt) {
          // "/\d+/g on 'abc 123'" or "regex \d+ test on abc 123"
          const slash = prompt.match(/\/((?:\\.|[^/\\\n])+)\/([dgimsuvy]*)/);
          if (slash) {
            pattern = slash[1];
            flags = flags || slash[2];
            sample =
              sample ??
              prompt
                .slice(slash.index + slash[0].length)
                .replace(/^\s*(?:on|against|in|for|with)\s+/i, "")
                .replace(/^["'`]|["'`]$/g, "");
          }
        }
        if (pattern === undefined || pattern === "")
          return {
            ok: false,
            error:
              "Give a pattern (and sample text), for example /(\\d+)-(\\d+)/g on 10-20 and 30-40.",
          };
        if (sample === undefined)
          return { ok: false, error: "Give the sample text to test the pattern against." };
        if (!FLAGS.test(flags))
          return { ok: false, error: `Unknown flag in "${flags}". Allowed: d g i m s u v y.` };
        sample = String(sample);
        if (sample.length > 200000)
          return { ok: false, error: "Sample text is too long (limit 200000 characters)." };
        let re;
        try {
          re = new RegExp(String(pattern), flags.includes("g") ? flags : `${flags}g`);
        } catch (error) {
          return { ok: false, error: `Invalid pattern: ${error.message}` };
        }
        const matches = [];
        const started = Date.now();
        let m;
        while ((m = re.exec(sample)) !== null) {
          matches.push({
            match: m[0],
            index: m.index,
            end: m.index + m[0].length,
            groups: m.slice(1),
            named: m.groups ? { ...m.groups } : undefined,
          });
          if (m[0] === "") re.lastIndex += 1;
          if (matches.length >= 500) break;
          if (Date.now() - started > 1500)
            return {
              ok: false,
              error: "The pattern took too long on this text (possible catastrophic backtracking).",
              matchesSoFar: matches.length,
            };
        }
        const global = flags.includes("g");
        const shown = global ? matches : matches.slice(0, 1);
        return {
          ok: true,
          pattern: String(pattern),
          flags: flags || "(none)",
          matched: shown.length > 0,
          count: shown.length,
          answer: shown.length
            ? `${shown.length} match(es): ${shown
                .slice(0, 5)
                .map((x) => JSON.stringify(x.match))
                .join(", ")}`
            : "No match.",
          matches: shown,
          note: global ? undefined : "No g flag: only the first match is shown, as in JavaScript.",
          engine:
            "JavaScript (ECMAScript) regular expressions; other languages differ in lookbehind, named groups and flags.",
        };
      }

      return run;
    })(),
  },
  {
    id: "dev-text-diff",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dev-text-diff
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Line-by-line comparison of two texts: what was added, removed or kept, as a unified-style diff.

      function lcs(a, b) {
        const n = a.length;
        const m = b.length;
        const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i -= 1) {
          for (let j = m - 1; j >= 0; j -= 1) {
            table[i][j] =
              a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
          }
        }
        return table;
      }

      async function run(input = {}) {
        let before = input?.before ?? input?.a ?? input?.old;
        let after = input?.after ?? input?.b ?? input?.new;
        if (before === undefined || after === undefined) {
          const parts = String(input?.text ?? input?.prompt ?? "").split(
            /^\s*(?:-{3,}|={3,}|\+{3,})\s*$/m,
          );
          if (parts.length === 2)
            [before, after] = parts.map((part) => part.replace(/^\r?\n|\r?\n$/g, ""));
        }
        if (before === undefined || after === undefined) {
          return {
            ok: false,
            error:
              "Give two texts as before and after, or one text with a line of --- between them.",
          };
        }
        const ignoreSpace = Boolean(input?.ignoreWhitespace);
        const norm = (s) => (ignoreSpace ? s.replace(/\s+/g, " ").trim() : s);
        const a = String(before).replace(/\r\n/g, "\n").split("\n");
        const b = String(after).replace(/\r\n/g, "\n").split("\n");
        if (a.length * b.length > 4_000_000)
          return {
            ok: false,
            error: "The texts are too long for a line diff here (over about 2000 lines each).",
          };
        const table = lcs(a.map(norm), b.map(norm));
        const ops = [];
        let i = 0;
        let j = 0;
        while (i < a.length && j < b.length) {
          if (norm(a[i]) === norm(b[j])) {
            ops.push([" ", b[j], i + 1, j + 1]);
            i += 1;
            j += 1;
          } else if (table[i + 1][j] >= table[i][j + 1]) {
            ops.push(["-", a[i], i + 1, null]);
            i += 1;
          } else {
            ops.push(["+", b[j], null, j + 1]);
            j += 1;
          }
        }
        while (i < a.length) ops.push(["-", a[i], (i += 1), null]);
        while (j < b.length) ops.push(["+", b[j], null, (j += 1)]);
        const added = ops.filter((o) => o[0] === "+").length;
        const removed = ops.filter((o) => o[0] === "-").length;
        const same = ops.length - added - removed;
        const context = Math.max(0, Number(input?.context ?? 2));
        const keep = new Set();
        ops.forEach((o, k) => {
          if (o[0] !== " ") for (let d = -context; d <= context; d += 1) keep.add(k + d);
        });
        const lines = [];
        let skipped = false;
        ops.forEach((o, k) => {
          if (!keep.has(k)) {
            skipped = true;
            return;
          }
          if (skipped && lines.length) lines.push("…");
          skipped = false;
          lines.push(`${o[0]} ${o[1]}`);
        });
        return {
          ok: true,
          identical: added === 0 && removed === 0,
          added,
          removed,
          unchanged: same,
          similarity: ops.length ? Math.round((same / Math.max(a.length, b.length)) * 100) : 100,
          answer:
            added === 0 && removed === 0
              ? "The two texts are identical."
              : `${added} line(s) added, ${removed} removed, ${same} unchanged.`,
          diff: lines.join("\n"),
          note: ignoreSpace ? "Whitespace differences were ignored." : undefined,
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
