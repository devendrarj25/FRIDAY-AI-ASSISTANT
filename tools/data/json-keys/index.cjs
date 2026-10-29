async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "JSON text is required." };
  try {
    const value = JSON.parse(String(text));
    if (!value || typeof value !== "object") return { ok: true, keys: [] };
    return { ok: true, keys: Object.keys(value) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
