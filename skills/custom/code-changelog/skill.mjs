// FRIDAY · skill: code-changelog
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
  const groups = { Added: [], Changed: [], Fixed: [], Security: [], Notes: [] };
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    if (/cve|xss|inject|secret|auth/.test(lower)) groups.Security.push(line);
    else if (/fix|bug|crash/.test(lower)) groups.Fixed.push(line);
    else if (/add|new|introduce/.test(lower)) groups.Added.push(line);
    else if (/change|update|rename|move/.test(lower)) groups.Changed.push(line);
    else groups.Notes.push(line);
  }
  const version = input.version || "unreleased";
  const markdown = [
    `## ${version}`,
    ...Object.entries(groups)
      .filter(([, v]) => v.length)
      .flatMap(([k, v]) => [`### ${k}`, ...v.map((l) => `- ${l.replace(/^[-*]\s*/, "")}`)]),
  ].join("\n");
  return { ok: true, version, groups, markdown };
}

export default run;
