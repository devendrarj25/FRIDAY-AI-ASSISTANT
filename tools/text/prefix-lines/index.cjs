async function run({ text, prefix = "> " } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const mark = String(prefix);
  const out = String(text)
    .split(/\r?\n/)
    .map((line) => mark + line)
    .join("\n");
  return { ok: true, text: out };
}
module.exports = { run };
