async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const fence = String.fromCharCode(96, 96, 96);
  const tick = String.fromCharCode(96);
  let plain = String(text);
  const fenceRe = new RegExp(fence + "[\\s\\S]*?" + fence, "g");
  plain = plain.replace(fenceRe, " ");
  plain = plain.replace(new RegExp(tick + "[^" + tick + "]*" + tick, "g"), (m) => m.slice(1, -1));
  plain = plain
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[\s>*-]+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { ok: true, text: plain };
}
module.exports = { run };
