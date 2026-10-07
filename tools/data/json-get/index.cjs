async function run({ text, path: dotted } = {}) {
  if (text == null || text === "") return { ok: false, error: "JSON text is required." };
  if (!dotted) return { ok: false, error: "A dotted path is required." };
  try {
    let value = JSON.parse(String(text));
    for (const key of String(dotted).split(".").filter(Boolean)) {
      if (value == null) return { ok: true, found: false, value: null };
      value = value[key];
    }
    return { ok: true, found: value !== undefined, value: value === undefined ? null : value };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
