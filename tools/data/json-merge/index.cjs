function parse(value, label) {
  if (value == null || value === "") return { ok: false, error: label + " JSON is required." };
  if (typeof value === "object") return { ok: true, value };
  try {
    return { ok: true, value: JSON.parse(String(value)) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
async function run({ base, patch } = {}) {
  const a = parse(base, "base");
  if (!a.ok) return a;
  const b = parse(patch, "patch");
  if (!b.ok) return b;
  if (!a.value || typeof a.value !== "object" || !b.value || typeof b.value !== "object") {
    return { ok: false, error: "Both values must be objects." };
  }
  return { ok: true, value: Object.assign({}, a.value, b.value) };
}
module.exports = { run };
