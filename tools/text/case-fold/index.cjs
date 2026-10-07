async function run({ text, mode = "lower" } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const src = String(text);
  const kind = String(mode || "lower").toLowerCase();
  let out = src;
  if (kind === "upper") out = src.toUpperCase();
  else if (kind === "title")
    out = src.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  else out = src.toLowerCase();
  return { ok: true, text: out, mode: kind };
}
module.exports = { run };
