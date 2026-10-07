async function run({ text, width = 80 } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const col = Math.min(200, Math.max(20, Number(width) || 80));
  const lines = [];
  for (const para of String(text).split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (next.length > col && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  return { ok: true, text: lines.join("\n"), width: col };
}
module.exports = { run };
