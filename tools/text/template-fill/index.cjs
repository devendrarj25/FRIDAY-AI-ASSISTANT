async function run({ text, values } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  let data = values;
  if (typeof values === "string") {
    try {
      data = JSON.parse(values);
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }
  if (!data || typeof data !== "object") data = {};
  const out = String(text).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const value = data[key];
    return value == null ? "" : String(value);
  });
  return { ok: true, text: out };
}
module.exports = { run };
