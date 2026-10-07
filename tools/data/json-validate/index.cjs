async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "JSON text is required." };
  try {
    const value = JSON.parse(String(text));
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    return { ok: true, valid: true, type };
  } catch (error) {
    return { ok: true, valid: false, error: String(error.message || error) };
  }
}
module.exports = { run };
