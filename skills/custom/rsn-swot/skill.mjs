// FRIDAY · skill: rsn-swot
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
  const swot = { strengths: [], weaknesses: [], opportunities: [], threats: [] };
  let current = "strengths";
  for (const line of rows(input)) {
    const lower = line.toLowerCase();
    if (/^strength/.test(lower)) current = "strengths";
    else if (/^weak/.test(lower)) current = "weaknesses";
    else if (/^opport/.test(lower)) current = "opportunities";
    else if (/^threat/.test(lower)) current = "threats";
    else if (/\brisk\b|competitor|downside/.test(lower)) swot.threats.push(line);
    else if (/\basset\b|advantage|good at/.test(lower)) swot.strengths.push(line);
    else swot[current].push(line.replace(/^[-*]\s*/, ""));
  }
  if (!Object.values(swot).some((a) => a.length)) return { ok: false, error: "Paste SWOT notes." };
  return { ok: true, ...swot };
}

export default run;
