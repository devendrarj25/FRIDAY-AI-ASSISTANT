async function run({ text } = {}) {
  if (!text) return { ok: false, error: "Base64 text is required." };
  try {
    const buf = Buffer.from(String(text), "base64");
    return { ok: true, text: buf.toString("utf8"), bytes: buf.length };
  } catch (error) {
    return { ok: false, error: String(error.message || error) };
  }
}
module.exports = { run };
