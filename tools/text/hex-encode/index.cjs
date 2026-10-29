async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  return { ok: true, text: Buffer.from(String(text), "utf8").toString("hex") };
}
module.exports = { run };
