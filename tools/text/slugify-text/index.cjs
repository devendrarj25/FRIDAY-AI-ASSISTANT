async function run({ text } = {}) {
  if (text == null || text === "") return { ok: false, error: "Text is required." };
  const slug = String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { ok: true, slug };
}
module.exports = { run };
