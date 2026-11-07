// FRIDAY · skill: dev-regex-test
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// Actually runs a regular expression against sample text and lists every match, group and position.

const FLAGS = /^[dgimsuvy]*$/;

export async function run(input = {}) {
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
      error: "Give a pattern (and sample text), for example /(\\d+)-(\\d+)/g on 10-20 and 30-40.",
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

export default run;
