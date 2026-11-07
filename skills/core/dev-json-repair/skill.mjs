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

export async function run(input = {}) {
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

export default run;
