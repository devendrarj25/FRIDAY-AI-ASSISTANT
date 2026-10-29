async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const src = String(text).replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]*$/.test(src) || src.length % 2) {
    return { ok: false, error: "Need even-length hex." };
  }
  return { ok: true, text: Buffer.from(src, "hex").toString("utf8") };
}
module.exports = { run };
