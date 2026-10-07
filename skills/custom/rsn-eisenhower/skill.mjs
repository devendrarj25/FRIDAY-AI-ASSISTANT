// FRIDAY · skill: rsn-eisenhower
// Runs inside the sandbox harness, which calls run(input).
// Deterministic, offline, no network.

function num(input, key, fallback = 0) {
  const n = Number(input?.[key]);
  return Number.isFinite(n) ? n : fallback;
}
function text(input) {
  return String(input?.text ?? input?.prompt ?? input?.code ?? "");
}
function rows(input) {
  return text(input)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function numbers(input, key) {
  const raw = input?.[key] ?? input?.text ?? "";
  return String(raw)
    .split(/[,\s]+/)
    .map(Number)
    .filter((v) => Number.isFinite(v));
}
export async function run(input = {}) {
  const doNow = [];
  const schedule = [];
  const delegate = [];
  const drop = [];
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    const urgent = /\bu\+|urgent|today|asap/.test(lower);
    const important = /\bi\+|important|goal|critical/.test(lower);
    if (/delegate|hand off|ask /.test(lower)) delegate.push(line);
    else if (
      /drop|skip|ignore/.test(lower) ||
      (!urgent && !important && /later|someday/.test(lower))
    )
      drop.push(line);
    else if (urgent && important) doNow.push(line);
    else if (important) schedule.push(line);
    else if (urgent) delegate.push(line);
    else schedule.push(line);
  }
  if (![...doNow, ...schedule, ...delegate, ...drop].length)
    return { ok: false, error: "Paste a task list." };
  return { ok: true, doNow, schedule, delegate, drop };
}

export default run;
