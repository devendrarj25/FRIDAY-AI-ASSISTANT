async function run({ text, locale = "en-IN" } = {}) {
  const ms = text == null || text === "" ? Date.now() : Date.parse(String(text)) || Number(text);
  if (!Number.isFinite(ms)) return { ok: false, error: "Need a timestamp or ISO date." };
  const date = new Date(ms);
  return {
    ok: true,
    ms,
    text: new Intl.DateTimeFormat(String(locale || "en-IN"), {
      dateStyle: "full",
      timeStyle: "long",
    }).format(date),
  };
}
module.exports = { run };
