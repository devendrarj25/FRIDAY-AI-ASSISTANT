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
  if (t === "array") return { type: t, length: v.length, first: v.length ? typeOf(v[0]) : null };
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

export async function run(input = {}) {
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
      /(?:get|query|path|extract|find|read|value of)\s+(?:the\s+)?(?:key\s+)?([^\s,]+)/i.exec(rest);
    if (m && !/^(from|in|of|the)$/i.test(m[1])) path = m[1];
  }
  if (!path) return { ok: true, ...shape(doc), answer: `JSON ${JSON.stringify(shape(doc))}` };

  let cur = doc;
  const walked = [];
  for (const step of steps(path)) {
    walked.push(String(step));
    const ok =
      cur !== null && typeof cur === "object" && Object.prototype.hasOwnProperty.call(cur, step);
    if (!ok) {
      const have = cur !== null && typeof cur === "object" ? Object.keys(cur).slice(0, 20) : [];
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

export default run;
