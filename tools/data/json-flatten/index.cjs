function flatten(value, prefix, out) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (!keys.length) {
      out[prefix || "(empty)"] = {};
      return out;
    }
    for (const key of keys) flatten(value[key], prefix ? prefix + "." + key : key, out);
    return out;
  }
  out[prefix || "value"] = value;
  return out;
}
async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "JSON text is required." };
  try {
    const value = JSON.parse(String(text));
    const flat = flatten(value, "", {});
    return { ok: true, keys: Object.keys(flat), values: flat };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
