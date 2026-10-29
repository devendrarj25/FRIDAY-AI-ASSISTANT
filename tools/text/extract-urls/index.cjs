async function run({ text } = {}) {
  if (text == null) return { ok: false, error: "Text is required." };
  const found = String(text).match(/https?:\/\/[^\s<>"'\]]+/gi) || [];
  const unique = [...new Set(found.map((item) => item.replace(/[.,);]+$/, "")))];
  return { ok: true, count: unique.length, urls: unique.slice(0, 200) };
}
module.exports = { run };
