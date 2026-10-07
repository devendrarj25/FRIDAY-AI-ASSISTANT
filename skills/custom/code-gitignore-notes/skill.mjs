// FRIDAY · skill: code-gitignore-notes
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
  const rules = rows({ text: input.text }).filter((l) => l && !l.startsWith("#"));
  const files = rows({ text: input.files || "" });
  if (!files.length) return { ok: false, error: "Pass files as a newline list." };
  const ignored = [];
  const tracked = [];
  for (const file of files) {
    const hit = rules.some((rule) => {
      const plain = rule.replace(/\/$/, "");
      if (plain.includes("*")) {
        const re = new RegExp(
          "^" +
            plain
              .split("*")
              .map((s) => s.replace(/[.*+?^$\{\}()|\[\]\\]/g, "\\$&"))
              .join(".*") +
            "$",
        );
        return re.test(file) || file.endsWith(plain.replace("*", ""));
      }
      return file === plain || file.startsWith(plain + "/") || file.endsWith("/" + plain);
    });
    (hit ? ignored : tracked).push(file);
  }
  return { ok: true, ignored, stillVisible: tracked };
}

export default run;
