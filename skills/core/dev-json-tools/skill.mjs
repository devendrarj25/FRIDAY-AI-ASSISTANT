// FRIDAY · skill: dev-json-tools
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Repair broken JSON and read values by path. Repairs damaged JSON and reads or describes JSON documents.
// It holds 2 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "dev-json-repair",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dev-json-repair
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Repairs almost-JSON (the kind a model or a person writes) and returns valid, formatted JSON.

      /** Walk the text once, outside strings only, so quotes and slashes inside a string are never touched. */
      function repair(source) {
        const fixes = new Set();
        let text = source.replace(/^\ufeff/, "");
        const fence = text.match(/```(?:json|jsonc|json5)?\s*([\s\S]*?)```/i);
        if (fence) {
          text = fence[1];
          fixes.add("removed a code fence");
        }
        text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
        const out = [];
        const stack = [];
        let i = 0;
        while (i < text.length) {
          const ch = text[i];
          if (ch === '"' || ch === "'") {
            let j = i + 1;
            let body = "";
            while (j < text.length && text[j] !== ch) {
              if (text[j] === "\\" && j + 1 < text.length) {
                body += text[j] + text[j + 1];
                j += 2;
                continue;
              }
              if (text[j] === "\n") {
                body += "\\n";
                fixes.add("escaped a raw line break inside a string");
                j += 1;
                continue;
              }
              body += text[j];
              j += 1;
            }
            if (ch === "'") {
              fixes.add("changed single quotes to double quotes");
              body = body.replace(/\\'/g, "'").replace(/"/g, '\\"');
            }
            out.push(`"${body}"`);
            i = j + 1;
            continue;
          }
          if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i += 1;
            fixes.add("removed // comments");
            continue;
          }
          if (ch === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 2;
            fixes.add("removed /* */ comments");
            continue;
          }
          if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
          if (ch === "}" || ch === "]") {
            // A trailing comma before a closer is dropped.
            for (let k = out.length - 1; k >= 0; k -= 1) {
              if (/^\s*$/.test(out[k])) continue;
              if (out[k] === ",") {
                out.splice(k, 1);
                fixes.add("removed a trailing comma");
              }
              break;
            }
            if (stack[stack.length - 1] === ch) stack.pop();
          }
          if (/[A-Za-z_$]/.test(ch)) {
            let j = i;
            while (j < text.length && /[\w$.-]/.test(text[j])) j += 1;
            const word = text.slice(i, j);
            const rest = text.slice(j).match(/^\s*:/);
            const map = {
              True: "true",
              False: "false",
              None: "null",
              undefined: "null",
              NaN: "null",
              Infinity: "null",
              "-Infinity": "null",
            };
            if (rest && !["true", "false", "null"].includes(word)) {
              out.push(`"${word}"`);
              fixes.add("quoted bare keys");
            } else if (word in map) {
              out.push(map[word]);
              fixes.add("replaced Python or JavaScript literals (True, None, NaN, undefined)");
            } else {
              out.push(word);
            }
            i = j;
            continue;
          }
          out.push(ch);
          i += 1;
        }
        let result = out.join("");
        if (stack.length) {
          result += stack.reverse().join("");
          fixes.add(`closed ${stack.length} open bracket(s)`);
        }
        return { result: result.trim(), fixes: [...fixes] };
      }

      async function run(input = {}) {
        const source = String(input?.json ?? input?.text ?? input?.prompt ?? "");
        if (!source.trim()) return { ok: false, error: "Paste the JSON to check or repair." };
        const indent = Math.min(8, Math.max(0, Number(input?.indent ?? 2)));
        try {
          const value = JSON.parse(source);
          return {
            ok: true,
            valid: true,
            repaired: false,
            answer: "Already valid JSON.",
            formatted: JSON.stringify(value, null, indent),
            fixes: [],
          };
        } catch {
          /* fall through to repair */
        }
        const { result, fixes } = repair(source);
        try {
          const value = JSON.parse(result);
          return {
            ok: true,
            valid: true,
            repaired: true,
            answer: `Repaired: ${fixes.join("; ") || "normalised"}.`,
            formatted: JSON.stringify(value, null, indent),
            fixes,
          };
        } catch (error) {
          return {
            ok: false,
            valid: false,
            error: `Could not repair it: ${error.message}`,
            attempted: result.slice(0, 600),
            fixes,
          };
        }
      }

      return run;
    })(),
  },
  {
    id: "dev-json-query",
    gate: null,
    run: (() => {
      // FRIDAY · skill: dev-json-query
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Read a value out of JSON by path (a.b[0].c), or describe the shape of a JSON document.

      function findJson(s) {
        for (let i = 0; i < s.length; i++) {
          const open = s[i];
          if (open !== "{" && open !== "[") continue;
          if (i > 0 && /[A-Za-z0-9_.\]]/.test(s[i - 1])) continue; // the [1] in items[1] is a path, not a document
          const close = open === "{" ? "}" : "]";
          for (let j = s.lastIndexOf(close); j > i; j = s.lastIndexOf(close, j - 1)) {
            try {
              return { value: JSON.parse(s.slice(i, j + 1)), start: i, end: j + 1 };
            } catch {
              // try a shorter slice
            }
          }
        }
        return null;
      }

      function steps(path) {
        const out = [];
        const re = /\[(\d+)\]|\[\s*["']([^"']+)["']\s*\]|([^.[\]\s]+)/g;
        let m;
        while ((m = re.exec(path.replace(/^\$\.?/, "").replace(/^\./, "")))) {
          out.push(m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3]));
        }
        return out;
      }

      const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

      function shape(v) {
        const t = typeOf(v);
        if (t === "array")
          return { type: t, length: v.length, first: v.length ? typeOf(v[0]) : null };
        if (t === "object") {
          const keys = Object.keys(v);
          return {
            type: t,
            keys: keys.slice(0, 40).map((k) => `${k}: ${typeOf(v[k])}`),
            keyCount: keys.length,
          };
        }
        return { type: t };
      }

      async function run(input = {}) {
        const prompt = String(input?.prompt ?? input?.text ?? "");
        let doc = input.json;
        let rest = prompt;
        if (typeof doc === "string") {
          try {
            doc = JSON.parse(doc);
          } catch {
            return { ok: false, error: "That is not valid JSON." };
          }
        }
        if (doc === undefined) {
          const found = findJson(prompt);
          if (!found) return { ok: false, error: "No JSON found in the text." };
          doc = found.value;
          rest = prompt.slice(0, found.start) + " " + prompt.slice(found.end);
        }
        let path = input.path != null ? String(input.path) : null;
        if (path === null) {
          const m =
            /(?:get|query|path|extract|find|read|value of)\s+(?:the\s+)?(?:key\s+)?([^\s,]+)/i.exec(
              rest,
            );
          if (m && !/^(from|in|of|the)$/i.test(m[1])) path = m[1];
        }
        if (!path) return { ok: true, ...shape(doc), answer: `JSON ${JSON.stringify(shape(doc))}` };

        let cur = doc;
        const walked = [];
        for (const step of steps(path)) {
          walked.push(String(step));
          const ok =
            cur !== null &&
            typeof cur === "object" &&
            Object.prototype.hasOwnProperty.call(cur, step);
          if (!ok) {
            const have =
              cur !== null && typeof cur === "object" ? Object.keys(cur).slice(0, 20) : [];
            return {
              ok: false,
              error: `Nothing at "${walked.join(".")}"${have.length ? `; available here: ${have.join(", ")}` : ""}.`,
            };
          }
          cur = cur[step];
        }
        return {
          ok: true,
          path,
          type: typeOf(cur),
          value: cur,
          answer: `${path} = ${JSON.stringify(cur)}`,
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
