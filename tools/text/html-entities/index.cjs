const DECODE = [
  [/&amp;/g, "&"],
  [/&lt;/g, "<"],
  [/&gt;/g, ">"],
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&nbsp;/g, " "],
];
async function run({ text, mode = "decode" } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  let out = String(text);
  if (String(mode).toLowerCase() === "encode") {
    out = out
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return { ok: true, text: out, mode: "encode" };
  }
  for (const [re, value] of DECODE) out = out.replace(re, value);
  return { ok: true, text: out, mode: "decode" };
}
module.exports = { run };
