async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  try {
    return { ok: true, text: decodeURIComponent(String(text)) };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
